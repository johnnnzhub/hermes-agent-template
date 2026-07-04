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

test('mock Glass API health, tasks and intent contracts', async () => {
  const port = 8797
  const proc = spawn(process.execPath, ['mock-glass-api.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GLASS_API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForServer(proc)

    const health = await fetch(`http://localhost:${port}/glass/health`).then(r => r.json())
    assert.equal(health.ok, true)

    const tasks = await fetch(`http://localhost:${port}/glass/tasks`).then(r => r.json())
    assert.equal(Array.isArray(tasks.tasks), true)
    assert.equal(typeof tasks.glass_short, 'string')

    const intent = await fetch(`http://localhost:${port}/glass/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'listar próximas tarefas', source: 'dev' }),
    }).then(r => r.json())

    assert.equal(intent.action, 'list_tasks')
    assert.equal(typeof intent.glass_short, 'string')
    assert.ok(intent.glass_short.length <= 240)
  } finally {
    proc.kill('SIGTERM')
  }
})
