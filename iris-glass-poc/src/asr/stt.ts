// Speech-to-text client for the G2 microphone.
//
// The G2 mic emits PCM s16le @ 16 kHz mono via `bridge.audioControl(true)`.
// This PoC keeps a safe default mock mode so the app builds and can be tested
// before choosing a paid/cloud STT provider.

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

export function startSttStream(
  apiKey: string | undefined,
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
): SttClient {
  const provider = (import.meta.env.VITE_STT_PROVIDER as string | undefined) || 'mock'

  if (provider !== 'mock') {
    onError?.(
      new Error(
        `STT provider "${provider}" not wired yet. Use VITE_STT_PROVIDER=mock or implement provider logic here.`,
      ),
    )
  }

  let bytes = 0
  let closed = false
  let emitted = false

  const emitMock = () => {
    if (closed || emitted) return
    emitted = true
    const text = apiKey?.startsWith('mock:') ? apiKey.slice('mock:'.length) : 'listar próximas tarefas'
    onSnapshot({ finalText: text, interimText: '', finished: true })
  }

  // Desktop/simulator without real mic: emit a deterministic command shortly after startup.
  const timer = window.setTimeout(emitMock, 1200)

  return {
    sendPcm(chunk: Uint8Array) {
      if (closed) return
      bytes += chunk.byteLength
      onSnapshot({ finalText: '', interimText: `ouvindo... ${Math.round(bytes / 1024)} KB`, finished: false })
      if (bytes > 16_000) emitMock()
    },
    close() {
      closed = true
      window.clearTimeout(timer)
    },
  }
}
