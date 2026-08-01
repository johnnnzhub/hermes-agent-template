export type RenderOutcome = boolean | 'timeout' | 'error'

export interface RenderSettlement {
  confirmed: boolean
  failures: number
  lastConfirmed: string
  retryDelayMs: number
}

const BASE_RETRY_MS = 250
const MAX_RETRY_MS = 2_000

export function settleRenderAttempt(
  lastConfirmed: string,
  attempted: string,
  outcome: RenderOutcome,
  previousFailures: number,
): RenderSettlement {
  if (outcome === true) {
    return {
      confirmed: true,
      failures: 0,
      lastConfirmed: attempted,
      retryDelayMs: BASE_RETRY_MS,
    }
  }

  const failures = Math.max(0, previousFailures) + 1
  const retryDelayMs = outcome === 'timeout'
    ? MAX_RETRY_MS
    : Math.min(BASE_RETRY_MS * (2 ** Math.min(failures - 1, 3)), MAX_RETRY_MS)
  return {
    confirmed: false,
    failures,
    lastConfirmed,
    retryDelayMs,
  }
}
