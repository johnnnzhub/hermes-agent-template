// Rascunho duravel do turno de voz.
//
// Ate a v0.4.3 o PCM gravado vivia num unico `const` dentro de finishRecording, e o
// buffer do microfone ja tinha sido zerado por stopRecording antes da primeira chamada
// de rede. Qualquer falha levava a fala junto, sem rastro nenhum: nem o plugin nem o
// servidor gravavam a mensagem. Este modulo torna a captura uma PRE-CONDICAO explicita
// do envio — o rascunho e escrito antes de qualquer fetch e so e apagado quando o
// servidor confirma o turno ou quando nao ha nada a recuperar.
//
// O disco e best-effort: no WebView do G2 o localStorage pode nao existir, pode lancar
// e tem cota. A copia em memoria e sempre a fonte da verdade; persistir serve para o
// rascunho sobreviver a fechar e reabrir o app.

const STORAGE_KEY = 'hermes_pending_v1'

export const DRAFT_TTL_MS = 15 * 60_000
// 30 s de PCM 16 kHz/16 bit dao ~1,28 MB em base64. O teto deixa folga para isso e
// recusa qualquer coisa maior antes de arriscar um QuotaExceeded.
export const MAX_DRAFT_B64 = 1_800_000

export interface PendingTurn {
  clientMsgId: string
  pcmB64: string
  expectedRevision: string
  createdAt: number
  durMs: number
  attempts: number
  /** Ja recebeu 202 alguma vez — o servidor tem o turno, so falta a resposta. */
  submitted: boolean
  /** Preenchido pelo 202; e o que o servidor entendeu da fala. */
  transcript?: string
  /** Quantidade de turnos visiveis no instante do envio. Pos-condicao de entrega. */
  turnsAtSubmit: number
}

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Versao do FORMATO, nao do app. Carimbar a versao do app aqui apagava o rascunho em toda
 * atualizacao do plugin — justo o oposto do que o update in-place promete ao preservar o
 * localStorage: o John instalaria a versao nova e perderia a fala pendente na primeira
 * abertura. So sobe quando o shape de PendingTurn mudar de forma incompativel.
 */
const DRAFT_SCHEMA = 1

export function defaultStorage(): DraftStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // Storage desabilitado no WebView: segue so em memoria.
    return null
  }
}

export function isFresh(turn: PendingTurn, now = Date.now()): boolean {
  return now - turn.createdAt < DRAFT_TTL_MS
}

/** Descricao curta do rascunho para o HUD, sem depender do transcript. */
export function draftSummary(turn: PendingTurn): string {
  if (turn.transcript) return turn.transcript
  const seconds = Math.max(1, Math.round(turn.durMs / 1_000))
  return `rascunho de ${seconds}s de fala`
}

export function normalizePendingTurn(raw: unknown): PendingTurn | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Partial<PendingTurn>
  if (
    typeof data.clientMsgId !== 'string' || !data.clientMsgId ||
    typeof data.pcmB64 !== 'string' || !data.pcmB64 ||
    typeof data.expectedRevision !== 'string' ||
    !Number.isFinite(data.createdAt) ||
    !Number.isFinite(data.durMs)
  ) {
    return null
  }
  return {
    clientMsgId: data.clientMsgId,
    pcmB64: data.pcmB64,
    expectedRevision: data.expectedRevision,
    createdAt: Number(data.createdAt),
    durMs: Number(data.durMs),
    attempts: Number.isFinite(data.attempts) ? Math.max(0, Number(data.attempts)) : 0,
    submitted: data.submitted === true,
    transcript: typeof data.transcript === 'string' ? data.transcript : undefined,
    turnsAtSubmit: Number.isFinite(data.turnsAtSubmit) ? Math.max(0, Number(data.turnsAtSubmit)) : 0,
  }
}

export function clearPendingTurn(storage: DraftStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Nada a fazer: o chamador ja descartou a copia em memoria.
  }
}

/** Devolve true quando o rascunho chegou ao disco. False significa "so em memoria". */
export function savePendingTurn(
  turn: PendingTurn,
  storage: DraftStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  if (turn.pcmB64.length > MAX_DRAFT_B64) {
    // Grande demais para o disco: apaga o que estiver la para um rascunho velho nunca
    // ressurgir no lugar deste.
    clearPendingTurn(storage)
    return false
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: DRAFT_SCHEMA, turn }))
    return true
  } catch {
    clearPendingTurn(storage)
    return false
  }
}

export function loadPendingTurn(
  now = Date.now(),
  storage: DraftStorage | null = defaultStorage(),
): PendingTurn | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearPendingTurn(storage)
    return null
  }

  const envelope = parsed as { v?: unknown; turn?: unknown } | null
  // Schema diferente: o formato mudou e o audio nao vale um palpite. Atualizar o plugin
  // NAO cai aqui — o rascunho atravessa a atualizacao, que e o ponto do update in-place.
  if (!envelope || envelope.v !== DRAFT_SCHEMA) {
    clearPendingTurn(storage)
    return null
  }

  const turn = normalizePendingTurn(envelope.turn)
  if (!turn || !isFresh(turn, now)) {
    clearPendingTurn(storage)
    return null
  }
  return turn
}
