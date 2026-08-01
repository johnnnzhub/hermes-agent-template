import type { HermesTurn } from './glassApi'

const LINE_WIDTH = 43
const BODY_LINES = 6

export interface ConversationPage {
  key: string
  turnId: string
  page: number
  pageCount: number
  text: string
}

function plainText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, block => block.replace(/```[^\n]*\n?/g, ''))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\s)[*_~`]{1,3}|[*_~`]{1,3}(?=\s|$)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\r/g, '')
    .trim()
}

export function wrapHudText(value: string, width = LINE_WIDTH): string[] {
  const output: string[] = []
  for (const paragraph of plainText(value).split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (!words.length) {
      if (output.at(-1) !== '') output.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      if (word.length > width) {
        if (line) output.push(line)
        for (let index = 0; index < word.length; index += width) {
          output.push(word.slice(index, index + width))
        }
        line = ''
        continue
      }
      const candidate = line ? `${line} ${word}` : word
      if (candidate.length <= width) line = candidate
      else {
        output.push(line)
        line = word
      }
    }
    if (line) output.push(line)
  }
  while (output.at(-1) === '') output.pop()
  return output
}

function turnLines(turn: HermesTurn): string[] {
  const lines: string[] = []
  if (turn.user) lines.push('VOCE', ...wrapHudText(turn.user))
  if (turn.assistant) {
    if (lines.length) lines.push('')
    lines.push('HERMES', ...wrapHudText(turn.assistant))
  } else if (turn.user) {
    lines.push('', 'HERMES', 'Aguardando resposta...')
  }
  return lines
}

export function buildConversationPages(turns: HermesTurn[]): ConversationPage[] {
  const pages: ConversationPage[] = []
  turns.forEach((turn, turnIndex) => {
    const lines = turnLines(turn)
    const chunks: string[][] = []
    for (let index = 0; index < Math.max(lines.length, 1); index += BODY_LINES) {
      chunks.push(lines.slice(index, index + BODY_LINES))
    }
    chunks.forEach((chunk, pageIndex) => {
      const pageCount = chunks.length
      const header = `HERMES · turno ${turnIndex + 1}/${turns.length} · ${pageIndex + 1}/${pageCount}`
      pages.push({
        key: `${turn.id}:${pageIndex}`,
        turnId: turn.id,
        page: pageIndex,
        pageCount,
        text: [header, ...chunk, '', 'scroll = histórico · tap = falar'].join('\n'),
      })
    })
  })
  return pages
}

export function latestTurnFirstPage(pages: ConversationPage[]): number {
  if (!pages.length) return 0
  const latestId = pages.at(-1)?.turnId
  const found = pages.findIndex(page => page.turnId === latestId)
  return found < 0 ? pages.length - 1 : found
}

export function mergeOlderTurns(current: HermesTurn[], older: HermesTurn[]): HermesTurn[] {
  const seen = new Set<string>()
  return [...older, ...current].filter(turn => {
    if (seen.has(turn.id)) return false
    seen.add(turn.id)
    return true
  })
}

