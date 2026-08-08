// Cadencia do poll e honestidade do PENSANDO. Puro: so aritmetica sobre o tempo decorrido.
//
// Ate a v0.4.3 o poll era fixo em 1,2 s e nunca parava, e o HUD escrevia PENSANDO sem
// nenhuma nocao de tempo. Um turno que o agente jamais fechava — `turnActive` so cai com
// result, error ou crash — virava PENSANDO eterno, com cada toque respondendo "A Iris ja
// esta trabalhando" ate alguem reiniciar o container.

export const POLL_FAST_MS = 1_200
export const POLL_MID_MS = 3_000
export const POLL_SLOW_MS = 8_000

const POLL_MID_AFTER_MS = 30_000
const POLL_SLOW_AFTER_MS = 120_000

/** A partir daqui o HUD passa a mostrar quanto tempo faz. */
export const THINKING_TICK_MS = 20_000
/** Granularidade do contador: um rebuildPageContainer a cada 10 s, nao a cada segundo. */
export const THINKING_TICK_STEP_MS = 10_000
/** Teto: acima disso o HUD para de prometer resposta e oferece saida. */
export const THINKING_HARD_MS = 240_000

export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < POLL_MID_AFTER_MS) return POLL_FAST_MS
  if (elapsedMs < POLL_SLOW_AFTER_MS) return POLL_MID_MS
  return POLL_SLOW_MS
}

export function isThinkingStuck(elapsedMs: number): boolean {
  return elapsedMs >= THINKING_HARD_MS
}

export function thinkingLabel(base: string, elapsedMs: number): string {
  if (elapsedMs < THINKING_TICK_MS) return base
  const step = Math.floor(elapsedMs / THINKING_TICK_STEP_MS) * (THINKING_TICK_STEP_MS / 1_000)
  return `${base} · ${step}s`
}
