// Cliente da Hermes Glass API (v0.3.x): GET /glass/tasks + POST /glass/task.
// Conversa com a Iris NÃO passa por aqui — é o canal BYOA nativo do Even Hub
// (decisão da PO; sendIntent/STT removidos na 0.3.0).
//
// Padrões portados de projects/apps/g2-fluxo/src/api.ts (battle-tested no G2):
// fetchWithTimeout (WebView pendura fetch sem rejeitar), retry [0,1s,3s] com
// clientMsgId ESTÁVEL (dedup no gateway: mesmo id 2× = no-op), 401/403
// fail-fast 'token' (retry não conserta credencial).

const ACTION_TIMEOUT_MS = 15000
const TASKS_TIMEOUT_MS = 12000

class HttpError extends Error {
  status: number
  constructor(status: number) {
    super('HTTP ' + status)
    this.status = status
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function baseUrl(): string | undefined {
  return (import.meta.env.VITE_GLASS_API_BASE as string | undefined)?.replace(/\/$/, '')
}

function authHeaders(): Record<string, string> {
  return import.meta.env.VITE_GLASS_API_TOKEN
    ? { authorization: `Bearer ${import.meta.env.VITE_GLASS_API_TOKEN}` }
    : {}
}

export function newMsgId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// ── GET /glass/tasks ─────────────────────────────────────────────────────────

export interface GlassTasksResponse {
  ok: boolean
  lines: string[]
  ids: string[]
  updated_at?: string
  error?: string
}

export async function fetchGlassTasks(limit = 5): Promise<GlassTasksResponse> {
  const base = baseUrl()

  // Fallback mock (dev/browser sem API): mantém o plugin testável offline.
  if (!base) {
    return {
      ok: true,
      lines: ['» Mock: preparar posts', '» Mock: revisar lista', '» Mock: validar G2'],
      ids: ['mock-1', 'mock-2', 'mock-3'],
    }
  }

  const res = await fetchWithTimeout(
    `${base}/glass/tasks?scope=next&limit=${limit}`,
    { headers: authHeaders() },
    TASKS_TIMEOUT_MS,
  )
  if (!res.ok) throw new HttpError(res.status)
  return normalizeTasks(await res.json())
}

function normalizeTasks(raw: unknown): GlassTasksResponse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, lines: [], ids: [], error: 'resposta inválida' }
  }
  const data = raw as Partial<GlassTasksResponse>
  const lines = Array.isArray(data.lines)
    ? data.lines.filter((l): l is string => typeof l === 'string').slice(0, 6)
    : []
  const ids = Array.isArray(data.ids) ? data.ids.map(String).slice(0, lines.length) : []
  return {
    ok: Boolean(data.ok),
    lines,
    ids,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
  }
}

// ── POST /glass/task (done/snooze) ───────────────────────────────────────────

export interface ActionResult {
  ok: boolean
  already?: boolean
  gone?: boolean
  error?: string
}

async function postAction(body: Record<string, unknown>): Promise<ActionResult> {
  const base = baseUrl()
  if (!base) return { ok: true } // mock offline: sucesso simulado

  const payload = JSON.stringify(body)
  const delays = [0, 1000, 3000]
  let lastErr = ''
  for (const d of delays) {
    if (d) await sleep(d)
    try {
      const res = await fetchWithTimeout(
        `${base}/glass/task`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: payload,
        },
        ACTION_TIMEOUT_MS,
      )
      if (!res.ok) throw new HttpError(res.status)
      const out = await res.json()
      return {
        ok: out?.ok === true,
        already: out?.already === true,
        gone: out?.gone === true,
        error: typeof out?.error === 'string' ? out.error : undefined,
      }
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        return { ok: false, error: 'token' }
      }
      lastErr = (e as Error).message || 'falha'
    }
  }
  return { ok: false, error: lastErr }
}

export function taskDone(taskId: string, clientMsgId: string): Promise<ActionResult> {
  return postAction({ action: 'task.done', taskId, clientMsgId })
}

export function taskSnooze(taskId: string, clientMsgId: string): Promise<ActionResult> {
  return postAction({ action: 'task.snooze', taskId, clientMsgId })
}
