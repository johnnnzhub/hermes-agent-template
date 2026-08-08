import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.HERMES_API_PORT || 8797)
const token = process.env.GLASS_TOKEN || ''
const turns = [
  { id: 'mock-1', user: 'Qual é a prioridade de hoje?', assistant: 'Revisar o deploy privado do HERMES no G2.' },
]
let busyUntil = 0

// Injecao de falha. Sem isto nao da para reproduzir sem device o caminho que perdia a
// gravacao: rede que pendura, 5xx, conflito de revision.
//   HERMES_MOCK_FAIL=hang|flaky|409|422|413|401|500
//   GET /mock/fail?mode=hang  troca em tempo de execucao
let failMode = process.env.HERMES_MOCK_FAIL || 'none'
let posts = 0

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
  })
  response.end(JSON.stringify(body))
}

// Mesma semantica do servidor real: sha256 das mensagens visiveis, 16 hex. Uma revision
// fixa esconderia justamente a pos-condicao que decide se o turno entrou.
function revision() {
  const messages = turns.flatMap(turn => [turn.user, turn.assistant].filter(Boolean))
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 16)
}

createServer((request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {})

  const url = new URL(request.url, `http://${request.headers.host}`)
  if (url.pathname === '/mock/fail') {
    failMode = url.searchParams.get('mode') || 'none'
    posts = 0
    console.log(`mock fail mode: ${failMode}`)
    return send(response, 200, { ok: true, failMode })
  }

  if (token && request.headers.authorization !== `Bearer ${token}`) {
    return send(response, 401, { error: 'Unauthorized' })
  }

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
      posts++
      // "hang" nunca responde: e o cenario que fazia o HUD ficar em PENSANDO ate o erro.
      if (failMode === 'hang' || (failMode === 'flaky' && posts === 1)) {
        console.log(`POST #${posts} pendurado de proposito`)
        return
      }
      const status = Number(failMode)
      if (Number.isFinite(status) && status >= 400) {
        return send(response, status, { error: `falha simulada ${status}` })
      }

      const body = JSON.parse(raw || '{}')
      if (!body.clientMsgId || !body.pcmB64) return send(response, 400, { error: 'Áudio inválido' })
      if (body.expectedRevision && body.expectedRevision !== revision()) {
        return send(response, 409, { error: 'A conversa mudou; atualize antes de enviar.' })
      }
      turns.push({
        id: body.clientMsgId,
        user: 'Mensagem de voz simulada',
        assistant: 'Resposta simulada do HERMES.',
      })
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
  console.log(`Hermes mock listening on http://127.0.0.1:${port} (fail=${failMode})`)
})
