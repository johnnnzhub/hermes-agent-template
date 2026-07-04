export interface GlassIntentRequest {
  transcript: string
  source: 'g2' | 'simulator' | 'dev'
}

export interface GlassIntentResponse {
  glass_short: string
  whatsapp_full?: string
  action?: string
  needs_confirmation?: boolean
}

const DEFAULT_RESPONSE: GlassIntentResponse = {
  glass_short: 'Iris pronta. Toque para falar.',
  action: 'idle',
}

export async function sendIntent(req: GlassIntentRequest): Promise<GlassIntentResponse> {
  const baseUrl = (import.meta.env.VITE_GLASS_API_BASE as string | undefined)?.replace(/\/$/, '')

  if (!baseUrl) {
    return {
      glass_short: shortForDisplay(`Mock Iris: ${req.transcript || 'sem áudio'}`),
      action: 'mock_intent',
    }
  }

  const res = await fetch(`${baseUrl}/glass/intent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(import.meta.env.VITE_GLASS_API_TOKEN
        ? { authorization: `Bearer ${import.meta.env.VITE_GLASS_API_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    throw new Error(`Glass API ${res.status}: ${await res.text()}`)
  }

  return normalizeResponse(await res.json())
}

function normalizeResponse(raw: unknown): GlassIntentResponse {
  if (!raw || typeof raw !== 'object') return DEFAULT_RESPONSE
  const data = raw as Partial<GlassIntentResponse>
  return {
    glass_short: shortForDisplay(data.glass_short || DEFAULT_RESPONSE.glass_short),
    whatsapp_full: data.whatsapp_full,
    action: data.action,
    needs_confirmation: Boolean(data.needs_confirmation),
  }
}

export function shortForDisplay(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

// ── 0.2.0: /glass/tasks read-only ────────────────────────────────────────────
// Contrato acordado com a Iris: lines display-ready (prefixo », ≤6, ≤42 chars)
// + ids paralelo a lines (base das ações na 0.2.1).

export interface GlassTasksResponse {
  ok: boolean
  lines: string[]
  ids: string[]
  updated_at?: string
  error?: string
}

export async function fetchGlassTasks(limit = 5): Promise<GlassTasksResponse> {
  const baseUrl = (import.meta.env.VITE_GLASS_API_BASE as string | undefined)?.replace(/\/$/, '')

  // Fallback mock (dev/browser sem API): mantém o plugin testável offline.
  if (!baseUrl) {
    return {
      ok: true,
      lines: ['» Mock: preparar posts', '» Mock: revisar lista', '» Mock: validar G2'],
      ids: ['mock-1', 'mock-2', 'mock-3'],
    }
  }

  const res = await fetch(`${baseUrl}/glass/tasks?scope=next&limit=${limit}`, {
    headers: {
      ...(import.meta.env.VITE_GLASS_API_TOKEN
        ? { authorization: `Bearer ${import.meta.env.VITE_GLASS_API_TOKEN}` }
        : {}),
    },
  })

  if (!res.ok) {
    throw new Error(`Glass API ${res.status}: ${await res.text()}`)
  }

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
