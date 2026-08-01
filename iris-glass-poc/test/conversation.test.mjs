import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConversationPages,
  latestTurnFirstPage,
  mergeOlderTurns,
  wrapHudText,
} from '../src/conversation.ts'

test('wraps HUD text without exceeding the display width', () => {
  const lines = wrapHudText(
    'Uma resposta longa precisa continuar legível sem cortar palavras comuns no display dos óculos.',
    24,
  )
  assert.ok(lines.length > 1)
  assert.ok(lines.every(line => line.length <= 24))
  assert.equal(lines.join(' '), 'Uma resposta longa precisa continuar legível sem cortar palavras comuns no display dos óculos.')
})

test('builds paged turns and opens at the first page of the latest turn', () => {
  const pages = buildConversationPages([
    { id: 'old', user: 'Pergunta antiga', assistant: 'Resposta antiga' },
    {
      id: 'latest',
      user: 'Pergunta nova',
      assistant: Array.from({ length: 45 }, (_, index) => `palavra${index}`).join(' '),
    },
  ])
  const index = latestTurnFirstPage(pages)
  assert.equal(pages[index].turnId, 'latest')
  assert.equal(pages[index].page, 0)
  assert.ok(pages.filter(page => page.turnId === 'latest').length > 1)
  assert.match(pages[index].text, /scroll = histórico · tap = falar/)
})

test('prepends older history without duplicating turns already loaded', () => {
  const result = mergeOlderTurns(
    [
      { id: 'two', user: '2', assistant: 'dois' },
      { id: 'three', user: '3', assistant: 'três' },
    ],
    [
      { id: 'one', user: '1', assistant: 'um' },
      { id: 'two', user: '2', assistant: 'dois' },
    ],
  )
  assert.deepEqual(result.map(turn => turn.id), ['one', 'two', 'three'])
})

