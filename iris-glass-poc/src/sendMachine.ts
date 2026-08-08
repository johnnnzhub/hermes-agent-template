// Maquina de entrega do turno de voz. Pura: sem fetch, sem timer, sem render.
//
// Ate a v0.4.3 a escada de retry vivia dentro de sendVoiceTurn e reenviava o payload
// INTEIRO — 30 s de PCM dao ~1,28 MB em base64 — tres vezes, com 35 s de timeout cada.
// Quando o gargalo era o proprio upload, cada tentativa piorava o quadro e o HUD ficava
// ~109 s em PENSANDO antes de admitir a falha.
//
// Aqui a regra e outra: falha de rede nunca reenvia o audio de cara, ela PERGUNTA. Um
// GET /session custa ~200 bytes e responde a unica duvida que importa — o turno entrou
// ou nao? So quando a sessao continua intacta e que vale gastar outro upload.
//
// Reenviar e seguro por construcao: o servidor deduplica por clientMsgId + fingerprint
// do audio, entao repetir a mesma tentativa devolve a promessa em voo ou o mesmo
// resultado, nunca um segundo turno.

export type SendPhase =
  /** Fazer o POST /turn. */
  | 'post'
  /** Perguntar por id: GET /turn/:clientMsgId. Resposta definitiva, ~200 bytes. */
  | 'ask'
  /** Fallback do `ask`: GET /session, quando a rota por id nao existe no servidor. */
  | 'probe'
  /** Esperar `waitMs` antes do proximo POST. */
  | 'wait'
  /** O servidor tem o turno; seguir para o poll da resposta. */
  | 'thinking'
  /** Parado com o rascunho intacto; o HUD pede reenvio. */
  | 'retry'
  /** Nao ha nada a recuperar; o rascunho pode sair. */
  | 'discarded'

export type SendReason =
  | 'none'
  /** Capturado e guardado, ainda sem nenhuma tentativa de envio. */
  | 'saved'
  | 'network'
  | 'auth'
  | 'conflict'
  | 'no-speech'
  | 'too-long'
  | 'server'
  | 'exhausted'

export interface SendState {
  phase: SendPhase
  /** POSTs ja realizados. */
  attempts: number
  /** Perguntas por id ja feitas enquanto o servidor respondia "pending". */
  asks: number
  /** Perguntas que nao chegaram a ser respondidas. Contador SEPARADO de `asks`:
   *  compartilhar um so fazia uma alternancia pending/failed pular a escada de ambos. */
  askFailures: number
  /**
   * O servidor PROVOU nao ter a rota por id: respondeu 404 nela. Essa e a unica evidencia
   * que autoriza inferir a entrega pela revision da sessao — o unico caminho do cliente
   * capaz de apagar uma fala nao entregue.
   *
   * Nao confundir com "a pergunta falhou". Timeout, 5xx e queda de rede nao dizem nada
   * sobre a existencia da rota, entao esgotar tentativas NUNCA liga esta flag: um servidor
   * atualizado com rede ruim ficaria indistinguivel de um servidor velho, e a fala seria
   * creditada a uma mudanca de revision causada por outro turno.
   */
  inferable: boolean
  waitMs: number
  /** Para onde o `wait` volta quando o tempo passa. */
  waitNext: 'post' | 'ask'
  reason: SendReason
  transcript: string
  /** Revision da conversa no instante do envio; referencia do probe. */
  anchorRevision: string
  /** O rascunho pode ser apagado: o turno foi confirmado ou e irrecuperavel. */
  clearDraft: boolean
  /** Reenviar exige novo clientMsgId e nova expectedRevision. */
  needsRefresh: boolean
}

export type SendEvent =
  | { kind: 'accepted'; transcript: string }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  /** O servidor nunca viu este clientMsgId: o turno realmente nao chegou. */
  | { kind: 'status-unknown' }
  /** O servidor tem o id e ainda esta trabalhando nele. */
  | { kind: 'status-pending' }
  /** O servidor ja concluiu este id; `turnStatus` e o que o POST teria devolvido. */
  | { kind: 'status-done'; turnStatus: number; transcript: string }
  /** A rota por id nao existe neste servidor: so entao vale inferir pela sessao. */
  | { kind: 'status-missing' }
  /** A rota existe mas nao respondeu agora: perguntar de novo, nunca inferir. */
  | { kind: 'status-failed' }
  | { kind: 'probe'; state: 'idle' | 'busy' | 'awaiting'; revision: string }
  | { kind: 'probe-failed' }
  /** O `wait` terminou. */
  | { kind: 'timer' }
  /** Toque do usuario: reenviar agora. */
  | { kind: 'manual' }

export const RETRY_DELAYS = [5_000, 15_000, 40_000]
export const MAX_POSTS = RETRY_DELAYS.length + 1
// Perguntar por id e barato, entao insiste mais e mais rapido que a escada de upload.
export const ASK_DELAYS = [2_000, 4_000, 8_000, 15_000]
export const MAX_ASKS = ASK_DELAYS.length

const BASE: SendState = {
  phase: 'post',
  attempts: 0,
  asks: 0,
  askFailures: 0,
  inferable: false,
  waitMs: 0,
  waitNext: 'post',
  reason: 'none',
  transcript: '',
  anchorRevision: '',
  clearDraft: false,
  needsRefresh: false,
}

export function startSend(anchorRevision: string): SendState {
  return { ...BASE, anchorRevision }
}

/**
 * Rascunho parado esperando um toque, sem tentativa nenhuma ainda: fala salva na saida
 * de foreground, ou rascunho encontrado no disco ao abrir o app. Reenviar sozinho uma
 * fala de minutos atras seria surpresa; quem decide e o toque.
 */
export function parkedDraft(anchorRevision: string): SendState {
  return { ...BASE, phase: 'retry', anchorRevision, reason: 'saved' }
}

function park(state: SendState, reason: SendReason, needsRefresh = false): SendState {
  return { ...state, phase: 'retry', waitMs: 0, reason, needsRefresh }
}

/**
 * Desiste de descobrir o desfecho e devolve o rascunho ao John. Parar e sempre seguro:
 * o reenvio repete o mesmo clientMsgId, que o servidor deduplica. E preferivel a um
 * PENSANDO sem fim, que foi o sintoma que abriu esta frente.
 */
export function parkExhausted(state: SendState): SendState {
  return park(state, 'exhausted')
}

function discard(state: SendState, reason: SendReason): SendState {
  return { ...state, phase: 'discarded', waitMs: 0, reason, clearDraft: true }
}

function accept(state: SendState, transcript: string): SendState {
  return {
    ...state,
    phase: 'thinking',
    waitMs: 0,
    reason: 'none',
    transcript,
    clearDraft: true,
  }
}

/** Falha reciclavel: pergunta antes de gastar outro upload. */
function toAsk(state: SendState, reason: SendReason): SendState {
  return { ...state, phase: 'ask', waitMs: 0, reason }
}

/** Depois de uma resposta inconclusiva: espera o degrau da escada, ou desiste. */
function afterInconclusiveProbe(state: SendState): SendState {
  if (state.attempts >= MAX_POSTS) return park(state, 'exhausted')
  const waitMs = RETRY_DELAYS[Math.min(state.attempts - 1, RETRY_DELAYS.length - 1)]
  return { ...state, phase: 'wait', waitMs, waitNext: 'post' }
}

/**
 * A pergunta em si falhou. Insiste — e ao esgotar PARA, com o rascunho guardado.
 *
 * Insistencia esgotada nao e evidencia de nada: nao diz que a rota sumiu nem que o turno
 * entrou. Cair na inferencia por revision aqui era o buraco que sobreviveu a quatro
 * rodadas — bastava a rede falhar cinco vezes e outro turno mexer na conversa para o
 * cliente creditar a entrega e apagar a fala. Parar e sempre seguro: o reenvio manual e
 * deduplicado por clientMsgId + fingerprint, entao no pior caso o John toca de novo.
 */
function afterFailedAsk(state: SendState): SendState {
  const askFailures = state.askFailures + 1
  if (askFailures > MAX_ASKS) return park({ ...state, askFailures }, 'exhausted')
  return {
    ...state,
    phase: 'wait',
    waitMs: ASK_DELAYS[Math.min(askFailures - 1, ASK_DELAYS.length - 1)],
    waitNext: 'ask',
    askFailures,
  }
}

/** O servidor confirmou que tem o id: insiste barato antes de dar o turno como em curso. */
function afterPendingAsk(state: SendState): SendState {
  const asks = state.asks + 1
  if (asks > MAX_ASKS) {
    // O servidor tem o turno; quem mostra o desfecho e o poll. O rascunho continua
    // guardado ate a pos-condicao confirmar a entrega.
    return { ...state, phase: 'thinking', waitMs: 0, asks, reason: 'none' }
  }
  return {
    ...state,
    phase: 'wait',
    waitMs: ASK_DELAYS[Math.min(asks - 1, ASK_DELAYS.length - 1)],
    waitNext: 'ask',
    asks,
  }
}

function fromHttp(state: SendState, status: number): SendState {
  // 5xx e retentavel: pode ser o gateway reiniciando no meio do turno.
  if (status >= 500) return toAsk(state, 'server')
  if (status === 401 || status === 403) return park(state, 'auth')
  // Rota ausente: backend desatualizado ou nao promovido. Nada melhora com retry
  // automatico, mas o rascunho fica — basta o backend voltar (incidente 2026-08-03).
  if (status === 404) return park(state, 'server')
  // A conversa mudou. Reenviar exige um turno genuinamente novo: mexer na revision muda
  // o fingerprint e o servidor devolveria 409 "clientMsgId ja foi utilizado".
  if (status === 409) return park(state, 'conflict', true)
  // Descartar so onde a gravacao comprovadamente nao serve: audio maior que o limite e
  // audio sem fala. Qualquer outro status PARA com o rascunho guardado — antes, o default
  // descartava, entao um 408, 425 ou 429 transitorio apagava uma fala que um reenvio
  // teria entregue.
  if (status === 413) return discard(state, 'too-long')
  if (status === 422) return discard(state, 'no-speech')
  return park(state, 'server')
}

export function reduce(state: SendState, event: SendEvent): SendState {
  // O toque do usuario vale em qualquer estado parado e reabre a escada inteira.
  if (event.kind === 'manual') {
    if (state.phase !== 'retry' && state.phase !== 'wait') return state
    // Esperando para PERGUNTAR de novo: o servidor ja confirmou que tem o turno, entao
    // apressar nao pode virar reenvio dos ~1,28 MB.
    if (state.phase === 'wait' && state.waitNext === 'ask') {
      return { ...state, phase: 'ask', waitMs: 0 }
    }
    return {
      ...BASE,
      transcript: state.transcript,
      anchorRevision: state.anchorRevision,
      needsRefresh: state.needsRefresh,
      // Rota ausente e fato do servidor, nao do estado da tentativa: reabrir a escada nao
      // faz o 404 desaparecer. Zerar aqui devolvia a inferencia a um caminho ja fechado.
      inferable: state.inferable,
    }
  }

  switch (state.phase) {
    case 'post': {
      const posted = { ...state, attempts: state.attempts + 1 }
      if (event.kind === 'accepted') return accept(posted, event.transcript)
      if (event.kind === 'http') return fromHttp(posted, event.status)
      if (event.kind === 'network') return toAsk(posted, 'network')
      return state
    }

    case 'ask': {
      // Resposta definitiva do servidor sobre ESTE id — nao inferencia sobre a sessao.
      if (event.kind === 'status-done') {
        if (event.turnStatus === 202) return accept(state, event.transcript)
        return fromHttp(state, event.turnStatus)
      }
      if (event.kind === 'status-pending') return afterPendingAsk(state)
      if (event.kind === 'status-unknown') return afterInconclusiveProbe(state)
      // 404 na rota por id: o servidor respondeu, e a resposta foi "nao tenho essa rota".
      // Servidor anterior a esta versao, entao o caminho antigo — inferir pela revision da
      // sessao — e tudo o que resta. Unico lugar do codigo que liga `inferable`.
      if (event.kind === 'status-missing') {
        return { ...state, phase: 'probe', waitMs: 0, inferable: true }
      }
      if (event.kind === 'status-failed') return afterFailedAsk(state)
      return state
    }

    case 'probe': {
      if (event.kind === 'probe') {
        // Sessao mexida = o turno provavelmente entrou. "Provavelmente" nao apaga
        // rascunho: quem confirma e a pos-condicao, em settlePending.
        if (event.state !== 'idle' || event.revision !== state.anchorRevision) {
          return { ...state, phase: 'thinking', waitMs: 0, reason: 'none' }
        }
        return afterInconclusiveProbe(state)
      }
      if (event.kind === 'probe-failed') return afterInconclusiveProbe(state)
      return state
    }

    case 'wait': {
      if (event.kind !== 'timer') return state
      // Um POST novo comeca uma rodada nova de perguntas: sem zerar, os contadores
      // vazavam de uma tentativa para a seguinte e a proxima resposta era terminal na hora.
      if (state.waitNext === 'post') {
        return { ...state, phase: 'post', waitMs: 0, asks: 0, askFailures: 0 }
      }
      return { ...state, phase: 'ask', waitMs: 0 }
    }

    default:
      return state
  }
}

export interface SettleInput {
  state: 'idle' | 'busy' | 'awaiting'
  revision: string
  turnCount: number
}

/**
 * Pos-condicao do envio ambiguo (o POST morreu, o probe viu a sessao mexida).
 * So quando a sessao volta a idle da para afirmar se o turno entrou: ou a revision
 * mudou, ou apareceu turno novo. Sessao intacta significa que a fala NAO foi entregue e
 * o rascunho volta a ser oferecido.
 */
export function settlePending(
  turn: { expectedRevision: string; turnsAtSubmit: number },
  session: SettleInput,
): 'delivered' | 'lost' | 'pending' {
  if (session.state !== 'idle') return 'pending'
  if (session.revision !== turn.expectedRevision) return 'delivered'
  if (session.turnCount > turn.turnsAtSubmit) return 'delivered'
  return 'lost'
}

export function reasonHeadline(reason: SendReason): string {
  switch (reason) {
    case 'saved':
      return 'RASCUNHO GUARDADO'
    case 'auth':
      return 'TOKEN DO HERMES INVÁLIDO'
    case 'conflict':
      return 'A CONVERSA MUDOU'
    case 'no-speech':
      return 'NÃO OUVI FALA SUFICIENTE'
    case 'too-long':
      return 'ÁUDIO LONGO DEMAIS'
    case 'server':
      return 'HERMES FORA DO AR'
    default:
      return 'NÃO ENVIOU'
  }
}
