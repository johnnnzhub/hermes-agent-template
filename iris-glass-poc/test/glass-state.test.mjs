import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/glassState.ts'

const TASKS = [
  { id: 'a', line: '» Tarefa A' },
  { id: 'b', line: '» Tarefa B' },
  { id: 'c', line: '» Tarefa C' },
]

function loaded(overrides = {}) {
  const { state } = reduce(initialState(), { type: 'tasks', ok: true, tasks: TASKS })
  return { ...state, ...overrides }
}

test('tasks ok carrega lista, incrementa contador e limpa notice', () => {
  const { state } = reduce({ ...initialState(), notice: 'x' }, { type: 'tasks', ok: true, tasks: TASKS })
  assert.equal(state.loaded, true)
  assert.equal(state.offline, false)
  assert.equal(state.tasks.length, 3)
  assert.equal(state.refreshCount, 1)
  assert.equal(state.notice, null)
})

test('tasks !ok → offline, sem mexer no contador', () => {
  const { state } = reduce(initialState(), { type: 'tasks', ok: false, tasks: [] })
  assert.equal(state.offline, true)
  assert.equal(state.refreshCount, 0)
})

test('scroll move foco com clamp nas pontas (sem wrap)', () => {
  let s = loaded()
  s = reduce(s, { type: 'scroll_up' }).state
  assert.equal(s.focusIdx, 0) // clamp no topo
  s = reduce(s, { type: 'scroll_down' }).state
  s = reduce(s, { type: 'scroll_down' }).state
  s = reduce(s, { type: 'scroll_down' }).state
  assert.equal(s.focusIdx, 2) // clamp no fundo
})

test('tap na lista abre ACTION com snapshot do focado', () => {
  const s = loaded({ focusIdx: 1 })
  const { state, effects } = reduce(s, { type: 'click' })
  assert.equal(state.screen, 'action')
  assert.deepEqual(state.action, { id: 'b', line: '» Tarefa B' })
  assert.deepEqual(effects, [])
})

test('lista vazia/offline/notice: tap = refresh, ACTION inacessível', () => {
  for (const s of [
    loaded({ tasks: [], focusIdx: 0 }),
    loaded({ offline: true }),
    loaded({ notice: 'Tarefa concluída.' }),
  ]) {
    const { state, effects } = reduce(s, { type: 'click' })
    assert.equal(state.screen, 'list')
    assert.deepEqual(effects, ['refresh'])
  }
})

test('ACTION: tap → busy done + effect; scroll → busy snooze + effect', () => {
  const base = reduce(loaded(), { type: 'click' }).state
  const done = reduce(base, { type: 'click' })
  assert.equal(done.state.screen, 'busy')
  assert.equal(done.state.busyKind, 'done')
  assert.deepEqual(done.effects, ['post_done'])
  const snooze = reduce(base, { type: 'scroll_down' })
  assert.equal(snooze.state.busyKind, 'snooze')
  assert.deepEqual(snooze.effects, ['post_snooze'])
})

test('escape hierárquico: 2× na ACTION volta sem escrita; na LIST sai; no BUSY gen++', () => {
  const action = reduce(loaded(), { type: 'click' }).state
  const back = reduce(action, { type: 'double_click' })
  assert.equal(back.state.screen, 'list')
  assert.deepEqual(back.effects, [])

  const exit = reduce(loaded(), { type: 'double_click' })
  assert.deepEqual(exit.effects, ['exit'])

  const busy = reduce(action, { type: 'click' }).state
  const escape = reduce(busy, { type: 'double_click' })
  assert.equal(escape.state.screen, 'list')
  assert.equal(escape.state.gen, busy.gen + 1)
})

test('BUSY ignora tap e scroll (gate)', () => {
  const busy = reduce(reduce(loaded(), { type: 'click' }).state, { type: 'click' }).state
  assert.equal(reduce(busy, { type: 'click' }).state.screen, 'busy')
  assert.equal(reduce(busy, { type: 'scroll_down' }).state.screen, 'busy')
})

test('action_result com gen atual → notice + refresh; gen antigo → só refresh silencioso', () => {
  const busy = reduce(reduce(loaded(), { type: 'click' }).state, { type: 'click' }).state
  const ok = reduce(busy, { type: 'action_result', kind: 'done', ok: true, already: false, gone: false, gen: busy.gen })
  assert.equal(ok.state.screen, 'list')
  assert.equal(ok.state.notice, 'Tarefa concluída.')
  assert.deepEqual(ok.effects, ['refresh'])

  const stale = reduce(busy, { type: 'action_result', kind: 'done', ok: true, already: false, gone: false, gen: busy.gen - 1 })
  assert.equal(stale.state.notice, null)
  assert.deepEqual(stale.effects, ['refresh'])
})

test('mapeamento de resultados: already/gone/token/falha e snooze', () => {
  const busy = reduce(reduce(loaded(), { type: 'click' }).state, { type: 'click' }).state
  const g = busy.gen
  const r = (extra) => reduce(busy, { type: 'action_result', kind: 'done', ok: false, already: false, gone: false, gen: g, ...extra }).state.notice
  assert.equal(r({ ok: true, already: true }), 'Já estava concluída.')
  assert.equal(r({ gone: true }), 'Tarefa não encontrada.')
  assert.equal(r({ error: 'token' }), 'Token inválido. Reinstale o plugin.')
  assert.equal(r({}), 'Falhou. Toque para atualizar.')
  assert.equal(r({ ok: true, kind: 'snooze' }), 'Adiada +1 dia.')
})

test('refresh com foco stale clampa (item concluído some)', () => {
  const s = loaded({ focusIdx: 2 })
  const { state } = reduce(s, { type: 'tasks', ok: true, tasks: TASKS.slice(0, 1) })
  assert.equal(state.focusIdx, 0)
})

test('foreground → refresh', () => {
  assert.deepEqual(reduce(loaded(), { type: 'foreground' }).effects, ['refresh'])
})
