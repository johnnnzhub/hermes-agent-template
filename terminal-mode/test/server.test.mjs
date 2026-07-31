import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { delimiter } from "node:path";
import {
  createApp,
  assertLoopbackHost,
  assertStrongToken,
  hermesGatewaySpawnConfig,
} from "../src/server.mjs";
import {
  createHarness,
  messagesOf,
  waitFor,
} from "./helpers/harness.mjs";

const TOKEN =
  "iris-terminal-test-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function createHttpHarness(options = {}) {
  const harness = await createHarness(options);
  const httpLogs = [];
  const logger = {
    info: (message) => httpLogs.push(String(message)),
    warn: (message) => httpLogs.push(String(message)),
    error: (message) => httpLogs.push(String(message)),
  };
  const app = createApp({
    provider: harness.provider,
    events: harness.events,
    token: TOKEN,
    logger,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    ...harness,
    httpLogs,
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    async closeHttp() {
      harness.events.close();
      await new Promise((resolve) => server.close(resolve));
      await harness.close();
    },
  };
}

function withToken(harness, path, token = harness.token) {
  const separator = path.includes("?") ? "&" : "?";
  return `${harness.baseUrl}${path}${separator}token=${encodeURIComponent(token)}`;
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

async function post(harness, path, body, { bearer = false } = {}) {
  return fetch(
    bearer
      ? `${harness.baseUrl}${path}`
      : withToken(harness, path),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${harness.token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function collectSse(response, predicate, timeoutMs = 2_000) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages = [];
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SSE read timed out")), remaining),
        ),
      ]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        messages.push(JSON.parse(dataLine.slice(6)));
        if (predicate(messages)) return messages;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error("SSE predicate not reached");
}

test("requires a strong configured token", () => {
  assert.throws(() => assertStrongToken("short"), /strong token/);
  assert.throws(() => assertStrongToken("a".repeat(64)), /strong token/);
  assert.equal(assertStrongToken(TOKEN), TOKEN);
});

test("hard-rejects non-loopback Terminal Mode binds", () => {
  assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
  assert.throws(() => assertLoopbackHost("::"), /loopback/);
});

test("spawns the Hermes JSON-RPC gateway directly from the pinned app root", () => {
  const config = hermesGatewaySpawnConfig({
    IRIS_TERMINAL_HERMES_ROOT: "/opt/test-hermes",
    IRIS_TERMINAL_PYTHON: "/usr/bin/python3",
    PYTHONPATH: "/existing/pythonpath",
  });
  assert.deepEqual(config, {
    command: "/usr/bin/python3",
    args: ["-m", "tui_gateway.entry"],
    cwd: "/opt/test-hermes",
    env: {
      PYTHONPATH: `/opt/test-hermes${delimiter}/existing/pythonpath`,
      HERMES_PYTHON_SRC_ROOT: "/opt/test-hermes",
    },
  });
});

test("accepts official query-token auth on API and SSE, with optional Bearer support", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const unauthenticated = await fetch(`${harness.baseUrl}/api/sessions`);
  assert.equal(unauthenticated.status, 401);

  const queryAuth = await json(
    await fetch(withToken(harness, "/api/sessions?defaultProvider=claude")),
  );
  assert.equal(queryAuth.response.status, 200);
  assert.equal(queryAuth.body.sessions[0].title, "HERMES");

  const bearerAuth = await json(
    await fetch(`${harness.baseUrl}/api/info`, {
      headers: { authorization: `Bearer ${harness.token}` },
    }),
  );
  assert.equal(bearerAuth.response.status, 200);
  assert.equal(bearerAuth.body.provider, "claude");

  const controller = new AbortController();
  const sse = await fetch(
    withToken(
      harness,
      `/api/events?sessionId=${encodeURIComponent(harness.sessionId)}`,
    ),
    { signal: controller.signal },
  );
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /^text\/event-stream/);
  controller.abort();
});

test("supports unauthenticated CORS preflight while keeping API data authenticated", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const preflight = await fetch(`${harness.baseUrl}/api/prompt`, {
    method: "OPTIONS",
    headers: {
      origin: "https://even-realities.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(
    preflight.headers.get("access-control-allow-headers"),
    /authorization/i,
  );

  const unauthenticated = await fetch(`${harness.baseUrl}/api/info`, {
    headers: { origin: "https://even-realities.example" },
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    unauthenticated.headers.get("access-control-allow-origin"),
    "*",
  );
});

test("implements the native session/info/update/status/messages/history contracts", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const sessions = await json(
    await fetch(withToken(harness, "/api/sessions?limit=10")),
  );
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].id, harness.sessionId);

  const info = await json(await fetch(withToken(harness, "/api/info")));
  assert.equal(info.body.provider, "claude");
  assert.match(info.body.model, /^Iris/);

  const update = await json(
    await fetch(withToken(harness, "/api/update-check")),
  );
  assert.deepEqual(update.body, {
    packageName: "@evenrealities/even-terminal",
    currentVersion: "0.8.1",
    newestVersion: null,
    updateAvailable: null,
    checkedAt: "2026-07-31T00:00:00.000Z",
  });

  const accepted = await json(
    await post(harness, "/api/prompt", {
      text: "HTTP prompt",
      provider: "claude",
    }),
  );
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.sessionId, harness.sessionId);
  assert.equal(accepted.body.provider, "claude");
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  const status = await json(
    await fetch(
      withToken(
        harness,
        `/api/status?sessionId=${encodeURIComponent(harness.sessionId)}`,
      ),
    ),
  );
  assert.deepEqual(status.body, {
    state: "idle",
    sessionId: harness.sessionId,
    provider: "claude",
  });

  const allMessages = await json(
    await fetch(
      withToken(
        harness,
        `/api/messages?sessionId=${encodeURIComponent(harness.sessionId)}&after=0`,
      ),
    ),
  );
  assert.ok(allMessages.body.messages.length >= 4);
  const cursor = allMessages.body.messages.at(-2).id;
  const after = await json(
    await fetch(
      withToken(
        harness,
        `/api/messages?sessionId=${encodeURIComponent(harness.sessionId)}&after=${cursor}`,
      ),
    ),
  );
  assert.ok(after.body.messages.every((message) => message.id > cursor));

  const history = await json(
    await fetch(
      withToken(
        harness,
        `/api/sessions/${encodeURIComponent(harness.sessionId)}/history?limit=10`,
      ),
    ),
  );
  assert.deepEqual(history.body.history, [
    { role: "user", text: "HTTP prompt" },
    { role: "assistant", text: "Iris: HTTP prompt" },
  ]);
});

test("ignores client-supplied model and reasoning choices", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const accepted = await post(harness, "/api/prompt", {
    text: "profile remains server-owned",
    provider: "claude",
    model: "client-selected-model",
    reasoning_effort: "max",
  });
  assert.equal(accepted.status, 202);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );

  const runtime = await harness.rpc.request("test.state");
  assert.deepEqual(runtime.sessionProfile, {
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    reasoningEffort: "low",
  });
});

test("permission/question/interrupt endpoints retain the official request shapes", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  await post(harness, "/api/prompt", {
    text: "__approval__",
    sessionId: harness.sessionId,
  });
  await waitFor(() =>
    messagesOf(harness).some((message) => message.type === "permission_request"),
  );
  const permission = await json(
    await post(harness, "/api/permission-response", {
      sessionId: harness.sessionId,
      decision: "allow",
      provider: "claude",
    }),
  );
  assert.deepEqual(permission.body, { ok: true });
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  await post(harness, "/api/prompt", {
    text: "__question__",
    sessionId: harness.sessionId,
  });
  await waitFor(() =>
    messagesOf(harness).some((message) => message.type === "user_question"),
  );
  const question = await json(
    await post(harness, "/api/question-response", {
      sessionId: harness.sessionId,
      answer: "local",
    }),
  );
  assert.deepEqual(question.body, { ok: true });
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  await post(harness, "/api/prompt", {
    text: "__slow__",
    sessionId: harness.sessionId,
  });
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "busy");
  const interrupt = await json(
    await post(harness, "/api/interrupt", {
      sessionId: harness.sessionId,
    }),
  );
  assert.deepEqual(interrupt.body, { ok: true });
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
});

test("SSE replays at least 100 ordered Hermes events and honors Last-Event-ID", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  await post(harness, "/api/prompt", {
    text: "__replay_150__",
    sessionId: harness.sessionId,
  });
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  assert.equal(
    messagesOf(harness).filter((message) => message.type === "text_delta")
      .length,
    150,
  );

  const replayResponse = await fetch(
    withToken(
      harness,
      `/api/events?sessionId=${encodeURIComponent(harness.sessionId)}&needReplay=true`,
    ),
  );
  const replayed = await collectSse(
    replayResponse,
    (messages) =>
      messages.filter((message) => message.type === "text_delta").length >= 150,
  );
  assert.equal(
    replayed.filter((message) => message.type === "text_delta").length,
    150,
  );

  const cursor = messagesOf(harness).at(-3).id;
  const cursorResponse = await fetch(
    withToken(
      harness,
      `/api/events?sessionId=${encodeURIComponent(harness.sessionId)}`,
    ),
    { headers: { "last-event-id": String(cursor) } },
  );
  const afterCursor = await collectSse(
    cursorResponse,
    (messages) => messages.length >= 2,
  );
  assert.ok(afterCursor.length >= 2);
  assert.ok(
    afterCursor.every(
      (message) =>
        !(
          message.type === "text_delta" &&
          message.text === "chunk-0;"
        ),
    ),
  );
});

test("keeps debug/codex/expose/metrics/update mutation routes disabled", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());

  const routes = [
    ["GET", "/api/debug/thread/id"],
    ["GET", "/api/debug/status/id"],
    ["GET", "/api/metrics"],
    ["POST", "/api/codex/ensure-app-server"],
    ["POST", "/api/expose"],
    ["POST", "/api/update"],
  ];
  for (const [method, route] of routes) {
    const response = await fetch(withToken(harness, route), { method });
    assert.equal(response.status, 404, `${method} ${route}`);
  }

  const unsupported = await post(harness, "/api/prompt", {
    text: "must not run",
    provider: "codex",
  });
  assert.equal(unsupported.status, 400);
});

test("never logs query strings, tokens, prompts, or supplied URLs", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const promptSecret = "PROMPT-SHOULD-NOT-ENTER-LOGS";
  const suppliedUrl = "https://private.example/path?secret=value";

  await fetch(
    `${harness.baseUrl}/api/sessions?token=wrong-${encodeURIComponent(
      harness.token,
    )}&redirect=${encodeURIComponent(suppliedUrl)}`,
  );
  await post(
    harness,
    `/api/prompt?redirect=${encodeURIComponent(suppliedUrl)}`,
    { text: promptSecret, sessionId: "wrong-session" },
    { bearer: true },
  );

  const logs = [...harness.logs, ...harness.httpLogs].join("\n");
  assert.equal(logs.includes(harness.token), false);
  assert.equal(logs.includes(promptSecret), false);
  assert.equal(logs.includes(suppliedUrl), false);
  assert.equal(logs.includes("?token="), false);
  assert.equal(logs.includes("redirect="), false);
});

test("health is loopback-safe and contains no session or credential data", async (t) => {
  const harness = await createHttpHarness();
  t.after(() => harness.closeHttp());
  const response = await json(await fetch(`${harness.baseUrl}/healthz`));
  assert.equal(response.response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});
