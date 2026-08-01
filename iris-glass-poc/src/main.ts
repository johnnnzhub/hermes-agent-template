import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { classifyGlassEvent, summarizeGlassEvent } from './glassEvents'
import {
  ApiError,
  fetchHermesSession,
  newMsgId,
  sendVoiceTurn,
  type HermesProgress,
  type HermesSession,
  type HermesTurn,
} from './glassApi'
import {
  buildConversationPages,
  latestTurnFirstPage,
  mergeOlderTurns,
  type ConversationPage,
} from './conversation'
import {
  AUDIO_SR,
  bytesToB64,
  cleanupMic,
  isRecording,
  onAudioChunk,
  startRecording,
  stopRecording,
} from './voice'
import { mountUi, setPreview, setStatus } from './ui'

mountUi()

const IS_DIAG = (import.meta.env.VITE_GLASS_DIAG as string | undefined) === '1'
const INITIAL_TEXT = IS_DIAG
  ? `HERMES DIAG v${__APP_VERSION__} · conectando...`
  : `HERMES v${__APP_VERSION__} · conectando...`
const RECORDING_LIMIT_MS = 30_000
const POLL_MS = 1_200

const bridge = await waitForEvenAppBridge()

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
        containerName: 'hermes',
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
  setStatus('error', `Falha ao abrir o HUD: ${created}`)
  console.error('Failed to create startup page')
}

const RENDER_TIMEOUT_MS = 1_500
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
  } catch (error) {
    if (IS_DIAG) console.error('rebuildPageContainer failed:', error)
  } finally {
    renderInFlight = false
    window.setTimeout(() => {
      if (!hudDead && currentContent !== lastRender) scheduleGlassesRender()
    }, RENDER_GAP_MS)
  }
}

type LocalMode = 'loading' | 'history' | 'recording' | 'sending' | 'error'

let mode: LocalMode = 'loading'
let revision = ''
let remoteState: HermesSession['state'] = 'idle'
let progress: HermesProgress | null = null
let turns: HermesTurn[] = []
let pages: ConversationPage[] = []
let pageIndex = 0
let nextCursor: number | null = null
let lastTranscript = ''
let notice = ''
let noticeTimer: number | null = null
let recordingTimer: number | null = null
let pollTimer: number | null = null
let refreshing = false
let sending = false
let loadingOlder = false
let micStarting = false

function latestUser(): string {
  return lastTranscript || turns.at(-1)?.user || ''
}

function workingContent(): string {
  const status = progress?.text || (remoteState === 'awaiting' ? 'Aguardando no Terminal Mode' : 'Pensando')
  const question = latestUser()
  const questionLines = question ? question.replace(/\s+/g, ' ').trim().match(/.{1,43}(?:\s|$)|.{1,43}/g) ?? [] : []
  return [
    'HERMES · EXECUTANDO',
    status,
    '',
    ...(questionLines.length ? ['VOCE', ...questionLines.slice(0, 3)] : []),
    '',
    'Pode fechar: a execução continua.',
  ].join('\n')
}

function emptyContent(): string {
  return [
    `HERMES v${__APP_VERSION__}`,
    'Nenhuma conversa ainda.',
    '',
    'tap = falar',
    '2 toques = sair',
  ].join('\n')
}

function contentForState(): string {
  if (mode === 'loading') return INITIAL_TEXT
  if (mode === 'recording') {
    return ['HERMES · OUVINDO', '', 'tap = enviar', '2 toques = sair'].join('\n')
  }
  if (mode === 'sending') return ['HERMES', '', 'Transcrevendo e enviando...'].join('\n')
  if (mode === 'error') {
    return ['HERMES', '', notice || 'Não foi possível continuar.', '', 'tap = tentar novamente'].join('\n')
  }
  if (remoteState !== 'idle') return workingContent()
  if (!pages.length) return emptyContent()
  return pages[Math.min(pageIndex, pages.length - 1)].text
}

function renderState() {
  currentContent = contentForState()
  scheduleGlassesRender()
  setPreview(currentContent)
}

function clearNoticeTimer() {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer)
    noticeTimer = null
  }
}

function showError(message: string) {
  clearNoticeTimer()
  mode = 'error'
  notice = message
  setStatus('error', message)
  renderState()
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null
    if (mode !== 'error' || hudDead) return
    mode = 'history'
    notice = ''
    renderState()
  }, 3_000)
}

function applySession(snapshot: HermesSession, focusLatest: boolean) {
  revision = snapshot.revision
  remoteState = snapshot.state
  progress = snapshot.progress
  turns = snapshot.turns
  lastTranscript = turns.at(-1)?.user || ''
  nextCursor = snapshot.nextCursor
  pages = buildConversationPages(turns)
  if (focusLatest) pageIndex = latestTurnFirstPage(pages)
  else pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1))
  mode = 'history'
  setStatus(remoteState === 'idle' ? 'listening' : 'connecting', progress?.text || remoteState)
  renderState()
}

async function refreshSession(focusLatest = true) {
  if (refreshing || hudDead) return
  refreshing = true
  try {
    const snapshot = await fetchHermesSession()
    applySession(snapshot, focusLatest)
    if (snapshot.state !== 'idle') schedulePoll()
  } catch (error) {
    showError(error instanceof ApiError ? error.publicMessage : 'Sem conexão com o HERMES.')
  } finally {
    refreshing = false
  }
}

function clearPoll() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

function schedulePoll() {
  if (pollTimer !== null || hudDead) return
  pollTimer = window.setTimeout(async () => {
    pollTimer = null
    if (hudDead) return
    await refreshSession(true)
    if (remoteState !== 'idle') schedulePoll()
  }, POLL_MS)
}

async function loadOlder() {
  if (loadingOlder || nextCursor === null || hudDead) return
  loadingOlder = true
  try {
    const snapshot = await fetchHermesSession(nextCursor)
    const previousFirst = pages[0]?.key
    turns = mergeOlderTurns(turns, snapshot.turns)
    nextCursor = snapshot.nextCursor
    revision = snapshot.revision
    pages = buildConversationPages(turns)
    const priorIndex = previousFirst ? pages.findIndex(page => page.key === previousFirst) : 0
    pageIndex = Math.max(0, priorIndex - 1)
    renderState()
  } catch (error) {
    showError(error instanceof ApiError ? error.publicMessage : 'Não consegui carregar o histórico.')
  } finally {
    loadingOlder = false
  }
}

async function beginRecording() {
  if (mode === 'recording' || sending || micStarting || hudDead) return
  if (remoteState !== 'idle') {
    showError('A Iris já está trabalhando.')
    return
  }
  if (!revision) {
    await refreshSession()
    if (!revision || remoteState !== 'idle') return
  }
  clearNoticeTimer()
  micStarting = true
  let ok = false
  try {
    ok = await startRecording(bridge, false)
  } finally {
    micStarting = false
  }
  if (!ok) {
    showError('Não consegui abrir o microfone.')
    return
  }
  mode = 'recording'
  setStatus('listening', 'Ouvindo')
  renderState()
  recordingTimer = window.setTimeout(() => {
    recordingTimer = null
    void finishRecording()
  }, RECORDING_LIMIT_MS)
}

function clearRecordingTimer() {
  if (recordingTimer !== null) {
    window.clearTimeout(recordingTimer)
    recordingTimer = null
  }
}

async function finishRecording() {
  if (sending || !isRecording() || hudDead) return
  sending = true
  clearRecordingTimer()
  mode = 'sending'
  renderState()
  try {
    const { pcm } = await stopRecording(bridge, false)
    if (!pcm) {
      showError('Não ouvi fala suficiente.')
      return
    }
    const clientMsgId = newMsgId()
    const accepted = await sendVoiceTurn({
      pcmB64: bytesToB64(pcm),
      sampleRate: AUDIO_SR,
      channels: 1,
      bitDepth: 16,
      clientMsgId,
      expectedRevision: revision,
    })
    lastTranscript = accepted.transcript
    remoteState = 'busy'
    progress = { kind: 'thinking', text: 'Pensando' }
    mode = 'history'
    setStatus('connecting', 'Executando')
    renderState()
    schedulePoll()
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await refreshSession()
    }
    showError(error instanceof ApiError ? error.publicMessage : 'Não consegui enviar a mensagem.')
  } finally {
    sending = false
  }
}

function navigate(delta: -1 | 1) {
  if (mode !== 'history' || remoteState !== 'idle') return
  const target = pageIndex + delta
  if (target >= 0 && target < pages.length) {
    pageIndex = target
    renderState()
    return
  }
  if (delta < 0 && pageIndex === 0 && nextCursor !== null) void loadOlder()
}

let cleanedUp = false
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  hudDead = true
  clearPoll()
  clearRecordingTimer()
  clearNoticeTimer()
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer)
    renderTimer = null
  }
  await cleanupMic(bridge)
  unsubscribe()
}

function eventType(event: any): unknown[] {
  return [event?.listEvent?.eventType, event?.textEvent?.eventType, event?.sysEvent?.eventType]
}

function isForegroundEnter(event: any): boolean {
  return eventType(event).some(
    value => value === 4 || value === '4' || value === 'FOREGROUND_ENTER_EVENT' || value === 'FOREGROUND_ENTER',
  )
}

function isForegroundExit(event: any): boolean {
  return eventType(event).some(
    value => value === 5 || value === '5' || value === 'FOREGROUND_EXIT_EVENT' || value === 'FOREGROUND_EXIT',
  )
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
  if (action === 'scroll_up' || action === 'scroll_down') {
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_DEDUPE_MS) return
    lastScrollAt = now
  }

  switch (action) {
    case 'click':
      if (mode === 'recording') void finishRecording()
      else void beginRecording()
      return
    case 'scroll_up':
      navigate(-1)
      return
    case 'scroll_down':
      navigate(1)
      return
    case 'double_click':
      void cleanup().finally(() => bridge.shutDownPageContainer(1))
      return
    case 'exit':
      void cleanup()
      return
    case 'audio':
      onAudioChunk(event.audioEvent?.audioPcm)
      return
    case 'lifecycle':
      if (isForegroundExit(event)) {
        clearRecordingTimer()
        void cleanupMic(bridge).then(() => {
          if (mode === 'recording') {
            mode = 'history'
            renderState()
          }
        })
      }
      if (isForegroundEnter(event)) void refreshSession(true)
      return
    default:
      if (IS_DIAG) {
        currentContent = `Evento: ${summarizeGlassEvent(event).slice(0, 240)}`
        scheduleGlassesRender()
      }
  }
})

if (IS_DIAG) {
  window.setTimeout(() => {
    if (lastEventAt === 0) {
      currentContent = 'Sem evento de toque. Tente R1/toque direito.'
      scheduleGlassesRender()
    }
  }, 8_000)
}

window.addEventListener('beforeunload', () => void cleanup())
void refreshSession(true)
