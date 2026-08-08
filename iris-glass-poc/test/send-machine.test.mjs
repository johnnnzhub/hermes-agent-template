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
  stagedDraft,
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
// Insistencia esgotada NAO e evidencia de nada: nao diz que a rota sumiu nem que o turno
// entrou. Por isso a pergunta que so falha termina PARANDO, nunca em palpite.
test('pergunta que falha insiste e para, sem nunca cair no palpite', () => {
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
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'exhausted')
  assert.equal(state.clearDraft, false)
  // A porta da inferencia continua fechada: rede ruim nao vira prova de rota ausente.
  assert.equal(state.inferable, false)
  // E nunca gastou outro upload no caminho.
  assert.equal(state.attempts, 1)
})

// Reproducao exata do buraco que sobreviveu a quatro rodadas: POST cai, todas as perguntas
// falham, outro turno mexe na conversa. Antes, a maquina chegava em `thinking` com a
// inferencia liberada e a fala do John era creditada ao turno alheio e apagada.
test('rede ruim nao autoriza creditar a entrega a outro turno', () => {
  let state = reduce(start(), { kind: 'network' })
  for (let failure = 0; failure <= MAX_ASKS; failure++) {
    state = reduce(state, { kind: 'status-failed' })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  assert.notEqual(state.phase, 'probe')
  assert.notEqual(state.phase, 'thinking')
  assert.equal(state.inferable, false)
})

// Com a rota respondendo, a inferencia por revision NUNCA entra: um desfecho definitivo
// existe e vai aparecer. Parar com o rascunho guardado e melhor que adivinhar.
test('servidor que ja respondeu nunca degrada para inferencia', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-pending' })
  assert.equal(state.inferable, false)
  state = reduce(state, { kind: 'timer' })

  for (let failure = 0; failure <= MAX_ASKS; failure++) {
    state = reduce(state, { kind: 'status-failed' })
    if (state.phase === 'wait') state = reduce(state, { kind: 'timer' })
  }
  assert.notEqual(state.phase, 'probe')
  assert.equal(state.phase, 'retry')
  assert.equal(state.clearDraft, false)
})

// `inferable` e fato do servidor (404 na rota por id), nao estado da tentativa. Reabrir a
// escada com um toque nao faz o 404 desaparecer — e zerar a flag ali reabria a inferencia
// por um caminho ja fechado.
test('rota ausente continua ausente depois do toque', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-missing' })
  assert.equal(state.phase, 'probe')
  assert.equal(state.inferable, true)
  state = reduce({ ...state, phase: 'retry' }, { kind: 'manual' })
  assert.equal(state.phase, 'post')
  assert.equal(state.inferable, true)
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

// --- Confirmacao antes de enviar -------------------------------------------------------
//
// A fala vira acao no instante em que chega na Iris, e nao ha desfazer. A janela de
// confirmacao so pode existir DEPOIS do STT, porque antes dele ninguem sabe o que foi dito.

test('transcricao retida espera o toque e nao apaga o rascunho', () => {
  const state = reduce(start(), { kind: 'staged', transcript: 'quanto pesa um litro de agua' })
  assert.equal(state.phase, 'staged')
  assert.equal(state.transcript, 'quanto pesa um litro de agua')
  assert.equal(state.clearDraft, false)
  assert.equal(state.attempts, 1)
})

// Nada acontece sozinho neste estado: sem timer, sem reenvio, sem descarte. Quem decide
// e o John — um turno que se enviasse sozinho depois de um tempo nao seria confirmacao.
test('estado de confirmacao ignora tudo que nao seja o toque', () => {
  const staged = reduce(start(), { kind: 'staged', transcript: 'oi' })
  for (const event of [
    { kind: 'timer' },
    { kind: 'network' },
    { kind: 'status-failed' },
    { kind: 'probe', state: 'idle', revision: ANCHOR },
    { kind: 'http', status: 500 },
  ]) {
    assert.deepEqual(reduce(staged, event), staged, `evento ${event.kind} mexeu no estado`)
  }
})

test('o toque entrega a fala sem reenviar audio', () => {
  let state = reduce(start(), { kind: 'staged', transcript: 'oi' })
  state = reduce(state, { kind: 'manual' })
  assert.equal(state.phase, 'commit')
  // O commit nao conta como POST: o audio ja subiu uma vez.
  assert.equal(state.attempts, 1)

  state = reduce(state, { kind: 'accepted', transcript: 'oi' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
})

// Entre transcrever e tocar, a conversa pode ter andado por outro canal. O servidor recusa,
// e a fala continua guardada — recusar nao pode custar a gravacao.
test('conflito no commit para com o rascunho intacto', () => {
  let state = reduce(start(), { kind: 'staged', transcript: 'oi' })
  state = reduce(state, { kind: 'manual' })
  state = reduce(state, { kind: 'http', status: 409 })
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'conflict')
  assert.equal(state.needsRefresh, true)
  assert.equal(state.clearDraft, false)
})

// Commit que morre na rede nao vira palpite: pergunta por id, e a resposta decide. Aqui a
// fala TINHA entrado, e insistir as cegas teria mandado a mesma frase duas vezes.
test('commit perdido na rede descobre a verdade perguntando', () => {
  let state = reduce(start(), { kind: 'staged', transcript: 'oi' })
  state = reduce(state, { kind: 'manual' })
  state = reduce(state, { kind: 'network' })
  assert.equal(state.phase, 'ask')
  state = reduce(state, { kind: 'status-done', turnStatus: 202, transcript: 'oi' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
})

// E se ainda estiver retido, o 200 tem de voltar para a tela de confirmacao. Tratar 200
// como erro generico pararia com "HERMES FORA DO AR" diante de um servidor que esta apenas
// esperando a decisao do John.
test('status 200 por id devolve a tela de confirmacao', () => {
  let state = reduce(start(), { kind: 'staged', transcript: 'oi' })
  state = reduce(state, { kind: 'manual' })
  state = reduce(state, { kind: 'network' })
  state = reduce(state, { kind: 'status-done', turnStatus: 200, transcript: 'oi de novo' })
  assert.equal(state.phase, 'staged')
  assert.equal(state.transcript, 'oi de novo')
  assert.equal(state.clearDraft, false)
})

// Servidor que esqueceu o turno (restart, eviccao): o audio ainda esta no rascunho, entao
// o caminho e subir de novo — e confirmar de novo.
test('turno esquecido no commit volta para a escada de upload', () => {
  let state = reduce(start(), { kind: 'staged', transcript: 'oi' })
  state = reduce(state, { kind: 'manual' })
  state = reduce(state, { kind: 'status-unknown' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'post')
  assert.equal(state.clearDraft, false)
})

// Backend antigo ignora o pedido de confirmacao e entrega direto. O cliente nao pode ficar
// esperando um toque que nao decide mais nada.
test('servidor antigo entrega direto e nao mostra confirmacao', () => {
  const state = reduce(start(), { kind: 'accepted', transcript: 'oi' })
  assert.equal(state.phase, 'thinking')
  assert.equal(state.clearDraft, true)
})

// Rascunho ja transcrito, restaurado depois de fechar o app: o servidor provavelmente
// ainda tem o turno retido, entao o toque deve ENTREGAR, nao subir 1,28 MB de novo.
test('rascunho transcrito volta para a confirmacao, nao para o upload', () => {
  let state = stagedDraft(ANCHOR, 'quanto pesa um litro de agua')
  assert.equal(state.phase, 'staged')
  assert.equal(state.transcript, 'quanto pesa um litro de agua')
  state = reduce(state, { kind: 'manual' })
  assert.equal(state.phase, 'commit')
  assert.equal(state.attempts, 0)
})

// E se o servidor tiver esquecido o turno, o commit devolve "unknown" e a escada de upload
// assume — com zero POSTs nesta sessao, o degrau nao pode sair `undefined`.
test('turno esquecido apos restaurar cai num degrau valido da escada', () => {
  let state = reduce(stagedDraft(ANCHOR, 'oi'), { kind: 'manual' })
  state = reduce(state, { kind: 'status-unknown' })
  assert.equal(state.phase, 'wait')
  assert.equal(state.waitNext, 'post')
  assert.equal(state.waitMs, RETRY_DELAYS[0])
  assert.equal(reduce(state, { kind: 'timer' }).phase, 'post')
})

// 5xx no commit e a unica ambiguidade real do fluxo: o RPC pode ter escrito antes de
// estourar. Insistir sozinho arriscaria a Iris agir duas vezes sobre a mesma fala.
test('commit ambiguo para e exige turno novo em vez de insistir', () => {
  let state = reduce(stagedDraft(ANCHOR, 'apaga o evento de amanha'), { kind: 'manual' })
  state = reduce(state, { kind: 'http', status: 502 })
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'ambiguous')
  assert.equal(reasonHeadline(state.reason), 'NÃO SEI SE ENTROU')
  // Turno novo no reenvio: repetir o mesmo id poderia entregar a segunda vez.
  assert.equal(state.needsRefresh, true)
  assert.equal(state.clearDraft, false)
})

// Um 5xx GRAVADO pelo servidor e desfecho, nao falha de transporte. Devolver a fase 'ask'
// aqui fazia a maquina perguntar, receber o mesmo 5xx e girar sem espera nenhuma.
test('5xx guardado pelo servidor para, em vez de girar perguntando', () => {
  let state = reduce(start(), { kind: 'network' })
  state = reduce(state, { kind: 'status-done', turnStatus: 503, transcript: '' })
  assert.notEqual(state.phase, 'ask')
  assert.equal(state.phase, 'retry')
  assert.equal(state.reason, 'server')
  assert.equal(state.clearDraft, false)
})
