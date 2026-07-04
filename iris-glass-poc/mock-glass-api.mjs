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

  if (req.method === 'GET' && req.url === '/glass/tasks') {
    return json(res, 200, {
      tasks: [
        { id: 'mock-1', title: 'Preparar posts da semana', priority: '!!!' },
        { id: 'mock-2', title: 'Revisar próximas tarefas', priority: '!!' },
        { id: 'mock-3', title: 'Validar Iris Glass no G2', priority: '!' },
      ],
      glass_short: '3 tarefas: posts, revisar lista, validar G2.',
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
