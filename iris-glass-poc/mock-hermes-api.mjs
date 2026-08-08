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
// HERMES_MOCK_LEGACY=1 finge um backend anterior a 2026-08-08: sem a rota de status por
// id. E o cenario de version skew que o cliente precisa atravessar sem perder a fala.
const legacy = process.env.HERMES_MOCK_LEGACY === '1'
// Espelha o mapa de deduplicacao do servidor real: id -> resultado (ou null em voo).
const turnResults = new Map()

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

  if (request.method === 'GET' && url.pathname.startsWith('/glass/hermes/turn/')) {
    if (legacy) return send(response, 404, { error: 'Not found' })
    const clientMsgId = decodeURIComponent(url.pathname.slice('/glass/hermes/turn/'.length))
    if (!turnResults.has(clientMsgId)) return send(response, 200, { ok: true, status: 'unknown' })
    const result = turnResults.get(clientMsgId)
    if (!result) return send(response, 200, { ok: true, status: 'pending' })
    return send(response, 200, { ok: true, status: 'done', turn: result })
  }

  // Entrega a transcricao retida. Idempotente: repetir devolve o mesmo 202.
  if (
    request.method === 'POST' &&
    url.pathname.startsWith('/glass/hermes/turn/') &&
    url.pathname.endsWith('/commit')
  ) {
    if (legacy) return send(response, 404, { error: 'Not found' })
    const clientMsgId = decodeURIComponent(
      url.pathname.slice('/glass/hermes/turn/'.length, -'/commit'.length),
    )
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const staged = turnResults.get(clientMsgId)
      if (!turnResults.has(clientMsgId)) return send(response, 200, { ok: true, status: 'unknown' })
      if (!staged || staged.status !== 200) {
        return send(response, staged?.status ?? 200, staged?.body ?? { ok: true, status: 'unknown' })
      }
      if (body.expectedRevision && body.expectedRevision !== revision()) {
        return send(response, 409, { error: 'A conversa mudou; atualize antes de enviar.' })
      }
      turns.push({
        id: clientMsgId,
        user: 'Mensagem de voz simulada',
        assistant: 'Resposta simulada do HERMES.',
      })
      busyUntil = Date.now() + 2_000
      const payload = {
        ok: true,
        sessionId: 'mock-hermes-session',
        clientMsgId,
        transcript: 'Mensagem de voz simulada',
      }
      turnResults.set(clientMsgId, { status: 202, body: payload })
      send(response, 202, payload)
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/glass/hermes/turn') {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      posts++
      const body = JSON.parse(raw || '{}')
      // "flaky" simula o upload que morre no caminho: o servidor nunca soube do turno,
      // entao o status por id responde "unknown" e reenviar e o certo. Diferente de
      // "hang", em que o servidor RECEBEU e travou depois — ai reenviar seria duplicar.
      const dropped = failMode === 'flaky' && posts === 1
      if (dropped) {
        console.log(`POST #${posts} descartado antes de registrar (upload perdido)`)
        return
      }
      // O servidor real registra o id ANTES da transcricao, entao o status por id ja
      // responde "pending" enquanto o POST ainda esta em voo.
      if (body.clientMsgId && !turnResults.has(body.clientMsgId)) {
        turnResults.set(body.clientMsgId, null)
      }

      const finish = (status, payload) => {
        if (body.clientMsgId) {
          if (status >= 500) turnResults.delete(body.clientMsgId)
          else turnResults.set(body.clientMsgId, { status, body: payload })
        }
        send(response, status, payload)
      }

      // "hang" nunca responde: e o cenario que fazia o HUD ficar em PENSANDO ate o erro.
      if (failMode === 'hang') {
        console.log(`POST #${posts} pendurado de proposito`)
        return
      }
      const status = Number(failMode)
      if (Number.isFinite(status) && status >= 400) {
        return finish(status, { error: `falha simulada ${status}` })
      }

      if (!body.clientMsgId || !body.pcmB64) return send(response, 400, { error: 'Áudio inválido' })
      if (body.expectedRevision && body.expectedRevision !== revision()) {
        return finish(409, { error: 'A conversa mudou; atualize antes de enviar.' })
      }
      // Confirmacao pedida: transcreve e PARA. Nenhum turno entra na conversa, entao a
      // revision nao muda — que e exatamente o que o cliente precisa ver para saber que a
      // fala ainda nao foi entregue.
      if (body.confirm && !legacy) {
        return finish(200, {
          ok: true,
          staged: true,
          sessionId: 'mock-hermes-session',
          clientMsgId: body.clientMsgId,
          transcript: 'Mensagem de voz simulada',
        })
      }
      turns.push({
        id: body.clientMsgId,
        user: 'Mensagem de voz simulada',
        assistant: 'Resposta simulada do HERMES.',
      })
      busyUntil = Date.now() + 2_000
      finish(202, {
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
