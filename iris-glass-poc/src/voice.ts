export const AUDIO_SR = 16_000
const MIN_REC_MS = 800
const MIN_RMS = 0.006

type Bridge = Awaited<ReturnType<typeof import('@evenrealities/even_hub_sdk').waitForEvenAppBridge>>

let pcmChunks: Uint8Array[] = []
let pcmLen = 0
let recording = false
// Estado do hardware, separado de `recording`. Drenar a fala (drainRecording) para de
// aceitar chunks mas NAO desliga o microfone; sem esta flag o cleanup enxergaria
// `recording === false` e devolveria cedo, deixando o mic aberto.
let micOpen = false

export function isRecording(): boolean {
  return recording
}

export function hasCapturedAudio(): boolean {
  return pcmLen > 0
}

export function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[])
  if (typeof payload === 'string') {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return Uint8Array.from((payload as { data: number[] }).data)
  }
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  return new Uint8Array(0)
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function pcmRms(bytes: Uint8Array): number {
  const samples = Math.floor(bytes.length / 2)
  if (!samples) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  let sumSquares = 0
  for (let index = 0; index < samples; index++) {
    const sample = view.getInt16(index * 2, true) / 32_768
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / samples)
}

export function onAudioChunk(pcm: unknown): void {
  if (!recording) return
  const bytes = toBytes(pcm)
  if (!bytes.length) return
  pcmChunks.push(bytes)
  pcmLen += bytes.length
}

function audioControl(bridge: Bridge, enabled: boolean, fallback: boolean): Promise<boolean> {
  return Promise.race([
    bridge.audioControl(enabled).catch(() => false),
    new Promise<boolean>(resolve => setTimeout(() => resolve(fallback), 2_000)),
  ])
}

export async function startRecording(bridge: Bridge | null, mock = false): Promise<boolean> {
  pcmChunks = []
  pcmLen = 0
  recording = true
  if (mock || !bridge) return true
  // micOpen liga ao PEDIR: se o audioControl estourar os 2 s de race, o hardware pode
  // ter ligado mesmo assim, e vazar o microfone e pior que um desligamento redundante.
  micOpen = true
  const ok = await audioControl(bridge, true, false)
  if (!ok) recording = false
  return ok
}

/**
 * Retira a fala do buffer sem mexer no microfone. Existe para o caminho de saida de
 * foreground: ate a v0.4.3 esse caminho chamava cleanupMic direto e a gravacao em curso
 * era destruida em silencio, sem aviso e sem chance de recuperacao.
 */
export function drainRecording(): { pcm: Uint8Array; durMs: number } {
  recording = false
  const pcm = new Uint8Array(pcmLen)
  let offset = 0
  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  pcmChunks = []
  pcmLen = 0
  return { pcm, durMs: (pcm.length / (AUDIO_SR * 2)) * 1_000 }
}

export function isAudible(pcm: Uint8Array, durMs: number): boolean {
  return durMs >= MIN_REC_MS && pcmRms(pcm) >= MIN_RMS
}

export async function stopRecording(
  bridge: Bridge | null,
  mock = false,
): Promise<{ pcm: Uint8Array | null; durMs: number }> {
  recording = false
  if (bridge && !mock) {
    await audioControl(bridge, false, true)
    micOpen = false
  }
  const { pcm, durMs } = drainRecording()
  if (mock) return { pcm: pcm.length ? pcm : new Uint8Array(1_600), durMs: 2_000 }
  if (!isAudible(pcm, durMs)) return { pcm: null, durMs }
  return { pcm, durMs }
}

/**
 * Fecha o microfone. NAO descarta a fala capturada — quem tira do buffer e
 * drainRecording, e so ele. Enquanto isto zerava o buffer, todo caminho de saida
 * (double_click, ABNORMAL_EXIT, beforeunload, e a janela de ate 2 s em que stopRecording
 * espera o hardware) destruia a gravacao em silencio. O buffer sobrevive ate o proximo
 * startRecording, que sempre comeca limpo.
 */
export async function cleanupMic(bridge: Bridge | null): Promise<void> {
  recording = false
  if (!micOpen) return
  micOpen = false
  if (bridge) await audioControl(bridge, false, true)
}

/** Descarte explicito do buffer, para quando a fala realmente nao serve mais. */
export function discardCapture(): void {
  recording = false
  pcmChunks = []
  pcmLen = 0
}

