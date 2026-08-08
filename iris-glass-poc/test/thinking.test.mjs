import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POLL_FAST_MS,
  POLL_MID_MS,
  POLL_SLOW_MS,
  THINKING_HARD_MS,
  THINKING_TICK_MS,
  isThinkingStuck,
  pollDelay,
  thinkingLabel,
} from '../src/thinking.ts'

test('o poll comeca rapido e afrouxa conforme o turno se estende', () => {
  assert.equal(pollDelay(0), POLL_FAST_MS)
  assert.equal(pollDelay(29_999), POLL_FAST_MS)
  assert.equal(pollDelay(30_000), POLL_MID_MS)
  assert.equal(pollDelay(119_999), POLL_MID_MS)
  assert.equal(pollDelay(120_000), POLL_SLOW_MS)
  assert.equal(pollDelay(3_600_000), POLL_SLOW_MS)
})

test('o contador so aparece depois de 20s e anda de 10 em 10', () => {
  assert.equal(thinkingLabel('PENSANDO', 0), 'PENSANDO')
  assert.equal(thinkingLabel('PENSANDO', THINKING_TICK_MS - 1), 'PENSANDO')
  assert.equal(thinkingLabel('PENSANDO', 20_000), 'PENSANDO · 20s')
  assert.equal(thinkingLabel('PENSANDO', 29_999), 'PENSANDO · 20s')
  assert.equal(thinkingLabel('PENSANDO', 30_000), 'PENSANDO · 30s')
})

// O rebuildPageContainer custa ~200 ms e nao e thread-safe: um contador por segundo
// redesenharia o HUD o tempo todo. A granularidade de 10 s mantem a honestidade barata.
test('o rotulo muda no maximo uma vez a cada 10s', () => {
  const labels = new Set()
  for (let elapsed = THINKING_TICK_MS; elapsed < THINKING_TICK_MS + 60_000; elapsed += 500) {
    labels.add(thinkingLabel('PENSANDO', elapsed))
  }
  assert.equal(labels.size, 6)
})

test('o rotulo acompanha a ferramenta em uso, nao so o PENSANDO', () => {
  assert.equal(thinkingLabel('USANDO BASH', 40_000), 'USANDO BASH · 40s')
})

test('o teto do PENSANDO fecha em 4 minutos', () => {
  assert.equal(isThinkingStuck(0), false)
  assert.equal(isThinkingStuck(THINKING_HARD_MS - 1), false)
  assert.equal(isThinkingStuck(THINKING_HARD_MS), true)
})
