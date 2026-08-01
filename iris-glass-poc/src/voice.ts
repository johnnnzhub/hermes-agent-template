export const AUDIO_SR = 16_000
const MIN_REC_MS = 800
const MIN_RMS = 0.006

type Bridge = Awaited<ReturnType<typeof import('@evenrealities/even_hub_sdk').waitForEvenAppBridge>>

let pcmChunks: Uint8Array[] = []
let pcmLen = 0
let recording = false

export function isRecording(): boolean {
  return recording
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
  const ok = await audioControl(bridge, true, false)
  if (!ok) recording = false
  return ok
}

export async function stopRecording(
  bridge: Bridge | null,
  mock = false,
): Promise<{ pcm: Uint8Array | null; durMs: number }> {
  recording = false
  if (bridge && !mock) await audioControl(bridge, false, true)
  const pcm = new Uint8Array(pcmLen)
  let offset = 0
  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  pcmChunks = []
  pcmLen = 0
  const durMs = (pcm.length / (AUDIO_SR * 2)) * 1_000
  if (mock) return { pcm: pcm.length ? pcm : new Uint8Array(1_600), durMs: 2_000 }
  if (durMs < MIN_REC_MS || pcmRms(pcm) < MIN_RMS) return { pcm: null, durMs }
  return { pcm, durMs }
}

export async function cleanupMic(bridge: Bridge | null): Promise<void> {
  if (!recording) return
  recording = false
  pcmChunks = []
  pcmLen = 0
  if (bridge) await audioControl(bridge, false, true)
}

