import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { classifyGlassEvent, summarizeGlassEvent } from './glassEvents'
import { fetchGlassTasks } from './glassApi'
import { mountUi, setStatus } from './ui'

mountUi()

// 0.2.0: read-only /glass/tasks. Sem STT, sem microfone — audioControl nunca é
// chamado e o stream STT não existe neste build (volta na fase de STT real).
// Diagnóstico de eventos SÓ em build explícito (VITE_GLASS_DIAG=1).
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

// Contador no header: cada refresh muda o display SEMPRE (anti-dedupe do
// lastRender — prova de vida validada no smoke). #1 = carga inicial do boot.
let refreshing = false
let refreshCount = 0

async function refreshTasks() {
  if (refreshing) return
  refreshing = true
  try {
    const tasks = await fetchGlassTasks(5)
    refreshCount++
    if (!tasks.ok) {
      currentContent = OFFLINE_TEXT
      setStatus('error', `Glass API: ${tasks.error ?? 'erro'}`)
    } else if (tasks.lines.length === 0) {
      currentContent = `TAREFAS #${refreshCount}\nNenhuma tarefa aberta.`
      setStatus('listening', `Tarefas atualizadas #${refreshCount}`)
    } else {
      currentContent = [`TAREFAS #${refreshCount}`, ...tasks.lines].join('\n')
      setStatus('listening', `Tarefas atualizadas #${refreshCount}`)
    }
  } catch (err) {
    // Fail-fast com retry por gatilho humano (tap) — nunca retry automático.
    currentContent = OFFLINE_TEXT
    setStatus('error', `Glass API: ${(err as Error)?.message ?? err}`)
    console.error('fetchGlassTasks failed:', err)
  } finally {
    refreshing = false
    scheduleGlassesRender()
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

let lastEventAt = 0

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (IS_DIAG) {
    lastEventAt = Date.now()
    console.log('EvenHub event:', event, summarizeGlassEvent(event))
  }

  switch (classifyGlassEvent(event)) {
    case 'click':
      if (!refreshing) {
        currentContent = 'Atualizando...'
        scheduleGlassesRender()
        void refreshTasks()
      }
      return

    case 'double_click':
      // Sem texto de despedida: rebuild (~200ms) nunca completa antes do
      // shutdown; exitMode 1 sobe a camada de interação do OS direto.
      cleanup()
      bridge.shutDownPageContainer(1)
      return

    case 'exit':
      cleanup()
      return

    case 'audio':
      // 0.2.0 não tem STT — microfone nunca é ligado; PCM residual é ignorado.
      return

    case 'lifecycle':
      // FOREGROUND_ENTER/EXIT não altera o display.
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
