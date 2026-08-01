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
import { createHarness, waitFor } from "./helpers/harness.mjs";

const TERMINAL_TOKEN =
  "iris-terminal-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GLASS_TOKEN =
  "iris-glass-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PCM = Buffer.alloc(3_200, 1).toString("base64");

async function createHttpHarness() {
  const harness = await createHarness();
  const transcripts = [];
  const transcriber = {
    async transcribe(audio) {
      transcripts.push(audio.clientMsgId);
      return audio.clientMsgId.startsWith("roles-")
        ? "__history_roles__"
        : `voz ${audio.clientMsgId}`;
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
    async closeHttp() {
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
