// Classificação pura de eventos EvenHub (G2). Sem render, sem side effects.
//
// Contrato verificado no SDK 0.0.10 (dist/index.d.ts):
// - OsEventTypeList: CLICK_EVENT=0, SCROLL_TOP=1, SCROLL_BOTTOM=2,
//   DOUBLE_CLICK_EVENT=3, FOREGROUND_ENTER=4, FOREGROUND_EXIT=5,
//   ABNORMAL_EXIT=6, SYSTEM_EXIT=7, IMU_DATA_REPORT=8.
// - eventType é opcional nos PB models e pode chegar como número ou string
//   (longa `CLICK_EVENT` ou abreviada `CLICK`).
// - Pitfall protobuf: valor 0 é omitido na serialização — um tap real chega
//   como listEvent/textEvent/sysEvent PRESENTE com eventType AUSENTE.

export type GlassAction =
  | 'click'
  | 'double_click'
  | 'exit'
  | 'audio'
  | 'lifecycle'
  | 'unknown'

const isClick = (v: unknown) =>
  v === 0 || v === '0' || v === 'CLICK_EVENT' || v === 'CLICK'

const isDouble = (v: unknown) =>
  v === 3 || v === '3' || v === 'DOUBLE_CLICK_EVENT' || v === 'DOUBLE_CLICK'

// Formas longa e curta: OsEventTypeList.fromJson do SDK aceita ambas
// ('FOREGROUND_ENTER_EVENT' e 'FOREGROUND_ENTER') — verificado executando o SDK.
const isLifecycle = (v: unknown) =>
  v === 4 || v === '4' ||
  v === 5 || v === '5' ||
  v === 'FOREGROUND_ENTER_EVENT' || v === 'FOREGROUND_ENTER' ||
  v === 'FOREGROUND_EXIT_EVENT' || v === 'FOREGROUND_EXIT'

const isExit = (v: unknown) =>
  v === 6 || v === '6' ||
  v === 7 || v === '7' ||
  v === 'ABNORMAL_EXIT_EVENT' || v === 'ABNORMAL_EXIT' ||
  v === 'SYSTEM_EXIT_EVENT' || v === 'SYSTEM_EXIT'

function parseMaybeJson(value: unknown): any {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function classifyGlassEvent(event: any): GlassAction {
  if (!event) return 'unknown'

  if (event.audioEvent) return 'audio'

  // jsonData pode chegar como string JSON não parseada (transporte host→WebView).
  const jsonData = parseMaybeJson(event.jsonData)

  const candidates = [
    event.listEvent?.eventType,
    event.textEvent?.eventType,
    event.sysEvent?.eventType,
    jsonData?.eventType,
    jsonData?.Event_Type,
    jsonData?.EventType,
  ].filter(v => v !== undefined && v !== null)

  const hasInteractiveContainer =
    Boolean(event.listEvent) || Boolean(event.textEvent) || Boolean(event.sysEvent)

  // Precedência defensiva: exit ganha de click — num payload combinado
  // (container parecendo click + campo indicando SYSTEM/ABNORMAL_EXIT),
  // encerrar/cleanup deve vencer, nunca disparar comando.
  if (candidates.some(isDouble)) return 'double_click'
  if (candidates.some(isExit)) return 'exit'
  if (candidates.some(isClick)) return 'click'
  if (candidates.some(isLifecycle)) return 'lifecycle'

  // Protobuf omite enum 0: container interativo presente sem eventType é um
  // CLICK_EVENT. Nunca vale para audioEvent (já retornou acima) nem para
  // lifecycle/exit (que chegam com valor explícito != 0).
  if (hasInteractiveContainer && candidates.length === 0) return 'click'

  return 'unknown'
}

// Resumo legível de evento — SOMENTE para builds de diagnóstico (VITE_GLASS_DIAG=1).
// O build final não referencia esta função e o tree-shaking a elimina do bundle.
export function summarizeGlassEvent(event: any): string {
  const label = (v: unknown) => (v === undefined || v === null ? 'none' : String(v))
  const parts: string[] = []
  if (event?.listEvent) parts.push(`list:${label(event.listEvent.eventType)}`)
  if (event?.textEvent) parts.push(`text:${label(event.textEvent.eventType)}`)
  if (event?.sysEvent) parts.push(`sys:${label(event.sysEvent.eventType)}`)
  if (event?.audioEvent) parts.push('audio')
  if (event?.jsonData) parts.push(`raw:${JSON.stringify(event.jsonData).slice(0, 80)}`)
  return parts.length ? parts.join(' ') : 'evento vazio'
}
