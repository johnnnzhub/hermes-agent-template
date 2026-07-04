import http from 'node:http'

const port = Number(process.env.GLASS_API_PORT || 8787)

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
    // Contrato 0.2.0: lines display-ready (», ≤42 chars) + ids paralelo.
    const url = new URL(req.url, `http://localhost:${port}`)
    const limit = Math.max(1, Math.min(6, Number(url.searchParams.get('limit')) || 5))
    const all = [
      { id: 'mock-1', line: '» Preparar posts da semana' },
      { id: 'mock-2', line: '» Revisar próximas tarefas' },
      { id: 'mock-3', line: '» Validar Iris Glass no G2' },
    ]
    const picked = all.slice(0, limit)
    return json(res, 200, {
      ok: true,
      lines: picked.map(t => t.line),
      ids: picked.map(t => t.id),
      updated_at: new Date().toISOString(),
    })
  }

  if (req.method === 'POST' && req.url === '/glass/intent') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const transcript = String(body.transcript || '').toLowerCase()

    if (transcript.includes('concluir')) {
      return json(res, 200, {
        action: 'complete_task_confirmation',
        needs_confirmation: true,
        glass_short: 'Confirmar concluir tarefa? Tap sim, double tap cancela.',
      })
    }

    if (transcript.includes('tarefa') || transcript.includes('próxim')) {
      return json(res, 200, {
        action: 'list_tasks',
        glass_short: 'Top 3: posts, alunos, pendências. Detalhe no WhatsApp.',
        whatsapp_full: 'Mock: aqui entraria a lista completa do Notion Tasks.',
      })
    }

    return json(res, 200, {
      action: 'ask_iris',
      glass_short: `Iris ouviu: ${String(body.transcript || 'comando vazio').slice(0, 80)}`,
    })
  }

  json(res, 404, { error: 'not_found' })
})

server.listen(port, () => {
  console.log(`Iris Glass API mock listening on http://localhost:${port}`)
})
