import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { classifyGlassEvent, summarizeGlassEvent } from './glassEvents'
import { sendIntent, shortForDisplay } from './glassApi'
import { mountUi, setStatus, setTranscript } from './ui'

mountUi()

const API_KEY = import.meta.env.VITE_STT_API_KEY as string | undefined
const STT_PROVIDER = (import.meta.env.VITE_STT_PROVIDER as string | undefined) || 'mock'
const IS_MOCK_STT = STT_PROVIDER === 'mock'
// `|| fallback` cobre VITE_STT_API_KEY="mock:" (sufixo vazio) — sem isso o tap
// dispara handleFinalTranscript('') que retorna cedo e o display congela em
// 'Pensando...'.
const MOCK_COMMAND =
  (API_KEY?.startsWith('mock:') ? API_KEY.slice('mock:'.length) : '') ||
  'listar próximas tarefas'
// Diagnóstico de eventos SÓ em build explícito (VITE_GLASS_DIAG=1 npm run build).
// No build final a flag vira constante false e o Vite/Rollup elimina todo o
// caminho de diag do bundle (strings de evento inclusive).
const IS_DIAG = (import.meta.env.VITE_GLASS_DIAG as string | undefined) === '1'
// Versão no texto inicial = prova anti-cache: se o display mostra a versão
// esperada, o Even Hub carregou o binário novo (update in-place pode cachear).
const INITIAL_TEXT = IS_DIAG
  ? `Iris DIAG v${__APP_VERSION__}. Toque para testar.`
  : `Iris v${__APP_VERSION__} pronta. Toque para testar.`
const bridge = await waitForEvenAppBridge()

// Container SEMPRE completo, com isEventCapture:1 re-afirmado: o SDK não tem
// isEventCapture no TextContainerUpgrade (patch de conteúdo) — usar upgrade
// mata a captura de eventos no primeiro update (causa raiz do freeze v0.1.5).
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

// Render engine (padrão dos plugins G2 vivos — HQ/Cortex/Briefing): create UMA
// vez no boot; toda atualização = rebuildPageContainer com o container completo.
// rebuild não é thread-safe (~200ms): gate renderInFlight + coalesce + timeout
// 1500ms + gap 250ms entre rebuilds + fence hudDead (nunca rebuildar pós-shutdown).
const RENDER_TIMEOUT_MS = 1500
const RENDER_GAP_MS = 250
let lastRender = INITIAL_TEXT
let renderTimer: number | null = null
let renderInFlight = false
let hudDead = false
let currentContent = INITIAL_TEXT
let processing = false
let responseCount = 0

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

async function handleFinalTranscript(text: string) {
  if (processing || !text.trim()) return
  processing = true
  currentContent = 'Pensando...'
  scheduleGlassesRender()

  try {
    const response = await sendIntent({ transcript: text, source: 'g2' })
    // Contador por resposta: cada tap muda o display SEMPRE (sem ele, respostas
    // idênticas são deduplicadas pelo lastRender e o app parece congelado).
    responseCount++
    currentContent = shortForDisplay(`${response.glass_short} #${responseCount}`)
    setStatus('listening', `Iris respondeu · ${response.action || 'intent'}`)
  } catch (err) {
    currentContent = 'Falhei. Enviei detalhes ao telefone.'
    setStatus('error', `Glass API error: ${(err as Error)?.message ?? err}`)
    console.error('Glass API error:', err)
  } finally {
    processing = false
    scheduleGlassesRender()
  }
}

// Em modo mock, o smoke test não depende de microfone/PCM: nem instancia o
// stream STT (o timer interno dele auto-emitiria o comando 1.2s após abrir).
const stt = IS_MOCK_STT
  ? null
  : startSttStream(
      API_KEY,
      ({ finalText, interimText, finished }) => {
        const combined = (finalText + interimText).trim()
        currentContent = combined ? shortForDisplay(combined) : 'Ouvindo...'
        setTranscript(finalText, interimText)
        scheduleGlassesRender()

        if (finished) {
          void handleFinalTranscript(finalText.trim())
        }
      },
      err => {
        setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
        console.error('STT error:', err)
      },
    )

if (!IS_MOCK_STT) {
  await bridge.audioControl(true)
  setStatus('listening', 'Microfone ativo · double tap sai')
} else {
  setStatus('listening', 'Mock ativo · toque para testar')
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
  if (!IS_MOCK_STT) bridge.audioControl(false)
  stt?.close()
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
      if (IS_MOCK_STT) {
        currentContent = 'Pensando...'
        scheduleGlassesRender()
        void handleFinalTranscript(MOCK_COMMAND)
      } else {
        currentContent = 'Ouvindo...'
        scheduleGlassesRender()
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
      // Em mock não há STT — PCM é ignorado (nunca renderizar audio/interim).
      if (!IS_MOCK_STT) {
        const pcm = event.audioEvent?.audioPcm
        if (pcm && stt) stt.sendPcm(pcm)
      }
      return

    case 'lifecycle':
      // FOREGROUND_ENTER/EXIT não altera o display.
      return

    default:
      // Build final: evento desconhecido é silencioso (só console).
      // Só o build DIAG mostra o resumo no display.
      if (IS_DIAG) {
        currentContent = `Evento: ${shortForDisplay(summarizeGlassEvent(event))}`
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
