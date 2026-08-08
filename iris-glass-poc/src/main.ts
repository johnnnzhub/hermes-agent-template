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
  wrapHudText,
  type ConversationPage,
} from './conversation'
import {
  AUDIO_SR,
  bytesToB64,
  cleanupMic,
  drainRecording,
  isAudible,
  isRecording,
  onAudioChunk,
  startRecording,
  stopRecording,
} from './voice'
import {
  clearPendingTurn,
  draftSummary,
  loadPendingTurn,
  savePendingTurn,
  type PendingTurn,
} from './pendingTurn'
import {
  MAX_POSTS,
  parkedDraft,
  reasonHeadline,
  reduce,
  settlePending,
  startSend,
  type SendEvent,
  type SendState,
} from './sendMachine'
import { isThinkingStuck, pollDelay, thinkingLabel } from './thinking'
import { mountUi, setPreview, setStatus } from './ui'
import { settleRenderAttempt, type RenderOutcome } from './renderState'

mountUi()

const IS_DIAG = (import.meta.env.VITE_GLASS_DIAG as string | undefined) === '1'
const INITIAL_TEXT = IS_DIAG
  ? `HERMES DIAG · v${__APP_VERSION__}`
  : `HERMES · v${__APP_VERSION__}`
const RECORDING_LIMIT_MS = 30_000

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
let renderFailures = 0
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
  let outcome: RenderOutcome = 'error'
  let timeoutHandle: number | null = null
  try {
    outcome = await Promise.race([
      bridge.rebuildPageContainer(new RebuildPageContainer(hudPayload(content))),
      new Promise<'timeout'>(resolve => {
        timeoutHandle = window.setTimeout(() => resolve('timeout'), RENDER_TIMEOUT_MS)
      }),
    ])
    if (outcome !== true && IS_DIAG) console.warn(`rebuildPageContainer not acknowledged: ${outcome}`)
  } catch (error) {
    if (IS_DIAG) console.error('rebuildPageContainer failed:', error)
  } finally {
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
    const settled = settleRenderAttempt(lastRender, content, outcome, renderFailures)
    lastRender = settled.lastConfirmed
    renderFailures = settled.failures
    renderInFlight = false
    window.setTimeout(() => {
      if (!hudDead && currentContent !== lastRender) scheduleGlassesRender()
    }, settled.confirmed ? RENDER_GAP_MS : settled.retryDelayMs)
  }
}

type LocalMode = 'loading' | 'history' | 'recording' | 'sending' | 'retry' | 'error'

let mode: LocalMode = 'loading'
let revision = ''
let remoteState: HermesSession['state'] = 'idle'
let progress: HermesProgress | null = null
let turns: HermesTurn[] = []
let pages: ConversationPage[] = []
let pageIndex = 0
let nextCursor: number | null = null
let notice = ''
let noticeTimer: number | null = null
let recordingTimer: number | null = null
let pollTimer: number | null = null
let refreshing = false
let sending = false
let loadingOlder = false
let micStarting = false

// Rascunho + maquina de entrega. `pending` e a fonte da verdade da fala capturada; o
// localStorage e best-effort e serve para o rascunho sobreviver a fechar o app.
let pending: PendingTurn | null = null
let sendState: SendState | null = null
let sendGen = 0
let waitTimer: number | null = null
let delivering = false
let lastProbe: HermesSession | null = null
// Inicio do periodo ocupado, para o contador e para o teto do PENSANDO.
let busySince = 0
// O que o servidor entendeu da fala, devolvido pelo 202.
let echo = ''

function busyElapsed(): number {
  return busySince ? Date.now() - busySince : 0
}

function workingContent(): string {
  const elapsed = busyElapsed()
  if (isThinkingStuck(elapsed)) return 'SEM RESPOSTA\nTOQUE PARA ATUALIZAR'
  if (remoteState === 'awaiting' || progress?.kind === 'awaiting') {
    return 'AGUARDANDO NO TERMINAL'
  }
  const base = progress?.kind === 'tool' ? progress.text.toUpperCase() : 'PENSANDO'
  const label = thinkingLabel(base, elapsed)
  // Eco do que o servidor entendeu: o transcript volta no 202 e ate a v0.4.3 era jogado
  // fora, entao a fala sumia da tela no instante em que era aceita.
  if (!echo) return label
  return [label, ...wrapHudText(`» ${echo}`).slice(0, 3)].join('\n')
}

function sendingContent(): string {
  if (sendState?.phase === 'wait') {
    return [
      `SEM REDE · TENTATIVA ${Math.min(sendState.attempts + 1, MAX_POSTS)} DE ${MAX_POSTS}`,
      'TOQUE = TENTAR AGORA',
    ].join('\n')
  }
  return 'ENVIANDO'
}

function retryContent(): string {
  if (!sendState || !pending) return emptyContent()
  return [
    reasonHeadline(sendState.reason),
    ...wrapHudText(`» ${draftSummary(pending)}`).slice(0, 3),
    'TOQUE = REENVIAR',
    'ROLAR PRA CIMA = DESCARTAR',
  ].join('\n')
}

function emptyContent(): string {
  return 'HERMES'
}

function contentForState(): string {
  if (mode === 'loading') return INITIAL_TEXT
  if (mode === 'recording') return 'OUVINDO'
  if (mode === 'sending') return sendingContent()
  if (mode === 'retry') return retryContent()
  if (mode === 'error') return notice || 'NÃO FOI POSSÍVEL CONTINUAR'
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

/** Estado de repouso: o rascunho pendente manda no HUD, se existir. */
function restingMode(): LocalMode {
  return pending && sendState?.phase === 'retry' ? 'retry' : 'history'
}

function showError(message: string) {
  // Entrega em curso manda no HUD: um erro de poll concorrente nao pode roubar a tela
  // de quem esta tentando salvar a fala do John.
  if (delivering) {
    setStatus('error', message)
    return
  }
  clearNoticeTimer()
  mode = 'error'
  notice = message
  setStatus('error', message)
  renderState()
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null
    if (mode !== 'error' || hudDead) return
    // Erro com rascunho nao vira historico: volta para a tela que oferece o reenvio.
    mode = restingMode()
    notice = ''
    renderState()
  }, 3_000)
}

/**
 * Pos-condicao do envio ambiguo. Quando o POST morreu e o probe so viu a sessao mexida,
 * quem decide se a fala entrou e a sessao de volta em idle. Nada de apagar rascunho por
 * palpite. (A fase 2 troca isto por GET /glass/hermes/turn/:clientMsgId, que responde
 * direto em vez de inferir.)
 */
function reconcilePending(snapshot: HermesSession) {
  if (!pending || sendState?.phase !== 'thinking') return
  const verdict = settlePending(pending, {
    state: snapshot.state,
    revision: snapshot.revision,
    turnCount: snapshot.turns.length,
  })
  if (verdict === 'pending') return
  if (verdict === 'delivered') {
    dropDraft()
    return
  }
  sendState = { ...parkedDraft(pending.expectedRevision), reason: 'network' }
}

function applySession(snapshot: HermesSession, focusLatest: boolean) {
  revision = snapshot.revision
  const wasIdle = remoteState === 'idle'
  remoteState = snapshot.state
  progress = snapshot.progress
  turns = snapshot.turns
  nextCursor = snapshot.nextCursor
  pages = buildConversationPages(turns)
  if (focusLatest) pageIndex = latestTurnFirstPage(pages)
  else pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1))

  if (snapshot.state === 'idle') {
    busySince = 0
    echo = ''
  } else if (wasIdle || !busySince) {
    busySince = Date.now()
  }

  reconcilePending(snapshot)

  // Gravacao e entrega mandam no HUD enquanto acontecem; um refresh concorrente
  // (foreground enter, poll) nao pode roubar a tela delas.
  if (mode !== 'sending' && mode !== 'recording') mode = restingMode()
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
  // 1,2 s so nos primeiros 30 s. Um turno longo nao merece 3.000 requisicoes por hora
  // num link que atravessa oculos, celular e tailnet.
  pollTimer = window.setTimeout(async () => {
    pollTimer = null
    if (hudDead) return
    await refreshSession(true)
    if (remoteState !== 'idle') schedulePoll()
  }, pollDelay(busyElapsed()))
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
  if (mode === 'recording' || mode === 'sending' || sending || micStarting || hudDead) return
  // Gravar por cima de um rascunho pendente destruiria a fala que ainda nao foi entregue.
  if (pending) return
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

function clearWaitTimer() {
  if (waitTimer !== null) {
    window.clearTimeout(waitTimer)
    waitTimer = null
  }
}

function dropDraft() {
  pending = null
  sendState = null
  clearWaitTimer()
  // Invalida qualquer continuacao de entrega ainda em voo.
  sendGen++
  clearPendingTurn()
}

function adoptDraft(pcm: Uint8Array, durMs: number): PendingTurn {
  const turn: PendingTurn = {
    clientMsgId: newMsgId(),
    pcmB64: bytesToB64(pcm),
    expectedRevision: revision,
    createdAt: Date.now(),
    durMs,
    attempts: 0,
    submitted: false,
    turnsAtSubmit: turns.length,
  }
  savePendingTurn(turn)
  return turn
}

async function postTurn(turn: PendingTurn): Promise<SendEvent> {
  try {
    const accepted = await sendVoiceTurn({
      pcmB64: turn.pcmB64,
      sampleRate: AUDIO_SR,
      channels: 1,
      bitDepth: 16,
      clientMsgId: turn.clientMsgId,
      expectedRevision: turn.expectedRevision,
    })
    return { kind: 'accepted', transcript: accepted.transcript }
  } catch (error) {
    // status 0 e a marca de rede/timeout: nao chegou. Qualquer outro status significa
    // que o servidor respondeu, e a resposta dele decide o caminho.
    if (error instanceof ApiError && error.status > 0) return { kind: 'http', status: error.status }
    return { kind: 'network' }
  }
}

async function probeSession(): Promise<SendEvent> {
  try {
    const snapshot = await fetchHermesSession()
    lastProbe = snapshot
    return { kind: 'probe', state: snapshot.state, revision: snapshot.revision }
  } catch {
    return { kind: 'probe-failed' }
  }
}

function armWait(ms: number, gen: number) {
  clearWaitTimer()
  waitTimer = window.setTimeout(() => {
    waitTimer = null
    if (gen !== sendGen || hudDead || !sendState) return
    sendState = reduce(sendState, { kind: 'timer' })
    void deliverPending()
  }, ms)
}

function applySendOutcome() {
  const state = sendState
  if (!state) return

  if (state.phase === 'thinking') {
    echo = state.transcript || echo
    if (state.clearDraft) dropDraft()
    remoteState = 'busy'
    progress = { kind: 'thinking', text: 'Pensando' }
    if (!busySince) busySince = Date.now()
    mode = 'history'
    setStatus('connecting', 'Executando')
    renderState()
    // Fora de qualquer try: ate a v0.4.3 o poll so era armado no caminho feliz, entao
    // uma falha de envio deixava o app cego para a resposta que estava a caminho.
    schedulePoll()
    if (lastProbe) applySession(lastProbe, true)
    return
  }

  if (state.phase === 'discarded') {
    const reason = state.reason
    dropDraft()
    mode = restingMode()
    showError(reasonHeadline(reason))
    return
  }

  if (state.phase === 'retry') {
    mode = 'retry'
    setStatus('error', reasonHeadline(state.reason))
    renderState()
    // Conflito exige revision fresca antes do proximo toque.
    if (state.needsRefresh) void refreshSession(true)
  }
}

async function deliverPending() {
  if (!pending || !sendState || delivering || hudDead) return
  delivering = true
  const gen = ++sendGen
  lastProbe = null
  let settled = false
  try {
    while (!hudDead && gen === sendGen && pending && sendState) {
      if (sendState.phase === 'post') {
        mode = 'sending'
        renderState()
        sendState = reduce(sendState, await postTurn(pending))
      } else if (sendState.phase === 'probe') {
        sendState = reduce(sendState, await probeSession())
      } else if (sendState.phase === 'wait') {
        mode = 'sending'
        renderState()
        // A espera sai do fluxo: um toque durante ela precisa poder encurtar o degrau.
        armWait(sendState.waitMs, gen)
        return
      } else {
        break
      }
    }
    settled = gen === sendGen
  } finally {
    delivering = false
  }
  // Fora do `delivering` para o showError do desfecho nao cair no proprio guarda.
  if (settled) applySendOutcome()
}

function retryNow() {
  if (!pending || !sendState) return
  if (sendState.phase !== 'retry' && sendState.phase !== 'wait') return
  clearWaitTimer()
  sendGen++
  let next = reduce(sendState, { kind: 'manual' })
  if (next.needsRefresh) {
    // A conversa mudou, entao este e um turno genuinamente novo: mexer na revision muda
    // o fingerprint do audio e o servidor devolveria 409 "clientMsgId ja foi utilizado".
    pending = {
      ...pending,
      clientMsgId: newMsgId(),
      expectedRevision: revision,
      turnsAtSubmit: turns.length,
      attempts: 0,
    }
    savePendingTurn(pending)
    next = startSend(revision)
  }
  sendState = next
  mode = 'sending'
  renderState()
  void deliverPending()
}

function discardDraft() {
  if (!pending) return
  dropDraft()
  echo = ''
  notice = ''
  mode = 'history'
  setStatus('listening', 'Pronto')
  renderState()
}

function restoreDraft() {
  if (pending || hudDead) return
  const saved = loadPendingTurn()
  if (!saved) return
  // Rascunho de uma sessao anterior nao sai sozinho: reenviar uma fala de minutos atras
  // sem aviso seria surpresa. Fica oferecido ate o toque.
  pending = saved
  sendState = parkedDraft(saved.expectedRevision)
  mode = 'retry'
  renderState()
}

async function finishRecording() {
  if (sending || !isRecording() || hudDead) return
  sending = true
  clearRecordingTimer()
  mode = 'sending'
  renderState()
  let captured = false
  try {
    const { pcm, durMs } = await stopRecording(bridge, false)
    if (!pcm) {
      mode = restingMode()
      showError('Não ouvi fala suficiente.')
    } else {
      // PRE-CONDICAO do envio: a fala vira artefato duravel antes da primeira chamada de
      // rede. Ate a v0.4.3 o PCM so existia neste escopo — qualquer falha o levava junto,
      // sem rastro no plugin nem no servidor.
      pending = adoptDraft(pcm, durMs)
      sendState = startSend(pending.expectedRevision)
      echo = ''
      captured = true
    }
  } catch {
    mode = restingMode()
    showError('Não consegui guardar a gravação.')
  } finally {
    sending = false
  }
  if (captured) await deliverPending()
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
  clearWaitTimer()
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
      if (mode === 'recording') {
        void finishRecording()
        return
      }
      // Rascunho parado ou esperando o degrau da escada: o toque reenvia agora.
      if (mode === 'retry' || mode === 'sending') {
        retryNow()
        return
      }
      // Passou do teto do PENSANDO: o toque busca a verdade em vez de gravar por cima.
      if (remoteState !== 'idle' && isThinkingStuck(busyElapsed())) {
        void refreshSession(true)
        return
      }
      void beginRecording()
      return
    case 'scroll_up':
      if (mode === 'retry') {
        discardDraft()
        return
      }
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
        // Ate a v0.4.3 este caminho chamava cleanupMic direto, que zerava o buffer: sair
        // do app no meio de uma frase destruia a fala em silencio. Agora drena primeiro.
        const captured = isRecording() ? drainRecording() : null
        void cleanupMic(bridge).then(() => {
          if (captured && isAudible(captured.pcm, captured.durMs) && !pending) {
            pending = adoptDraft(captured.pcm, captured.durMs)
            sendState = parkedDraft(pending.expectedRevision)
            mode = 'retry'
          } else if (mode === 'recording') {
            mode = restingMode()
          }
          renderState()
        })
      }
      if (isForegroundEnter(event)) void refreshSession(true).then(restoreDraft)
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
void refreshSession(true).then(restoreDraft)
