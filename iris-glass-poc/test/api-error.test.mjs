import { test } from 'node:test'
import assert from 'node:assert/strict'
import { responseError, ApiError } from '../src/glassApi.ts'

// Contexto: no incidente de 2026-08-03 o backend /glass/hermes/* nunca tinha sido
// deployado. O servidor respondia — 404 — mas o plugin dizia "Sem conexao com o
// HERMES", texto que aponta para rede. O diagnostico foi parar em tailnet, MagicDNS e
// TLS antes de chegar na causa. Estes testes travam a distincao.

const resp = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('404 diz que a ROTA sumiu, nunca que faltou conexao', async () => {
  const err = await responseError(resp(404))
  assert.ok(err instanceof ApiError)
  assert.equal(err.status, 404)
  assert.match(err.publicMessage, /rota ausente/i)
  assert.doesNotMatch(err.publicMessage, /sem conex/i)
})

test('erro HTTP inesperado expoe o status em vez de virar "sem conexao"', async () => {
  const err = await responseError(resp(500))
  assert.match(err.publicMessage, /erro 500/i)
  assert.doesNotMatch(err.publicMessage, /sem conex/i)
})

test('nenhuma resposta HTTP produz o texto de rede — esse texto e exclusivo de falha de fetch', async () => {
  for (const status of [400, 404, 500, 502, 503]) {
    const err = await responseError(resp(status))
    assert.doesNotMatch(
      err.publicMessage,
      /sem conex/i,
      `status ${status} nao pode se disfarcar de falta de rede`,
    )
  }
})

test('401 continua apontando credencial, nao rede nem rota', async () => {
  const err = await responseError(resp(401))
  assert.match(err.publicMessage, /token/i)
})

test('mensagem do gateway tem prioridade sobre o texto generico', async () => {
  const err = await responseError(resp(503, { error: 'Iris reiniciando' }))
  assert.equal(err.publicMessage, 'Iris reiniciando')
})

test('409 e 422 seguem com seus textos proprios', async () => {
  assert.match((await responseError(resp(409))).publicMessage, /conversa mudou/i)
  assert.match((await responseError(resp(422))).publicMessage, /fala/i)
})
