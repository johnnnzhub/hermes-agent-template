import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventBuffer } from "../src/event-buffer.mjs";
import {
  GlassTranscriber,
  groupConversationTurns,
  safeProgress,
} from "../src/glass-conversation.mjs";
import { createApp } from "../src/server.mjs";
import { ProviderError } from "../src/hermes-provider.mjs";
import { createHarness, waitFor } from "./helpers/harness.mjs";

const TERMINAL_TOKEN =
  "iris-terminal-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GLASS_TOKEN =
  "iris-glass-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PCM = Buffer.alloc(3_200, 1).toString("base64");

async function createHttpHarness() {
  const harness = await createHarness();
  const transcripts = [];
  // `hold-` segura a transcricao ate o teste soltar: e o unico jeito de observar um turno
  // em voo, que e o estado que o GET /turn/:clientMsgId precisa reportar como "pending".
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const transcriber = {
    async transcribe(audio) {
      transcripts.push(audio.clientMsgId);
      if (audio.clientMsgId.startsWith("hold-")) await held;
      if (audio.clientMsgId.startsWith("roles-")) return "__history_roles__";
      // `__slow__` deixa o turno aberto no fake TUI: o `busy` que nunca fecha sozinho.
      if (audio.clientMsgId.startsWith("slow-")) return "__slow__";
      return `voz ${audio.clientMsgId}`;
    },
  };
  const app = createApp({
    provider: harness.provider,
    events: harness.events,
    token: TERMINAL_TOKEN,
    glassToken: GLASS_TOKEN,
    glassTranscriber: transcriber,
    logger: { info() {}, warn() {}, error() {} },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    ...harness,
    baseUrl: `http://127.0.0.1:${port}`,
    transcripts,
    releaseTranscription: () => release(),
    async closeHttp() {
      release();
      harness.events.close();
      await new Promise((resolve) => server.close(resolve));
      await harness.close();
    },
  };
}

function glassHeaders(token = GLASS_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

async function getSession(harness, cursor = 0) {
  const response = await fetch(
    `${harness.baseUrl}/glass/hermes/session?cursor=${cursor}`,
    { headers: glassHeaders() },
  );
  return { response, body: await response.json() };
}

async function postTurn(harness, body) {
  const response = await fetch(`${harness.baseUrl}/glass/hermes/turn`, {
    method: "POST",
    headers: { ...glassHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      pcmB64: PCM,
      sampleRate: 16_000,
      channels: 1,
      bitDepth: 16,
      ...body,
    }),
  });
  return { response, body: await response.json() };
}

test("groups only user/assistant messages into chronological turns", () => {
  assert.deepEqual(
    groupConversationTurns([
      { role: "system", text: "private" },
      { role: "assistant", text: "Olá" },
      { role: "user", text: "Um" },
      { role: "tool", text: "private too" },
      { role: "assistant", text: "Dois" },
    ]).map(({ user, assistant }) => ({ user, assistant })),
    [
      { user: "", assistant: "Olá" },
      { user: "Um", assistant: "Dois" },
    ],
  );
});

test("safe progress exposes a tool name but never its input or output", () => {
  const events = new EventBuffer();
  events.push("session-1", { type: "user_prompt", text: "faça" });
  events.push("session-1", {
    type: "tool_start",
    name: "terminal",
    toolId: "tool-1",
    input: "SECRET_INPUT",
  });
  const progress = safeProgress(events, "session-1", "busy");
  assert.deepEqual(progress, { kind: "tool", text: "Usando terminal" });
  assert.doesNotMatch(JSON.stringify(progress), /SECRET_INPUT|output|detail/);
});

test("Glass STT proxy forwards the established PCM contract and no extra data", async () => {
  let request;
  const transcriber = new GlassTranscriber({
    url: "https://stt.example/voice",
    token: "stt-token",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, text: "  mensagem  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const text = await transcriber.transcribe({
    pcmB64: PCM,
    clientMsgId: "voice-123",
  });
  assert.equal(text, "mensagem");
  assert.equal(request.url, "https://stt.example/voice");
  assert.equal(request.init.headers.authorization, "Bearer stt-token");
  assert.deepEqual(JSON.parse(request.init.body), {
    pcmB64: PCM,
    sampleRate: 16_000,
    channels: 1,
    bitDepth: 16,
    clientMsgId: "voice-123",
  });
});

test("Glass token is scoped to the shared session surface", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const missing = await fetch(`${harness.baseUrl}/glass/hermes/session`);
  assert.equal(missing.status, 401);

  const terminalCredential = await fetch(
    `${harness.baseUrl}/glass/hermes/session`,
    { headers: glassHeaders(TERMINAL_TOKEN) },
  );
  assert.equal(terminalCredential.status, 401);

  const broadApi = await fetch(`${harness.baseUrl}/api/sessions`, {
    headers: glassHeaders(),
  });
  assert.equal(broadApi.status, 401);

  const session = await getSession(harness);
  assert.equal(session.response.status, 200);
  assert.equal(session.body.sessionId, harness.sessionId);
  assert.equal(session.body.state, "idle");
  assert.match(session.body.revision, /^[a-f0-9]{16}$/);
});

test("voice turn uses the exact persistent session, filters private roles, and deduplicates retries", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const body = {
    clientMsgId: "roles-0001",
    expectedRevision: before.body.revision,
  };
  const accepted = await postTurn(harness, body);
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.sessionId, harness.sessionId);
  assert.equal(accepted.body.transcript, "__history_roles__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );

  const retry = await postTurn(harness, body);
  assert.equal(retry.response.status, 202);
  assert.deepEqual(retry.body, accepted.body);
  assert.deepEqual(harness.transcripts, ["roles-0001"]);

  const collision = await postTurn(harness, {
    ...body,
    pcmB64: Buffer.alloc(3_200, 2).toString("base64"),
  });
  assert.equal(collision.response.status, 409);
  assert.match(collision.body.error, /já foi utilizado/);
  assert.deepEqual(harness.transcripts, ["roles-0001"]);

  const after = await getSession(harness);
  const serialized = JSON.stringify(after.body);
  assert.match(serialized, /__history_roles__|visible history/);
  assert.doesNotMatch(serialized, /must stay private/);
});

test("history cursor pages beyond the old ten-message provider limit", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  for (let index = 1; index <= 8; index += 1) {
    await harness.provider.prompt(harness.sessionId, `turn-${index}`);
    await waitFor(
      () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
    );
  }

  const newest = await getSession(harness);
  assert.equal(newest.body.turns.length, 6);
  assert.equal(newest.body.turns.at(-1).user, "turn-8");
  assert.equal(newest.body.nextCursor, 6);

  const older = await getSession(harness, newest.body.nextCursor);
  assert.equal(older.body.turns.length, 2);
  assert.deepEqual(
    [...older.body.turns, ...newest.body.turns].map((turn) => turn.user),
    Array.from({ length: 8 }, (_, index) => `turn-${index + 1}`),
  );
  assert.equal(older.body.nextCursor, null);
});

test("stale revision and a busy Terminal Mode turn fail before transcription", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const initial = await getSession(harness);

  await harness.provider.prompt(harness.sessionId, "changed elsewhere");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  const stale = await postTurn(harness, {
    clientMsgId: "stale-0001",
    expectedRevision: initial.body.revision,
  });
  assert.equal(stale.response.status, 409);
  assert.match(stale.body.error, /conversa mudou/);
  assert.equal(harness.transcripts.length, 0);

  await harness.provider.prompt(harness.sessionId, "__slow__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "busy",
  );
  const busySnapshot = await getSession(harness);
  assert.equal(busySnapshot.body.state, "busy");
  assert.ok(busySnapshot.body.progress);
  const busy = await postTurn(harness, {
    clientMsgId: "busy-00001",
    expectedRevision: busySnapshot.body.revision,
  });
  assert.equal(busy.response.status, 409);
  assert.match(busy.body.error, /trabalhando/);
  assert.equal(harness.transcripts.length, 0);
  await harness.provider.interrupt(harness.sessionId);
});

test("rejects malformed audio before reaching STT", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const snapshot = await getSession(harness);
  const bad = await postTurn(harness, {
    pcmB64: "not base64",
    clientMsgId: "audio-0001",
    expectedRevision: snapshot.body.revision,
  });
  assert.equal(bad.response.status, 400);
  assert.equal(harness.transcripts.length, 0);
});

async function getTurnStatus(harness, clientMsgId) {
  const response = await fetch(
    `${harness.baseUrl}/glass/hermes/turn/${clientMsgId}`,
    { headers: glassHeaders() },
  );
  return { response, body: await response.json() };
}

async function postCommit(harness, clientMsgId, expectedRevision) {
  const response = await fetch(
    `${harness.baseUrl}/glass/hermes/turn/${clientMsgId}/commit`,
    {
      method: "POST",
      headers: { ...glassHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision }),
    },
  );
  return { response, body: await response.json() };
}

// A fala vira acao no instante em que chega na Iris. Confirmar depois do STT e a unica
// janela possivel: antes dele ninguem sabe o que foi dito, nem o oculos nem o servidor.
test("confirmação retém a transcrição e só entrega no commit", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const staged = await postTurn(harness, {
    clientMsgId: "confirm-0001",
    expectedRevision: before.body.revision,
    confirm: true,
  });
  assert.equal(staged.response.status, 200);
  assert.equal(staged.body.staged, true);
  assert.equal(staged.body.transcript, "voz confirm-0001");
  // O ponto inteiro: transcreveu e NAO submeteu.
  assert.deepEqual(harness.transcripts, ["confirm-0001"]);
  assert.equal(harness.provider.getStatus(harness.sessionId)?.state, "idle");
  const untouched = await getSession(harness);
  assert.equal(untouched.body.revision, before.body.revision);

  const committed = await postCommit(
    harness,
    "confirm-0001",
    before.body.revision,
  );
  assert.equal(committed.response.status, 202);
  assert.equal(committed.body.transcript, "voz confirm-0001");
  // O commit nao reenvia audio: o STT roda uma vez so.
  assert.deepEqual(harness.transcripts, ["confirm-0001"]);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );

  // Repetir o commit devolve o mesmo turno, nunca um segundo.
  const again = await postCommit(harness, "confirm-0001", before.body.revision);
  assert.equal(again.response.status, 202);
  assert.deepEqual(again.body, committed.body);

  // E o status por id passa a contar o desfecho definitivo.
  const status = await getTurnStatus(harness, "confirm-0001");
  assert.equal(status.body.status, "done");
  assert.equal(status.body.turn.status, 202);
});

// Entre a transcricao e o toque do John a conversa pode andar por outro canal (o atalho do
// iPhone, o terminal). Herdar a revision do momento do upload injetaria a fala num contexto
// que ele nao leu.
test("commit confere a revisão no instante da entrega, não na do upload", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const staged = await postTurn(harness, {
    clientMsgId: "confirm-0002",
    expectedRevision: before.body.revision,
    confirm: true,
  });
  assert.equal(staged.response.status, 200);

  const stale = await postCommit(harness, "confirm-0002", "0".repeat(16));
  assert.equal(stale.response.status, 409);
  assert.match(stale.body.error, /conversa mudou/);
  assert.equal(harness.provider.getStatus(harness.sessionId)?.state, "idle");

  // O 409 nao queima o turno: com a revision certa o mesmo toque entrega.
  const ok = await postCommit(harness, "confirm-0002", before.body.revision);
  assert.equal(ok.response.status, 202);
});

// Commit de um id que o servidor esqueceu (restart, eviccao) nao pode virar 404: o cliente
// tem de conseguir separar "esqueci este turno" de "esta rota nao existe aqui".
test("commit de turno desconhecido responde unknown, não 404", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const missing = await postCommit(harness, "sumiu-0001", before.body.revision);
  assert.equal(missing.response.status, 200);
  assert.equal(missing.body.status, "unknown");

  const invalid = await postCommit(harness, "x", before.body.revision);
  assert.equal(invalid.response.status, 400);
});

// Cliente antigo (v0.4.3) nao manda `confirm`, e o campo desconhecido nao pode mudar nada
// para ele: o turno segue direto para a Iris como sempre.
test("sem confirm o turno vai direto, como no cliente antigo", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const accepted = await postTurn(harness, {
    clientMsgId: "direto-0001",
    expectedRevision: before.body.revision,
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.staged, undefined);
});

async function postInterrupt(harness) {
  const response = await fetch(`${harness.baseUrl}/glass/hermes/interrupt`, {
    method: "POST",
    headers: glassHeaders(),
  });
  return { response, body: await response.json() };
}

// Sem esta rota a unica forma de o cliente saber se um POST abortado chegou era reenviar
// ~1,28 MB de audio ou adivinhar pela revision da sessao.
test("turn status answers by id instead of forcing another audio upload", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  // "id desconhecido" NAO pode ser 404: o catch-all do router responde 404 tambem, e o
  // cliente precisa separar isso de "a rota nao foi promovida".
  const unknown = await getTurnStatus(harness, "nunca-vi-este-id");
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.body.status, "unknown");

  const missingRoute = await fetch(`${harness.baseUrl}/glass/hermes/inexistente`, {
    headers: glassHeaders(),
  });
  assert.equal(missingRoute.status, 404);

  const malformed = await getTurnStatus(harness, "curto");
  assert.equal(malformed.response.status, 400);

  const inFlight = postTurn(harness, {
    clientMsgId: "hold-0001",
    expectedRevision: before.body.revision,
  });
  await waitFor(() => harness.transcripts.includes("hold-0001"));
  const pending = await getTurnStatus(harness, "hold-0001");
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.status, "pending");

  harness.releaseTranscription();
  const accepted = await inFlight;
  assert.equal(accepted.response.status, 202);

  const done = await getTurnStatus(harness, "hold-0001");
  assert.equal(done.body.status, "done");
  assert.equal(done.body.turn.status, 202);
  assert.deepEqual(done.body.turn.body, accepted.body);
  // O audio subiu uma vez so: a segunda pergunta custou uma linha de JSON.
  assert.deepEqual(harness.transcripts, ["hold-0001"]);
});

test("turn status stays scoped to the glass credential", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const anonymous = await fetch(
    `${harness.baseUrl}/glass/hermes/turn/qualquer-id`,
  );
  assert.equal(anonymous.status, 401);
});

// Ate aqui, um turno que nao fecha sozinho so saia com restart do container — que derruba
// junto tudo o mais que roda nele.
test("interrupt releases a turn that never settles on its own", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const accepted = await postTurn(harness, {
    clientMsgId: "slow-00001",
    expectedRevision: before.body.revision,
  });
  assert.equal(accepted.response.status, 202);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "busy",
  );

  const stuckSession = await getSession(harness);
  assert.equal(stuckSession.body.state, "busy");
  const blocked = await postTurn(harness, {
    clientMsgId: "slow-00002",
    expectedRevision: stuckSession.body.revision,
  });
  assert.equal(blocked.response.status, 409);

  const released = await postInterrupt(harness);
  assert.equal(released.response.status, 200);
  assert.equal(released.body.ok, true);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  const recovered = await getSession(harness);
  assert.equal(recovered.body.state, "idle");
});

test("session reports a stuck turn only past the ceiling", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const idle = await getSession(harness);
  assert.equal(idle.body.stuck, false);

  const realGetStatus = harness.provider.getStatus.bind(harness.provider);
  harness.provider.getStatus = (sessionId) => ({
    ...realGetStatus(sessionId),
    state: "busy",
    turnDurationMs: 299_999,
  });
  const slow = await getSession(harness);
  assert.equal(slow.body.state, "busy");
  assert.equal(slow.body.stuck, false);

  harness.provider.getStatus = (sessionId) => ({
    ...realGetStatus(sessionId),
    state: "busy",
    turnDurationMs: 300_000,
  });
  const stuck = await getSession(harness);
  assert.equal(stuck.body.stuck, true);

  harness.provider.getStatus = realGetStatus;
});

test("provider status carries how long the active turn has been running", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  assert.equal(harness.provider.getStatus(harness.sessionId).turnDurationMs, 0);
  await harness.provider.prompt(harness.sessionId, "__slow__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId).turnDurationMs > 0,
  );
  await harness.provider.interrupt(harness.sessionId);
});

// O cliente precisa poder ler um 409 como "NAO entrou". Todo caminho de 409 do handler
// retorna antes de `provider.prompt`, entao a sessao fica intocada — e por isso o plugin
// nao pode inferir entrega a partir de uma revision que mudou junto com um conflito.
test("a revision divergente rejeita o turno sem submeter nada", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const stale = await postTurn(harness, {
    clientMsgId: "revisao-0001",
    expectedRevision: "0".repeat(16),
  });
  assert.equal(stale.response.status, 409);
  assert.match(stale.body.error, /conversa mudou/);
  // Nem transcreveu, nem submeteu: nada da fala chegou ao agente.
  assert.deepEqual(harness.transcripts, []);

  const after = await getSession(harness);
  assert.equal(after.body.revision, before.body.revision);
  assert.equal(after.body.turns.length, before.body.turns.length);
  assert.equal(after.body.state, "idle");
});

/** Servidor com um provider de mentira, para observar quantos prompts sao emitidos. */
async function createStubHarness({ promptImpl }) {
  const prompts = [];
  const provider = {
    async listSessions() {
      return [{ id: "stub-session" }];
    },
    getStatus() {
      return { state: "idle", turnDurationMs: 0 };
    },
    async getHistory() {
      return [];
    },
    async prompt(sessionId, text) {
      prompts.push(text);
      return promptImpl(sessionId, text, prompts.length);
    },
  };
  const events = new EventBuffer();
  const app = createApp({
    provider,
    events,
    token: TERMINAL_TOKEN,
    glassToken: GLASS_TOKEN,
    glassTranscriber: { async transcribe() { return "fala do john"; } },
    logger: { info() {}, warn() {}, error() {} },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    prompts,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async closeHttp() {
      events.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// O RPC pode ter escrito o frame antes de estourar. Liberar o commit para nova tentativa
// depois de um 5xx fazia a Iris agir DUAS VEZES sobre a mesma fala — e agir e o que nao
// tem desfazer. O desfecho ambiguo fica memorizado; quem decide reenviar e o John.
test("commit que falha com 5xx não emite um segundo prompt sozinho", async (t) => {
  const harness = await createStubHarness({
    promptImpl() {
      throw new ProviderError("Iris indisponível", 503);
    },
  });
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const staged = await postTurn(harness, {
    clientMsgId: "ambiguo-0001",
    expectedRevision: before.body.revision,
    confirm: true,
  });
  assert.equal(staged.response.status, 200);

  const first = await postCommit(harness, "ambiguo-0001", before.body.revision);
  assert.equal(first.response.status, 503);
  assert.equal(harness.prompts.length, 1);

  const second = await postCommit(harness, "ambiguo-0001", before.body.revision);
  assert.equal(second.response.status, 503);
  // A garantia: insistir nao repete a acao.
  assert.equal(harness.prompts.length, 1);

  const status = await getTurnStatus(harness, "ambiguo-0001");
  assert.equal(status.body.status, "done");
  assert.equal(status.body.turn.status, 503);
});

// Downgrade: o v0.7 reenvia o mesmo id SEM `confirm`. Se a impressao digital ignorasse o
// campo, ele receberia o corpo `200 staged` guardado, leria ok/sessionId/transcript e daria
// a fala como entregue — sem nenhum prompt ter acontecido, e apagando o rascunho.
test("cliente antigo não confunde uma transcrição retida com entrega", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const before = await getSession(harness);

  const staged = await postTurn(harness, {
    clientMsgId: "downgrade-0001",
    expectedRevision: before.body.revision,
    confirm: true,
  });
  assert.equal(staged.response.status, 200);

  const legacy = await postTurn(harness, {
    clientMsgId: "downgrade-0001",
    expectedRevision: before.body.revision,
  });
  assert.equal(legacy.response.status, 409);
  assert.match(legacy.body.error, /já foi utilizado/);
});
