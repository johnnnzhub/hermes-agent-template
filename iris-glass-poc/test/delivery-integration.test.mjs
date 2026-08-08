// Entrega ponta a ponta contra o mock, por socket de verdade.
//
// Os testes unitarios provam a maquina; este prova o que o John relatou: o servidor
// pendura, o HUD fica em PENSANDO e a gravacao some. Aqui o "pendura" e real — o mock
// aceita o POST e nunca responde — e o criterio e que o rascunho sobreviva.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MAX_POSTS, RETRY_DELAYS, reduce, startSend } from '../src/sendMachine.ts'

const MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'mock-hermes-api.mjs')
// Curto de proposito: o valor real (45 s) esta em glassApi.ts; aqui o que importa e o
// comportamento depois do estouro, nao o numero.
const TIMEOUT_MS = 300

async function startMock(failMode, port) {
  const child = spawn(process.execPath, [MOCK], {
    env: { ...process.env, HERMES_API_PORT: String(port), HERMES_MOCK_FAIL: failMode, GLASS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await once(child.stdout, 'data')
  return child
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readSession(port) {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/glass/hermes/session`, {}, 2_000)
  return response.json()
}

async function postTurn(port, body) {
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/glass/hermes/turn`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      TIMEOUT_MS,
    )
    if (!response.ok) return { kind: 'http', status: response.status }
    const json = await response.json()
    return { kind: 'accepted', transcript: json.transcript }
  } catch {
    return { kind: 'network' }
  }
}

async function probe(port) {
  try {
    const snapshot = await readSession(port)
    return { kind: 'probe', state: snapshot.state, revision: snapshot.revision }
  } catch {
    return { kind: 'probe-failed' }
  }
}

/** Roda a entrega inteira sem dormir de verdade: o degrau da escada vira um `timer`. */
async function deliver(port, draft) {
  let state = startSend(draft.expectedRevision)
  const waits = []
  for (let guard = 0; guard < 32; guard++) {
    if (state.phase === 'post') state = reduce(state, await postTurn(port, draft))
    else if (state.phase === 'probe') state = reduce(state, await probe(port))
    else if (state.phase === 'wait') {
      waits.push(state.waitMs)
      state = reduce(state, { kind: 'timer' })
    } else break
  }
  return { state, waits }
}

async function scenario(failMode, port, run) {
  const child = await startMock(failMode, port)
  try {
    return await run()
  } finally {
    child.kill()
    await once(child, 'exit')
  }
}

function draftFor(revision) {
  return {
    pcmB64: 'AAAAAAAA',
    sampleRate: 16_000,
    channels: 1,
    bitDepth: 16,
    clientMsgId: 'teste-integracao-1',
    expectedRevision: revision,
  }
}

test('caminho feliz: o 202 encerra a entrega e libera o rascunho', async () => {
  const port = 8791
  await scenario('none', port, async () => {
    const before = await readSession(port)
    const { state, waits } = await deliver(port, draftFor(before.revision))
    assert.equal(state.phase, 'thinking')
    assert.equal(state.clearDraft, true)
    assert.equal(state.transcript, 'Mensagem de voz simulada')
    assert.deepEqual(waits, [])
    assert.equal(state.attempts, 1)
  })
})

test('servidor que pendura esgota a escada e devolve o rascunho intacto', async () => {
  const port = 8792
  await scenario('hang', port, async () => {
    const before = await readSession(port)
    const { state, waits } = await deliver(port, draftFor(before.revision))

    assert.equal(state.phase, 'retry')
    assert.equal(state.reason, 'exhausted')
    // O ponto do bug: a fala continua recuperavel.
    assert.equal(state.clearDraft, false)
    assert.equal(state.attempts, MAX_POSTS)
    assert.deepEqual(waits, RETRY_DELAYS)

    // E a sessao no servidor nao mexeu — nada entrou, entao reenviar e legitimo.
    const after = await readSession(port)
    assert.equal(after.revision, before.revision)
    assert.equal(after.turns.length, before.turns.length)
  })
})

test('rede intermitente se resolve sozinha na segunda tentativa', async () => {
  const port = 8793
  await scenario('flaky', port, async () => {
    const before = await readSession(port)
    const { state, waits } = await deliver(port, draftFor(before.revision))

    assert.equal(state.phase, 'thinking')
    assert.equal(state.clearDraft, true)
    assert.equal(state.attempts, 2)
    assert.deepEqual(waits, [RETRY_DELAYS[0]])

    const after = await readSession(port)
    assert.notEqual(after.revision, before.revision)
    assert.equal(after.turns.length, before.turns.length + 1)
  })
})

test('revision velha para a entrega em vez de duplicar o turno', async () => {
  const port = 8794
  await scenario('none', port, async () => {
    const { state } = await deliver(port, draftFor('f'.repeat(16)))
    assert.equal(state.phase, 'retry')
    assert.equal(state.reason, 'conflict')
    assert.equal(state.needsRefresh, true)
    assert.equal(state.clearDraft, false)
  })
})

test('5xx passa pelo probe, percorre a escada e nao vira descarte', async () => {
  const port = 8795
  await scenario('503', port, async () => {
    const before = await readSession(port)
    const { state, waits } = await deliver(port, draftFor(before.revision))
    // Erro do servidor e reciclavel: gasta a escada inteira antes de parar, e para com
    // a fala guardada — nunca descarta.
    assert.equal(state.phase, 'retry')
    assert.equal(state.reason, 'exhausted')
    assert.equal(state.clearDraft, false)
    assert.deepEqual(waits, RETRY_DELAYS)
  })
})

test('422 e o unico caminho que descarta a gravacao', async () => {
  const port = 8796
  await scenario('422', port, async () => {
    const before = await readSession(port)
    const { state } = await deliver(port, draftFor(before.revision))
    assert.equal(state.phase, 'discarded')
    assert.equal(state.reason, 'no-speech')
    assert.equal(state.clearDraft, true)
  })
})
