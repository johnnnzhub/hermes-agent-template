import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('mock api timeout')), 3000)
    proc.stdout.on('data', chunk => {
      if (chunk.toString().includes('Iris Glass API mock listening')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    proc.on('exit', code => reject(new Error(`mock api exited early: ${code}`)))
  })
}

test('mock Glass API: tasks, action done/snooze, dedup e already/gone', async () => {
  const port = 8797
  const proc = spawn(process.execPath, ['mock-glass-api.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GLASS_API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://localhost:${port}`
  const post = body =>
    fetch(`${base}/glass/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

  try {
    await waitForServer(proc)

    const health = await fetch(`${base}/glass/health`).then(r => r.json())
    assert.equal(health.ok, true)

    // Contrato GET: lines display-ready + ids paralelo.
    const tasks = await fetch(`${base}/glass/tasks?scope=next&limit=2`).then(r => r.json())
    assert.equal(tasks.ok, true)
    assert.equal(tasks.lines.length, 2)
    assert.equal(tasks.ids.length, tasks.lines.length)
    assert.ok(tasks.lines.every(l => typeof l === 'string' && l.startsWith('»') && l.length <= 42))

    // done remove da lista (refetch encolhe).
    const done = await post({ action: 'task.done', taskId: 'mock-1', clientMsgId: 'm1' })
    assert.deepEqual(done, { ok: true })
    const after = await fetch(`${base}/glass/tasks`).then(r => r.json())
    assert.equal(after.lines.length, 2)
    assert.ok(!after.ids.includes('mock-1'))

    // Dedup: MESMO clientMsgId repete a resposta original, sem nova escrita.
    const dup = await post({ action: 'task.done', taskId: 'mock-1', clientMsgId: 'm1' })
    assert.deepEqual(dup, { ok: true })

    // done de id fora da lista (novo msgId) → already.
    const already = await post({ action: 'task.done', taskId: 'mock-1', clientMsgId: 'm2' })
    assert.equal(already.already, true)

    // snooze de id inexistente → gone; existente → ok puro.
    const gone = await post({ action: 'task.snooze', taskId: 'nope', clientMsgId: 'm3' })
    assert.equal(gone.gone, true)
    const snooze = await post({ action: 'task.snooze', taskId: 'mock-2', clientMsgId: 'm4' })
    assert.deepEqual(snooze, { ok: true })

    // Validação de body.
    const bad = await fetch(`${base}/glass/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'task.explode', taskId: 'x', clientMsgId: 'm5' }),
    })
    assert.equal(bad.status, 400)
  } finally {
    proc.kill('SIGTERM')
  }
})
