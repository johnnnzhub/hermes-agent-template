import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { classifyGlassEvent, summarizeGlassEvent } from './glassEvents'
import { fetchGlassTasks, taskDone, taskSnooze, newMsgId } from './glassApi'
import { initialState, reduce, type GlassEffect, type GlassInput, type GlassState } from './glassState'
import { mountUi, setStatus } from './ui'

mountUi()

// v0.3.0: lista + ações (done/snooze) por gesto. Conversa com a Iris = canal
// BYOA nativo do Even Hub (sem STT/mic neste plugin — decisão da PO).
const IS_DIAG = (import.meta.env.VITE_GLASS_DIAG as string | undefined) === '1'
// Versão no texto inicial = prova anti-cache (Even Hub pode cachear update in-place).
const INITIAL_TEXT = IS_DIAG
  ? `Iris DIAG v${__APP_VERSION__} · buscando tarefas...`
  : `Iris v${__APP_VERSION__} · buscando tarefas...`
const OFFLINE_TEXT = 'Sem conexão com a Iris. Toque para tentar de novo.'

const bridge = await waitForEvenAppBridge()

// Container SEMPRE completo, com isEventCapture:1 re-afirmado: textContainerUpgrade
// não tem isEventCapture e mata a captura de eventos no primeiro update (pitfall
// documentado — incidente v0.1.5).
function hudPayload(content: string) {
  return {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 1,
        containerName: 'iris',
        content,
        isEventCapture: 1,
      }),
    ],
  }
}

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(hudPayload(INITIAL_TEXT)),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

// Render engine (padrão dos plugins G2 vivos): create UMA vez no boot; toda
// atualização = rebuildPageContainer com o container completo. rebuild não é
// thread-safe (~200ms): gate + coalesce + timeout 1500ms + gap 250ms + fence.
const RENDER_TIMEOUT_MS = 1500
const RENDER_GAP_MS = 250
let lastRender = INITIAL_TEXT
let renderTimer: number | null = null
let renderInFlight = false
let hudDead = false
let currentContent = INITIAL_TEXT

function scheduleGlassesRender() {
  if (renderTimer !== null || hudDead) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    void renderNow()
  }, 120)
}

async function renderNow() {
  if (hudDead || renderInFlight || currentContent === lastRender) return
  renderInFlight = true
  const content = currentContent
  try {
    const result = await Promise.race([
      bridge.rebuildPageContainer(new RebuildPageContainer(hudPayload(content))).then(() => 'ok' as const),
      new Promise<'timeout'>(resolve => window.setTimeout(() => resolve('timeout'), RENDER_TIMEOUT_MS)),
    ])
    if (result === 'timeout' && IS_DIAG) console.warn('rebuildPageContainer timeout')
    lastRender = content
  } catch (err) {
    if (IS_DIAG) console.error('rebuildPageContainer failed:', err)
  } finally {
    renderInFlight = false
    window.setTimeout(() => {
      if (!hudDead && currentContent !== lastRender) scheduleGlassesRender()
    }, RENDER_GAP_MS)
  }
}

// ── Estado → display (escritor ÚNICO de currentContent) ─────────────────────

let state: GlassState = initialState()

function contentFor(s: GlassState): string {
  if (s.screen === 'busy') return s.busyKind === 'snooze' ? 'Adiando...' : 'Concluindo...'
  if (s.screen === 'action' && s.action) {
    return [
      'CONCLUIR TAREFA?',
      s.action.line,
      '',
      'tap = concluir',
      'scroll = adiar +1 dia',
      '2 toques = voltar',
    ].join('\n')
  }
  if (!s.loaded) return INITIAL_TEXT
  if (s.notice) return `${s.notice}\nAtualizando...`
  if (s.offline) return OFFLINE_TEXT
  if (s.tasks.length === 0) return `TAREFAS #${s.refreshCount}\nNenhuma tarefa aberta.`
  const rows = s.tasks.map((t, i) =>
    i === s.focusIdx ? '> ' + t.line.replace(/^»\s?/, '') : t.line,
  )
  return [`TAREFAS #${s.refreshCount}`, ...rows].join('\n')
}

// Guard de entrada da ACTION (350ms): tap/scroll residual do firmware logo
// após abrir a tela de ação não pode virar done/snooze acidental.
const ACTION_ENTRY_GUARD_MS = 350
let actionEnteredAt = 0

function dispatch(input: GlassInput) {
  const prevScreen = state.screen
  const { state: next, effects } = reduce(state, input)
  state = next
  if (prevScreen !== 'action' && next.screen === 'action') actionEnteredAt = Date.now()
  currentContent = contentFor(state)
  scheduleGlassesRender()
  for (const e of effects) runEffect(e)
}

function runEffect(effect: GlassEffect) {
  switch (effect) {
    case 'refresh':
      void refreshTasks()
      return
    case 'post_done':
      void performAction('done')
      return
    case 'post_snooze':
      void performAction('snooze')
      return
    case 'exit':
      cleanup()
      bridge.shutDownPageContainer(1)
      return
  }
}

let refreshing = false
async function refreshTasks() {
  if (refreshing || hudDead) return
  refreshing = true
  try {
    const res = await fetchGlassTasks(5)
    const tasks = res.ok ? res.lines.map((line, i) => ({ id: res.ids[i] ?? '', line })) : []
    dispatch({ type: 'tasks', ok: res.ok, tasks })
    setStatus(res.ok ? 'listening' : 'error', res.ok ? `Tarefas #${state.refreshCount}` : `Glass API: ${res.error ?? 'erro'}`)
  } catch (err) {
    dispatch({ type: 'tasks', ok: false, tasks: [] })
    setStatus('error', `Glass API: ${(err as Error)?.message ?? err}`)
    console.error('fetchGlassTasks failed:', err)
  } finally {
    refreshing = false
  }
}

let actionInFlight = false
async function performAction(kind: 'done' | 'snooze') {
  if (actionInFlight) return
  const target = state.action
  if (!target || !target.id) {
    dispatch({ type: 'action_result', kind, ok: false, already: false, gone: true, gen: state.gen })
    return
  }
  actionInFlight = true
  const g = state.gen
  // msgId gerado UMA vez — estável nos retries → dedup no gateway (2× = no-op).
  const msgId = newMsgId()
  try {
    const res = kind === 'done' ? await taskDone(target.id, msgId) : await taskSnooze(target.id, msgId)
    dispatch({
      type: 'action_result',
      kind,
      ok: res.ok,
      already: res.already === true,
      gone: res.gone === true,
      error: res.error,
      gen: g,
    })
  } catch (err) {
    dispatch({ type: 'action_result', kind, ok: false, already: false, gone: false, gen: g })
    console.error('performAction failed:', err)
  } finally {
    actionInFlight = false
  }
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  hudDead = true
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer)
    renderTimer = null
  }
  unsubscribe()
}

// FOREGROUND_ENTER (4) dispara refresh silencioso; FOREGROUND_EXIT (5) não.
function isForegroundEnter(event: any): boolean {
  return [
    event?.listEvent?.eventType,
    event?.textEvent?.eventType,
    event?.sysEvent?.eventType,
  ].some(v => v === 4 || v === '4' || v === 'FOREGROUND_ENTER_EVENT' || v === 'FOREGROUND_ENTER')
}

const SCROLL_DEDUPE_MS = 200
let lastScrollAt = 0
let lastEventAt = 0

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (IS_DIAG) {
    lastEventAt = Date.now()
    console.log('EvenHub event:', event, summarizeGlassEvent(event))
  }

  const action = classifyGlassEvent(event)

  // Firmware duplica scroll (sysEvent + textEvent em callbacks separados):
  // dedupe global de 200ms — um gesto físico = um passo.
  if (action === 'scroll_up' || action === 'scroll_down') {
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_DEDUPE_MS) return
    lastScrollAt = now
  }

  // Guard de entrada da ACTION: descarta tap/scroll nos primeiros 350ms.
  if (
    state.screen === 'action' &&
    (action === 'click' || action === 'scroll_up' || action === 'scroll_down') &&
    Date.now() - actionEnteredAt < ACTION_ENTRY_GUARD_MS
  ) {
    return
  }

  switch (action) {
    case 'click':
    case 'scroll_up':
    case 'scroll_down':
    case 'double_click':
      dispatch({ type: action })
      return

    case 'exit':
      cleanup()
      return

    case 'audio':
      // Sem STT neste plugin — PCM residual é ignorado.
      return

    case 'lifecycle':
      if (isForegroundEnter(event)) dispatch({ type: 'foreground' })
      return

    default:
      if (IS_DIAG) {
        currentContent = `Evento: ${summarizeGlassEvent(event).slice(0, 240)}`
        scheduleGlassesRender()
      } else {
        console.log('Unknown EvenHub event', event)
      }
      return
  }
})

// Watchdog SÓ no build DIAG: sem nenhum evento em 8s, o problema é captura de
// entrada no Even Hub, não app logic.
if (IS_DIAG) {
  window.setTimeout(() => {
    if (lastEventAt === 0) {
      currentContent = 'Sem evento de toque. Tente R1/toque direito.'
      scheduleGlassesRender()
    }
  }, 8000)
}

window.addEventListener('beforeunload', cleanup)

// Carga inicial (#1). Erro cai no OFFLINE_TEXT com retry por tap.
void refreshTasks()
