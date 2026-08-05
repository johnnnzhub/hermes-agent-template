const SESSION_TIMEOUT_MS = 12_000
const TURN_TIMEOUT_MS = 35_000

export interface HermesTurn {
  id: string
  user: string
  assistant: string
}
export interface HermesProgress {
  kind: 'thinking' | 'tool' | 'answer' | 'awaiting'
  text: string
}

export interface HermesSession {
  ok: true
  sessionId: string
  revision: string
  state: 'idle' | 'busy' | 'awaiting'
  progress: HermesProgress | null
  turns: HermesTurn[]
  cursor: number
  nextCursor: number | null
}

export interface VoiceTurnRequest {
  pcmB64: string
  sampleRate: number
  channels: number
  bitDepth: number
  clientMsgId: string
  expectedRevision: string
}

export interface VoiceTurnAccepted {
  ok: true
  sessionId: string
  clientMsgId: string
  transcript: string
}

export class ApiError extends Error {
  status: number
  publicMessage: string

  constructor(status: number, publicMessage: string) {
    super(publicMessage)
    this.name = 'ApiError'
    this.status = status
    this.publicMessage = publicMessage
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function baseUrl(): string {
  const configured = (import.meta.env.VITE_HERMES_API_BASE as string | undefined)?.replace(/\/$/, '')
  if (!configured) throw new ApiError(0, 'API do HERMES não configurada.')
  return configured
}

function authHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_GLASS_API_TOKEN as string | undefined
  return token ? { authorization: `Bearer ${token}` } : {}
}

// Exportada para teste: a distincao entre "rota sumiu" e "sem rede" e justamente o
// que faltou no incidente de 2026-08-03, entao precisa de cobertura propria.
export async function responseError(response: Response): Promise<ApiError> {
  let message = ''
  try {
    const body = await response.json()
    if (typeof body?.error === 'string') message = body.error
  } catch {
    // Status alone is sufficient when the gateway returned no JSON.
  }
  if (response.status === 401 || response.status === 403) {
    return new ApiError(response.status, 'Token do HERMES inválido.')
  }
  if (response.status === 409) {
    return new ApiError(response.status, message || 'A conversa mudou; atualize e tente novamente.')
  }
  if (response.status === 413) return new ApiError(response.status, 'Áudio longo demais.')
  if (response.status === 422) return new ApiError(response.status, message || 'Não encontrei fala nesse áudio.')
  // 404 = o servidor respondeu, mas nao tem a rota: backend desatualizado ou nao
  // promovido. Em 2026-08-03 isso caiu no texto generico de "sem conexao" e mandou o
  // diagnostico para rede, DNS e TLS durante quase uma hora. Nunca mais confundir uma
  // resposta HTTP com ausencia de rede.
  if (response.status === 404) {
    return new ApiError(response.status, 'HERMES desatualizado: rota ausente no servidor.')
  }
  return new ApiError(response.status, message || `HERMES respondeu erro ${response.status}.`)
}

function normalizedSession(raw: unknown): HermesSession {
  if (!raw || typeof raw !== 'object') throw new ApiError(502, 'Resposta inválida do HERMES.')
  const data = raw as Partial<HermesSession>
  if (
    data.ok !== true ||
    typeof data.sessionId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(String(data.revision ?? '')) ||
    !['idle', 'busy', 'awaiting'].includes(String(data.state))
  ) {
    throw new ApiError(502, 'Resposta inválida do HERMES.')
  }
  const turns = Array.isArray(data.turns)
    ? data.turns
        .filter((turn): turn is HermesTurn => Boolean(
          turn &&
          typeof turn.id === 'string' &&
          typeof turn.user === 'string' &&
          typeof turn.assistant === 'string',
        ))
        .slice(0, 10)
    : []
  const progress = data.progress &&
    typeof data.progress.text === 'string' &&
    ['thinking', 'tool', 'answer', 'awaiting'].includes(data.progress.kind)
    ? { kind: data.progress.kind, text: data.progress.text.slice(0, 80) }
    : null
  return {
    ok: true,
    sessionId: data.sessionId,
    revision: String(data.revision),
    state: data.state as HermesSession['state'],
    progress,
    turns,
    cursor: Number.isInteger(data.cursor) ? Number(data.cursor) : 0,
    nextCursor: Number.isInteger(data.nextCursor) ? Number(data.nextCursor) : null,
  }
}

export function newMsgId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function fetchHermesSession(cursor = 0): Promise<HermesSession> {
  let lastError: unknown
  for (const delay of [0, 700]) {
    if (delay) await sleep(delay)
    try {
      const response = await fetchWithTimeout(
        `${baseUrl()}/glass/hermes/session?cursor=${cursor}&limit=6`,
        { headers: authHeaders() },
        SESSION_TIMEOUT_MS,
      )
      if (!response.ok) throw await responseError(response)
      return normalizedSession(await response.json())
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error
      lastError = error
    }
  }
  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(0, 'Sem conexão com o HERMES.')
}

export async function sendVoiceTurn(request: VoiceTurnRequest): Promise<VoiceTurnAccepted> {
  const payload = JSON.stringify(request)
  let lastError: unknown
  for (const delay of [0, 1_000, 3_000]) {
    if (delay) await sleep(delay)
    try {
      const response = await fetchWithTimeout(
        `${baseUrl()}/glass/hermes/turn`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: payload,
        },
        TURN_TIMEOUT_MS,
      )
      if (!response.ok) throw await responseError(response)
      const body = await response.json()
      if (
        body?.ok !== true ||
        typeof body.sessionId !== 'string' ||
        typeof body.clientMsgId !== 'string' ||
        typeof body.transcript !== 'string'
      ) {
        throw new ApiError(502, 'Resposta inválida do HERMES.')
      }
      return {
        ok: true,
        sessionId: body.sessionId,
        clientMsgId: body.clientMsgId,
        transcript: body.transcript,
      }
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error
      lastError = error
    }
  }
  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(0, 'Não consegui enviar a mensagem.')
}
