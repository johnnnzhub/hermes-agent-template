import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIO_SR,
  bytesToB64,
  cleanupMic,
  discardCapture,
  drainRecording,
  hasCapturedAudio,
  isAudible,
  isRecording,
  onAudioChunk,
  pcmRms,
  startRecording,
  stopRecording,
  toBytes,
} from '../src/voice.ts'

function fakeBridge({ delayMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    async audioControl(enabled) {
      calls.push(enabled)
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      return true
    },
  }
}

function tone(durationMs = 1_000, amplitude = 4_000) {
  const samples = Math.floor((AUDIO_SR * durationMs) / 1_000)
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples; index++) {
    view.setInt16(index * 2, index % 2 ? amplitude : -amplitude, true)
  }
  return bytes
}

test('normalizes the G2 audio wire shapes and preserves base64 bytes', () => {
  const source = Uint8Array.from([0, 1, 127, 128, 255])
  const encoded = bytesToB64(source)
  assert.deepEqual([...toBytes(encoded)], [...source])
  assert.deepEqual([...toBytes({ data: [...source] })], [...source])
  assert.deepEqual([...toBytes([...source])], [...source])
})

test('RMS gate rejects silence and accepts audible PCM', () => {
  assert.equal(pcmRms(new Uint8Array(3_200)), 0)
  assert.ok(pcmRms(tone()) > 0.006)
})

test('recording accumulates chunks and returns only audible recordings', async () => {
  await startRecording(null)
  assert.equal(isRecording(), true)
  onAudioChunk(tone(500))
  onAudioChunk(tone(500))
  const audible = await stopRecording(null)
  assert.equal(audible.durMs, 1_000)
  assert.ok(audible.pcm)

  await startRecording(null)
  onAudioChunk(new Uint8Array(AUDIO_SR * 2))
  const silent = await stopRecording(null)
  assert.equal(silent.pcm, null)
})

test('drainRecording tira a fala do buffer sem mexer no microfone', async () => {
  const bridge = fakeBridge()
  await startRecording(bridge)
  onAudioChunk(tone(1_000))
  assert.equal(hasCapturedAudio(), true)

  const drained = drainRecording()
  assert.equal(drained.durMs, 1_000)
  assert.equal(isAudible(drained.pcm, drained.durMs), true)
  assert.equal(isRecording(), false)
  assert.equal(hasCapturedAudio(), false)
  assert.deepEqual(bridge.calls, [true])
})

// Antes de separar `micOpen` de `recording`, o cleanup enxergava `recording === false`
// depois do drain e devolvia cedo — o microfone ficava aberto ate o app morrer.
test('o cleanup fecha o microfone mesmo depois de a fala ja ter sido drenada', async () => {
  const bridge = fakeBridge()
  await startRecording(bridge)
  onAudioChunk(tone(1_000))
  drainRecording()

  await cleanupMic(bridge)
  assert.deepEqual(bridge.calls, [true, false])

  // Segunda chamada nao repete o desligamento.
  await cleanupMic(bridge)
  assert.deepEqual(bridge.calls, [true, false])
})

test('stopRecording desliga o microfone uma vez so', async () => {
  const bridge = fakeBridge()
  await startRecording(bridge)
  onAudioChunk(tone(1_000))
  await stopRecording(bridge)
  await cleanupMic(bridge)
  assert.deepEqual(bridge.calls, [true, false])
})


// Os dois caminhos que o Codex achou em 2026-08-08: fechar o microfone NAO pode destruir
// a fala. Antes, cleanupMic zerava o buffer, entao double_click, ABNORMAL_EXIT e
// beforeunload apagavam a gravacao em curso sem deixar rastro.
test('fechar o microfone preserva a fala para quem for drenar depois', async () => {
  const bridge = fakeBridge()
  await startRecording(bridge)
  onAudioChunk(tone(1_000))

  await cleanupMic(bridge)
  assert.deepEqual(bridge.calls, [true, false])
  assert.equal(hasCapturedAudio(), true)

  const drained = drainRecording()
  assert.equal(drained.durMs, 1_000)
  assert.equal(isAudible(drained.pcm, drained.durMs), true)
})

// stopRecording zera `recording` ANTES de esperar ate 2 s pelo hardware. Uma saida de
// foreground nessa janela via "nao esta gravando" e o cleanup levava o PCM junto.
test('a fala sobrevive a uma saida na janela entre parar e drenar', async () => {
  // O hardware demora a confirmar: e dentro desta espera que a saida chegava.
  const bridge = fakeBridge({ delayMs: 50 })
  await startRecording(bridge)
  onAudioChunk(tone(1_000))

  const stopping = stopRecording(bridge, false)
  // Quem sai nao consulta isRecording() — que ja e false aqui —, consulta se ha audio.
  assert.equal(isRecording(), false)
  assert.equal(hasCapturedAudio(), true)

  // Ordem do app: guardar a fala e sincrono e vem ANTES de fechar o microfone.
  const rescued = drainRecording()
  assert.equal(rescued.durMs, 1_000)
  assert.equal(isAudible(rescued.pcm, rescued.durMs), true)
  await cleanupMic(bridge)

  // stopRecording termina de mãos vazias, e isso e esperado: a fala ja foi salva.
  const late = await stopping
  assert.equal(late.pcm, null)
})

test('o descarte explicito continua limpando o buffer', async () => {
  await startRecording(null)
  onAudioChunk(tone(1_000))
  discardCapture()
  assert.equal(hasCapturedAudio(), false)
  assert.equal(isRecording(), false)
})
