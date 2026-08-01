import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIO_SR,
  bytesToB64,
  isRecording,
  onAudioChunk,
  pcmRms,
  startRecording,
  stopRecording,
  toBytes,
} from '../src/voice.ts'

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

