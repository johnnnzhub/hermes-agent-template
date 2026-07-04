import http from 'node:http'

const port = Number(process.env.GLASS_API_PORT || 8787)

// Estado MUTÁVEL: done remove da lista, snooze mantém — permite testar o loop
// completo (lista → ação → refresh) no browser/simulador sem API real.
let tasks = [
  { id: 'mock-1', line: '» Preparar posts da semana' },
  { id: 'mock-2', line: '» Revisar próximas tarefas' },
  { id: 'mock-3', line: '» Validar Iris Glass no G2' },
]
// Dedup por clientMsgId (espelha o gateway fluxo: mesmo id 2× = no-op).
const seenMsgIds = new Map()

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})

  if (req.method === 'GET' && req.url === '/glass/health') {
    return json(res, 200, { ok: true, service: 'iris-glass-api-mock' })
  }

  if (req.method === 'GET' && req.url.startsWith('/glass/tasks')) {
    const url = new URL(req.url, `http://localhost:${port}`)
    const limit = Math.max(1, Math.min(6, Number(url.searchParams.get('limit')) || 5))
    const picked = tasks.slice(0, limit)
    return json(res, 200, {
      ok: true,
      lines: picked.map(t => t.line),
      ids: picked.map(t => t.id),
      updated_at: new Date().toISOString(),
    })
  }

  if (req.method === 'POST' && req.url === '/glass/task') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad request' })
    }
    const { action, taskId, clientMsgId } = body
    if (!['task.done', 'task.snooze'].includes(action) || !taskId || !clientMsgId) {
      return json(res, 400, { ok: false, error: 'bad request' })
    }
    if (seenMsgIds.has(clientMsgId)) return json(res, 200, seenMsgIds.get(clientMsgId))

    const exists = tasks.some(t => t.id === taskId)
    let result
    if (action === 'task.done') {
      // Fora da lista aberta (já concluída/inexistente) → already, como o gateway.
      result = exists ? { ok: true } : { ok: true, already: true }
      tasks = tasks.filter(t => t.id !== taskId)
    } else {
      result = exists ? { ok: true } : { ok: true, gone: true }
    }
    seenMsgIds.set(clientMsgId, result)
    return json(res, 200, result)
  }

  json(res, 404, { error: 'not_found' })
})

server.listen(port, () => {
  console.log(`Iris Glass API mock listening on http://localhost:${port}`)
})
