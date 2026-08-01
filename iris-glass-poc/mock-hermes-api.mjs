import { createServer } from 'node:http'

const port = Number(process.env.HERMES_API_PORT || 8797)
const token = process.env.GLASS_TOKEN || ''
const turns = [
  { id: 'mock-1', user: 'Qual é a prioridade de hoje?', assistant: 'Revisar o deploy privado do HERMES no G2.' },
]
let busyUntil = 0

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
  })
  response.end(JSON.stringify(body))
}

function revision() {
  return '0123456789abcdef'
}

createServer((request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {})
  if (token && request.headers.authorization !== `Bearer ${token}`) {
    return send(response, 401, { error: 'Unauthorized' })
  }
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (request.method === 'GET' && url.pathname === '/glass/hermes/session') {
    const busy = Date.now() < busyUntil
    return send(response, 200, {
      ok: true,
      sessionId: 'mock-hermes-session',
      revision: revision(),
      state: busy ? 'busy' : 'idle',
      progress: busy ? { kind: 'thinking', text: 'Pensando' } : null,
      turns,
      cursor: 0,
      nextCursor: null,
    })
  }
  if (request.method === 'POST' && url.pathname === '/glass/hermes/turn') {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (!body.clientMsgId || !body.pcmB64) return send(response, 400, { error: 'Áudio inválido' })
      turns.push({ id: body.clientMsgId, user: 'Mensagem de voz simulada', assistant: 'Resposta simulada do HERMES.' })
      busyUntil = Date.now() + 2_000
      send(response, 202, {
        ok: true,
        sessionId: 'mock-hermes-session',
        clientMsgId: body.clientMsgId,
        transcript: 'Mensagem de voz simulada',
      })
    })
    return
  }
  send(response, 404, { error: 'Not found' })
}).listen(port, '127.0.0.1', () => {
  console.log(`Hermes mock listening on http://127.0.0.1:${port}`)
})
