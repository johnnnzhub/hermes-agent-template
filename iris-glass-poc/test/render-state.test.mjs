import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settleRenderAttempt } from '../src/renderState.ts'

test('a false SDK acknowledgment keeps the new frame dirty for retry', () => {
  const settled = settleRenderAttempt('PENSANDO', 'Resposta pronta', false, 0)
  assert.equal(settled.confirmed, false)
  assert.equal(settled.lastConfirmed, 'PENSANDO')
  assert.equal(settled.retryDelayMs, 250)
})

test('a timeout is never recorded as rendered and retries behind a longer fence', () => {
  const settled = settleRenderAttempt('PENSANDO', 'Resposta pronta', 'timeout', 0)
  assert.equal(settled.confirmed, false)
  assert.equal(settled.lastConfirmed, 'PENSANDO')
  assert.equal(settled.retryDelayMs, 2_000)
})

test('only an explicit true acknowledgment advances the confirmed frame', () => {
  const settled = settleRenderAttempt('PENSANDO', 'Resposta pronta', true, 3)
  assert.equal(settled.confirmed, true)
  assert.equal(settled.lastConfirmed, 'Resposta pronta')
  assert.equal(settled.failures, 0)
})

test('fast failures back off and cap at two seconds', () => {
  const delays = Array.from({ length: 6 }, (_, failures) =>
    settleRenderAttempt('A', 'B', 'error', failures).retryDelayMs,
  )
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 2_000, 2_000])
})

