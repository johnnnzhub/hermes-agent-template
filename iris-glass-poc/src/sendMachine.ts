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
  /** Fazer o GET /session e descobrir se o turno entrou. */
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
  waitMs: number
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
  | { kind: 'probe'; state: 'idle' | 'busy' | 'awaiting'; revision: string }
  | { kind: 'probe-failed' }
  /** O `wait` terminou. */
  | { kind: 'timer' }
  /** Toque do usuario: reenviar agora. */
  | { kind: 'manual' }

export const RETRY_DELAYS = [5_000, 15_000, 40_000]
export const MAX_POSTS = RETRY_DELAYS.length + 1

const BASE: SendState = {
  phase: 'post',
  attempts: 0,
  waitMs: 0,
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

function discard(state: SendState, reason: SendReason): SendState {
  return { ...state, phase: 'discarded', waitMs: 0, reason, clearDraft: true }
}

/** Falha reciclavel: pergunta antes de gastar outro upload. */
function toProbe(state: SendState, reason: SendReason): SendState {
  return { ...state, phase: 'probe', waitMs: 0, reason }
}

/** Depois do probe inconclusivo: espera o degrau da escada, ou desiste. */
function afterInconclusiveProbe(state: SendState): SendState {
  if (state.attempts >= MAX_POSTS) return park(state, 'exhausted')
  const waitMs = RETRY_DELAYS[Math.min(state.attempts - 1, RETRY_DELAYS.length - 1)]
  return { ...state, phase: 'wait', waitMs }
}

function fromHttp(state: SendState, status: number): SendState {
  // 5xx e retentavel: pode ser o gateway reiniciando no meio do turno.
  if (status >= 500) return toProbe(state, 'server')
  if (status === 401 || status === 403) return park(state, 'auth')
  // Rota ausente: backend desatualizado ou nao promovido. Nada melhora com retry
  // automatico, mas o rascunho fica — basta o backend voltar (incidente 2026-08-03).
  if (status === 404) return park(state, 'server')
  // A conversa mudou. Reenviar exige um turno genuinamente novo: mexer na revision muda
  // o fingerprint e o servidor devolveria 409 "clientMsgId ja foi utilizado".
  if (status === 409) return park(state, 'conflict', true)
  if (status === 413) return discard(state, 'too-long')
  if (status === 422) return discard(state, 'no-speech')
  // 400 e afins: o payload nao e aceitavel e repeti-lo identico nao muda nada.
  return discard(state, 'server')
}

export function reduce(state: SendState, event: SendEvent): SendState {
  // O toque do usuario vale em qualquer estado parado e reabre a escada inteira.
  if (event.kind === 'manual') {
    if (state.phase !== 'retry' && state.phase !== 'wait') return state
    return {
      ...BASE,
      transcript: state.transcript,
      anchorRevision: state.anchorRevision,
      needsRefresh: state.needsRefresh,
    }
  }

  switch (state.phase) {
    case 'post': {
      const posted = { ...state, attempts: state.attempts + 1 }
      if (event.kind === 'accepted') {
        return {
          ...posted,
          phase: 'thinking',
          waitMs: 0,
          reason: 'none',
          transcript: event.transcript,
          clearDraft: true,
        }
      }
      if (event.kind === 'http') return fromHttp(posted, event.status)
      if (event.kind === 'network') return toProbe(posted, 'network')
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
      if (event.kind === 'timer') return { ...state, phase: 'post', waitMs: 0 }
      return state
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
