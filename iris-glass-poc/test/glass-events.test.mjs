import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyGlassEvent } from '../src/glassEvents.ts'

// Pitfall protobuf: valor 0 omitido — container interativo presente sem
// eventType é o formato real do tap no device.
test('container presente sem eventType → click (protobuf omite 0)', () => {
  assert.equal(classifyGlassEvent({ sysEvent: {} }), 'click')
  assert.equal(classifyGlassEvent({ textEvent: {} }), 'click')
  assert.equal(classifyGlassEvent({ listEvent: {} }), 'click')
})

test('eventType explícito de click, número ou string → click', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 0 } }), 'click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: '0' } }), 'click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'CLICK_EVENT' } }), 'click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'CLICK' } }), 'click')
  assert.equal(classifyGlassEvent({ textEvent: { eventType: 0 } }), 'click')
})

test('double click, número ou string → double_click', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 3 } }), 'double_click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'DOUBLE_CLICK_EVENT' } }), 'double_click')
  assert.equal(classifyGlassEvent({ textEvent: { eventType: '3' } }), 'double_click')
})

test('lifecycle (FOREGROUND_ENTER/EXIT) nunca vira click', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 4 } }), 'lifecycle')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 5 } }), 'lifecycle')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'FOREGROUND_ENTER_EVENT' } }), 'lifecycle')
})

test('exit (6/7) → exit', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 6 } }), 'exit')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 7 } }), 'exit')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'SYSTEM_EXIT_EVENT' } }), 'exit')
})

test('audioEvent → audio, nunca click (mesmo sem eventType)', () => {
  assert.equal(classifyGlassEvent({ audioEvent: { audioPcm: new Uint8Array(4) } }), 'audio')
  assert.equal(classifyGlassEvent({ audioEvent: {} }), 'audio')
})

test('jsonData com Event_Type → classifica igual', () => {
  assert.equal(classifyGlassEvent({ jsonData: { Event_Type: 0 } }), 'click')
  assert.equal(classifyGlassEvent({ jsonData: { Event_Type: 4 } }), 'lifecycle')
  assert.equal(classifyGlassEvent({ jsonData: { eventType: 'CLICK_EVENT' } }), 'click')
  assert.equal(classifyGlassEvent({ jsonData: { EventType: 3 } }), 'double_click')
})

test('scroll (1/2) e IMU (8) não viram click → unknown', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 1 } }), 'unknown')
  assert.equal(classifyGlassEvent({ textEvent: { eventType: 2 } }), 'unknown')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 8 } }), 'unknown')
})

test('evento vazio/nulo/desconhecido → unknown', () => {
  assert.equal(classifyGlassEvent(undefined), 'unknown')
  assert.equal(classifyGlassEvent(null), 'unknown')
  assert.equal(classifyGlassEvent({}), 'unknown')
  assert.equal(classifyGlassEvent({ jsonData: { foo: 'bar' } }), 'unknown')
})

// SDK fromJson aceita forma longa E curta dos enums string.
test('formas curtas dos enums (sem sufixo _EVENT) classificam igual', () => {
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'DOUBLE_CLICK' } }), 'double_click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'SYSTEM_EXIT' } }), 'exit')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'ABNORMAL_EXIT' } }), 'exit')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'FOREGROUND_ENTER' } }), 'lifecycle')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 'FOREGROUND_EXIT' } }), 'lifecycle')
})

test('jsonData como string JSON não parseada → classifica; string inválida → unknown', () => {
  assert.equal(classifyGlassEvent({ jsonData: '{"Event_Type":0}' }), 'click')
  assert.equal(classifyGlassEvent({ jsonData: '{"Event_Type":4}' }), 'lifecycle')
  assert.equal(classifyGlassEvent({ jsonData: 'not json' }), 'unknown')
})

// Firmware pode duplicar um gesto em containers distintos no mesmo callback.
// Precedência blindada: double > exit > click > lifecycle (exit ganha de
// click — payload combinado nunca dispara comando em vez de encerrar).
test('containers simultâneos respeitam precedência', () => {
  assert.equal(classifyGlassEvent({ textEvent: { eventType: 0 }, sysEvent: { eventType: 3 } }), 'double_click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 4 }, textEvent: { eventType: 0 } }), 'click')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 7 }, textEvent: { eventType: 0 } }), 'exit')
  assert.equal(classifyGlassEvent({ sysEvent: { eventType: 6 }, textEvent: {} }), 'exit')
})
