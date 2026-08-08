import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_TTL_MS,
  MAX_DRAFT_B64,
  clearPendingTurn,
  draftSummary,
  isFresh,
  loadPendingTurn,
  normalizePendingTurn,
  savePendingTurn,
} from '../src/pendingTurn.ts'

function fakeStorage({ failOnSet = false } = {}) {
  const map = new Map()
  return {
    map,
    removals: 0,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      if (failOnSet) throw new Error('QuotaExceededError')
      map.set(key, value)
    },
    removeItem(key) {
      this.removals++
      map.delete(key)
    },
  }
}

function draft(overrides = {}) {
  return {
    clientMsgId: 'abc123-def456',
    pcmB64: 'AAAA',
    expectedRevision: 'a'.repeat(16),
    createdAt: 1_000,
    durMs: 12_000,
    attempts: 0,
    submitted: false,
    turnsAtSubmit: 3,
    ...overrides,
  }
}

test('o rascunho sobrevive a um ciclo de escrita e leitura', () => {
  const storage = fakeStorage()
  assert.equal(savePendingTurn(draft(), storage), true)
  const loaded = loadPendingTurn(1_500, storage)
  assert.deepEqual(loaded, { ...draft(), transcript: undefined })
})

test('rascunho vencido nao volta e sai do disco', () => {
  const storage = fakeStorage()
  savePendingTurn(draft({ createdAt: 0 }), storage)
  assert.equal(loadPendingTurn(DRAFT_TTL_MS + 1, storage), null)
  assert.equal(storage.map.size, 0)
})

test('rascunho de outra versao do app e descartado em vez de adivinhado', () => {
  const storage = fakeStorage()
  storage.map.set('hermes_pending_v1', JSON.stringify({ v: '0.0.0-antiga', turn: draft() }))
  assert.equal(loadPendingTurn(1_500, storage), null)
  assert.equal(storage.map.size, 0)
})

test('JSON corrompido no disco nao derruba a leitura', () => {
  const storage = fakeStorage()
  storage.map.set('hermes_pending_v1', '{nao-e-json')
  assert.equal(loadPendingTurn(1_500, storage), null)
  assert.equal(storage.map.size, 0)
})

test('sem localStorage o modulo degrada em silencio', () => {
  assert.equal(savePendingTurn(draft(), null), false)
  assert.equal(loadPendingTurn(1_500, null), null)
  assert.doesNotThrow(() => clearPendingTurn(null))
})

// Falhar a escrita e aceitavel — a copia em memoria e a fonte. Deixar um rascunho VELHO
// no disco nao e: ele ressurgiria no proximo boot no lugar do que acabou de ser gravado.
test('cota estourada devolve false e limpa o rascunho anterior', () => {
  const storage = fakeStorage({ failOnSet: true })
  storage.map.set('hermes_pending_v1', JSON.stringify({ v: 'test', turn: draft() }))
  assert.equal(savePendingTurn(draft({ clientMsgId: 'novo-12345' }), storage), false)
  assert.equal(storage.map.size, 0)
})

test('payload acima do teto nao vai para o disco e limpa o que estava la', () => {
  const storage = fakeStorage()
  savePendingTurn(draft(), storage)
  const grande = draft({ pcmB64: 'A'.repeat(MAX_DRAFT_B64 + 1) })
  assert.equal(savePendingTurn(grande, storage), false)
  assert.equal(storage.map.size, 0)
})

test('normalize recusa shape invalido e preenche os opcionais', () => {
  assert.equal(normalizePendingTurn(null), null)
  assert.equal(normalizePendingTurn({ clientMsgId: 'x' }), null)
  assert.equal(normalizePendingTurn(draft({ pcmB64: '' })), null)
  assert.equal(normalizePendingTurn(draft({ createdAt: 'ontem' })), null)

  const normalized = normalizePendingTurn({
    clientMsgId: 'abc123-def456',
    pcmB64: 'AAAA',
    expectedRevision: 'b'.repeat(16),
    createdAt: 10,
    durMs: 900,
  })
  assert.equal(normalized.attempts, 0)
  assert.equal(normalized.submitted, false)
  assert.equal(normalized.turnsAtSubmit, 0)
  assert.equal(normalized.transcript, undefined)
})

test('isFresh usa a janela de 15 minutos', () => {
  assert.equal(isFresh(draft({ createdAt: 0 }), DRAFT_TTL_MS - 1), true)
  assert.equal(isFresh(draft({ createdAt: 0 }), DRAFT_TTL_MS), false)
})

test('o resumo do rascunho prefere o transcript e cai na duracao', () => {
  assert.equal(draftSummary(draft({ transcript: 'lembra de comprar cafe' })), 'lembra de comprar cafe')
  assert.equal(draftSummary(draft({ durMs: 12_400 })), 'rascunho de 12s de fala')
  assert.equal(draftSummary(draft({ durMs: 200 })), 'rascunho de 1s de fala')
})
