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
