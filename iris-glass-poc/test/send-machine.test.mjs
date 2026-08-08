import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_POSTS,
  RETRY_DELAYS,
  parkedDraft,
  reasonHeadline,
  reduce,
  settlePending,
  startSend,
} from '../src/sendMachine.ts'

const ANCHOR = 'a'.repeat(16)

const start = () => startSend(ANCHOR)

test('o 202 encerra a entrega e libera o rascunho', () => {
  const state = reduce(start(), { kind: 'accepted', transcript: 'bom dia' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
  assert.equal(state.transcript, 'bom dia')
  assert.equal(state.attempts, 1)
})

// O ponto central da correcao: falha de rede PERGUNTA (~200 bytes) antes de gastar
// outro upload de ~1,28 MB.
test('falha de rede vai para o probe, nunca direto para outro POST', () => {
  const state = reduce(start(), { kind: 'network' })
  assert.equal(state.phase, 'probe')
  assert.equal(state.reason, 'network')
  assert.equal(state.attempts, 1)
})

test('probe com a sessao intacta agenda o degrau seguinte da escada', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitMs, RETRY_DELAYS[0])

  state = reduce(state, { kind: 'timer' })
  assert.equal(state.phase, 'post')

  state = reduce(state, { kind: 'network' })
  state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
  assert.equal(state.waitMs, RETRY_DELAYS[1])
})

test('probe com a sessao ocupada vira PENSANDO sem apagar o rascunho', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'probe', state: 'busy', revision: ANCHOR })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, false)
})

test('probe com revision diferente tambem vira PENSANDO sem apagar o rascunho', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'probe', state: 'idle', revision: 'b'.repeat(16) })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, false)
})

test('probe que falha nao queima um POST — cai na espera', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'probe-failed' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.attempts, 1)
})

test('a escada tem fim e para com o rascunho intacto', () => {
  let state = start()
  for (let post = 0; post < MAX_POSTS; post++) {
    state = reduce(state, { kind: 'network' })
    state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'exhausted')
  assert.equal(state.clearDraft, false)
  assert.equal(state.attempts, MAX_POSTS)
})

test('o toque reabre a escada inteira e preserva o rascunho', () => {
  let state = start()
  for (let post = 0; post < MAX_POSTS; post++) {
    state = reduce(state, { kind: 'network' })
    state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  const retried = reduce(state, { kind: 'manual' })
  assert.equal(retried.phase, 'post')
  assert.equal(retried.attempts, 0)
  assert.equal(retried.clearDraft, false)
  assert.equal(retried.anchorRevision, ANCHOR)
})

test('o toque encurta a espera em vez de esperar o degrau', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
  assert.equal(state.phase, 'wait')
  assert.equal(reduce(state, { kind: 'manual' }).phase, 'post')
})

test('o toque nao faz nada durante um POST em voo', () => {
  const state = start()
  assert.equal(reduce(state, { kind: 'manual' }), state)
})

test('422 descarta: nao ha fala para recuperar', () => {
  const state = reduce(start(), { kind: 'http', status: 422 })
  assert.equal(state.phase, 'discarded')
  assert.equal(state.reason, 'no-speech')
  assert.equal(state.clearDraft, true)
})

test('413 descarta: o audio nao cabe e repeti-lo nao muda nada', () => {
  const state = reduce(start(), { kind: 'http', status: 413 })
  assert.equal(state.phase, 'discarded')
  assert.equal(state.reason, 'too-long')
})

test('409 para e exige turno novo, sem perder o rascunho', () => {
  const state = reduce(start(), { kind: 'http', status: 409 })
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'conflict')
  assert.equal(state.needsRefresh, true)
  assert.equal(state.clearDraft, false)
})

test('401 e 404 param com o rascunho guardado — retry automatico nao resolve', () => {
  for (const status of [401, 403, 404]) {
    const state = reduce(start(), { kind: 'http', status })
    assert.equal(state.phase, 'retry')
    assert.equal(state.clearDraft, false)
  }
})

test('5xx e tratado como falha reciclavel e passa pelo probe', () => {
  const state = reduce(start(), { kind: 'http', status: 502 })
  assert.equal(state.phase, 'probe')
  assert.equal(state.reason, 'server')
})

test('400 descarta: payload recusado nao melhora com repeticao', () => {
  const state = reduce(start(), { kind: 'http', status: 400 })
  assert.equal(state.phase, 'discarded')
  assert.equal(state.clearDraft, true)
})

test('estados terminais ignoram eventos atrasados', () => {
  const done = reduce(start(), { kind: 'accepted', transcript: 'oi' })
  assert.equal(reduce(done, { kind: 'network' }), done)

  const dropped = reduce(start(), { kind: 'http', status: 422 })
  assert.equal(reduce(dropped, { kind: 'timer' }), dropped)
})

// Pos-condicao do envio ambiguo: so a sessao de volta em idle conta a verdade.
test('settlePending distingue entregue, perdido e ainda em curso', () => {
  const turn = { expectedRevision: ANCHOR, turnsAtSubmit: 3 }

  assert.equal(settlePending(turn, { state: 'busy', revision: ANCHOR, turnCount: 3 }), 'pending')
  assert.equal(settlePending(turn, { state: 'awaiting', revision: ANCHOR, turnCount: 3 }), 'pending')
  assert.equal(
    settlePending(turn, { state: 'idle', revision: 'c'.repeat(16), turnCount: 3 }),
    'delivered',
  )
  assert.equal(settlePending(turn, { state: 'idle', revision: ANCHOR, turnCount: 4 }), 'delivered')
  assert.equal(settlePending(turn, { state: 'idle', revision: ANCHOR, turnCount: 3 }), 'lost')
})

test('um rascunho so guardado nao se apresenta como falha', () => {
  const state = parkedDraft(ANCHOR)
  assert.equal(state.phase, 'retry')
  assert.equal(state.attempts, 0)
  assert.equal(state.clearDraft, false)
  assert.equal(reasonHeadline(state.reason), 'RASCUNHO GUARDADO')
  assert.equal(reduce(state, { kind: 'manual' }).phase, 'post')
})

test('cada motivo tem uma manchete propria no HUD', () => {
  const reasons = [
    'none',
    'saved',
    'network',
    'auth',
    'conflict',
    'no-speech',
    'too-long',
    'server',
    'exhausted',
  ]
  const headlines = new Set(reasons.map(reasonHeadline))
  // 'none', 'network' e 'exhausted' compartilham a mesma manchete de proposito.
  assert.equal(headlines.size, reasons.length - 2)
  assert.equal(reasonHeadline('network'), 'NÃO ENVIOU')
  assert.equal(reasonHeadline('exhausted'), 'NÃO ENVIOU')
})
