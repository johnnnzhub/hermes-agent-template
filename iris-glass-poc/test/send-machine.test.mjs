import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_DELAYS,
  MAX_ASKS,
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

/** Falha de rede contra um backend sem a rota de status: cai no probe da sessao. */
function legacyAsk(state) {
  return reduce(reduce(state, { kind: 'network' }), { kind: 'status-missing' })
}

function exhaustLegacyLadder() {
  let state = start()
  for (let post = 0; post < MAX_POSTS; post++) {
    state = legacyAsk(state)
    state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  return state
}

test('o 202 encerra a entrega e libera o rascunho', () => {
  const state = reduce(start(), { kind: 'accepted', transcript: 'bom dia' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
  assert.equal(state.transcript, 'bom dia')
  assert.equal(state.attempts, 1)
})

// O ponto central da correcao: falha de rede PERGUNTA (~200 bytes) antes de gastar
// outro upload de ~1,28 MB.
test('falha de rede pergunta pelo id, nunca vai direto para outro POST', () => {
  const state = reduce(start(), { kind: 'network' })
  assert.equal(state.phase, 'ask')
  assert.equal(state.reason, 'network')
  assert.equal(state.attempts, 1)
})

test('o servidor confirmando o turno encerra a entrega sem reenviar nada', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-done', turnStatus: 202, transcript: 'bom dia' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
  assert.equal(state.transcript, 'bom dia')
  // O audio subiu uma vez so.
  assert.equal(state.attempts, 1)
})

test('o desfecho guardado pelo servidor vale como resposta do POST', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-done', turnStatus: 409, transcript: '' })
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'conflict')
  assert.equal(state.clearDraft, false)
})

test('"nunca vi este id" e o unico caso que autoriza reenviar o audio', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-unknown' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'post')
  assert.equal(state.waitMs, RETRY_DELAYS[0])
  assert.equal(reduce(state, { kind: 'timer' }).phase, 'post')
})

test('turno em voo insiste barato em vez de reenviar', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-pending' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'ask')
  assert.equal(state.waitMs, ASK_DELAYS[0])
  assert.equal(reduce(state, { kind: 'timer' }).phase, 'ask')
  assert.equal(state.attempts, 1)
})

test('insistir tem fim: o servidor tem o turno, entao vira PENSANDO com rascunho guardado', () => {
  let state = reduce(start(), { kind: 'network' })
  const waits = []
  for (let ask = 0; ask <= MAX_ASKS; ask++) {
    state = reduce(state, { kind: 'status-pending' })
    if (state.phase === 'wait') {
      waits.push(state.waitMs)
      state = reduce(state, { kind: 'timer' })
    }
  }
  assert.deepEqual(waits, ASK_DELAYS)
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, false)
  assert.equal(state.attempts, 1)
})

// Version skew: o cliente novo tem de atravessar um backend antigo sem perder a fala.
// Confundir "resposta HTTP" com "rota ausente" custou quase uma hora em 2026-08-03.
test('rota de status ausente cai no caminho antigo em vez de falhar', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-missing' })
  assert.equal(state.phase, 'probe')
  assert.equal(state.attempts, 1)
})

// A inferencia por revision e o UNICO caminho do cliente capaz de apagar uma fala que
// nunca foi entregue (outro turno muda a revision e ela e creditada a esta gravacao).
// Por isso ela e reservada ao servidor que comprovadamente nao tem a rota — uma pergunta
// que so falhou insiste, e nunca degrada para palpite.
test('pergunta que falha insiste, e so cai no palpite depois de esgotar', () => {
  let state = reduce(start(), { kind: 'network' })
  const waits = []
  for (let ask = 0; ask <= MAX_ASKS; ask++) {
    state = reduce(state, { kind: 'status-failed' })
    if (state.phase === 'wait') {
      assert.equal(state.waitNext, 'ask')
      waits.push(state.waitMs)
      state = reduce(state, { kind: 'timer' })
    }
  }
  assert.deepEqual(waits, ASK_DELAYS)
  assert.equal(state.phase, 'probe')
  // E nunca gastou outro upload no caminho.
  assert.equal(state.attempts, 1)
})

// Com a rota respondendo, a inferencia por revision NUNCA entra: um desfecho definitivo
// existe e vai aparecer. Parar com o rascunho guardado e melhor que adivinhar.
test('servidor que ja respondeu nunca degrada para inferencia', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-pending' })
  assert.equal(state.trusted, true)
  state = reduce(state, { kind: 'timer' })

  for (let failure = 0; failure <= MAX_ASKS; failure++) {
    state = reduce(state, { kind: 'status-failed' })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  assert.notEqual(state.phase, 'probe')
  assert.equal(state.phase, 'retry')
  assert.equal(state.clearDraft, false)
})

// Contadores compartilhados faziam uma resposta de um tipo consumir a escada do outro.
test('as escadas de pergunta pendente e de pergunta falha sao independentes', () => {
  let state = reduce(start(), { kind: 'network' })
  for (let round = 0; round < MAX_ASKS; round++) {
    state = reduce(state, { kind: 'status-pending' })
    assert.equal(state.phase, 'wait', 'pending nao deveria ter esgotado ainda')
    state = reduce(state, { kind: 'timer' })
  }
  // Quatro "pending" nao podem ter gasto a escada de falhas.
  state = reduce(state, { kind: 'status-failed' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitMs, ASK_DELAYS[0])
  assert.equal(state.askFailures, 1)
  assert.equal(state.asks, MAX_ASKS)
})

test('um POST novo comeca uma rodada limpa de perguntas', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-pending' })
  state = reduce(state, { kind: 'timer' })
  state = reduce(state, { kind: 'status-unknown' })
  assert.equal(state.waitNext, 'post')

  const posting = reduce(state, { kind: 'timer' })
  assert.equal(posting.phase, 'post')
  assert.equal(posting.asks, 0)
  assert.equal(posting.askFailures, 0)
})

test('a primeira falha da pergunta nao vira inferencia', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-failed' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'ask')
  assert.notEqual(state.phase, 'probe')
})

test('probe com a sessao intacta agenda o degrau seguinte da escada', () => {
  let state = legacyAsk(start())
  state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitMs, RETRY_DELAYS[0])

  state = reduce(state, { kind: 'timer' })
  assert.equal(state.phase, 'post')

  state = legacyAsk(state)
  state = reduce(state, { kind: 'probe', state: 'idle', revision: ANCHOR })
  assert.equal(state.waitMs, RETRY_DELAYS[1])
})

test('probe com a sessao ocupada vira PENSANDO sem apagar o rascunho', () => {
  let state = legacyAsk(start())
  state = reduce(state, { kind: 'probe', state: 'busy', revision: ANCHOR })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, false)
})

test('probe com revision diferente tambem vira PENSANDO sem apagar o rascunho', () => {
  let state = legacyAsk(start())
  state = reduce(state, { kind: 'probe', state: 'idle', revision: 'b'.repeat(16) })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, false)
})

test('probe que falha nao queima um POST — cai na espera', () => {
  let state = legacyAsk(start())
  state = reduce(state, { kind: 'probe-failed' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.attempts, 1)
})

test('a escada tem fim e para com o rascunho intacto', () => {
  const state = exhaustLegacyLadder()
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'exhausted')
  assert.equal(state.clearDraft, false)
  assert.equal(state.attempts, MAX_POSTS)
})

test('o toque reabre a escada inteira e preserva o rascunho', () => {
  const retried = reduce(exhaustLegacyLadder(), { kind: 'manual' })
  assert.equal(retried.phase, 'post')
  assert.equal(retried.attempts, 0)
  assert.equal(retried.asks, 0)
  assert.equal(retried.clearDraft, false)
  assert.equal(retried.anchorRevision, ANCHOR)
})

// Apressar nao pode virar reenvio: o servidor ja confirmou que tem o turno.
test('o toque durante a espera de PERGUNTA volta a perguntar, nao a subir o audio', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-pending' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'ask')

  const tapped = reduce(state, { kind: 'manual' })
  assert.equal(tapped.phase, 'ask')
  assert.equal(tapped.attempts, 1)
  assert.equal(tapped.asks, state.asks)
})

test('o toque encurta a espera em vez de esperar o degrau', () => {
  let state = legacyAsk(start())
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

test('5xx e tratado como falha reciclavel e vai perguntar pelo id', () => {
  const state = reduce(start(), { kind: 'http', status: 502 })
  assert.equal(state.phase, 'ask')
  assert.equal(state.reason, 'server')
})

// Descartar e privilegio de quem PROVA que a gravacao nao serve. O default antigo
// descartava qualquer status nao listado, entao um 408/425/429 transitorio — os que um
// reenvio resolveria — apagava a fala.
test('so 413 e 422 descartam; todo o resto para com o rascunho guardado', () => {
  for (const status of [400, 402, 405, 408, 418, 425, 429, 451]) {
    const state = reduce(start(), { kind: 'http', status })
    assert.equal(state.phase, 'retry', `status ${status} deveria parar, nao descartar`)
    assert.equal(state.clearDraft, false, `status ${status} apagou o rascunho`)
  }
  for (const status of [413, 422]) {
    assert.equal(reduce(start(), { kind: 'http', status }).phase, 'discarded')
  }
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
