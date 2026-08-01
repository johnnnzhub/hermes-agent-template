import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  messagesOf,
  waitFor,
} from "./helpers/harness.mjs";
import {
  HermesProvider,
  terminalSessionProfile,
} from "../src/hermes-provider.mjs";

test("prewarms one Hermes TUI and persists only session identifiers at 0600", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  assert.equal(harness.provider.isReady, true);
  const statePath = join(
    harness.hermesHome,
    "terminal-mode",
    "session.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(Object.keys(state), ["sessionId", "hermesSessionId"]);
  assert.equal(state.sessionId, harness.sessionId);
  assert.equal(state.hermesSessionId, "iris-session-test-0001");
  assert.notEqual(state.sessionId, state.hermesSessionId);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);

  const runtime = await harness.rpc.request("test.state");
  assert.deepEqual(
    {
      title: runtime.lastCreateParams.title,
      model: runtime.lastCreateParams.model,
      provider: runtime.lastCreateParams.provider,
      reasoningEffort: runtime.lastCreateParams.reasoning_effort,
    },
    terminalSessionProfile,
  );
  assert.deepEqual(runtime.configSetCalls, []);
});

test("migrates the one-field session state without changing its client id", async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), "iris-legacy-session-"));
  const stateDirectory = join(hermesHome, "terminal-mode");
  const statePath = join(stateDirectory, "session.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({ sessionId: "legacy-session-0001" })}\n`,
    { mode: 0o600 },
  );
  let harness;
  try {
    harness = await createHarness({ hermesHome });
    assert.equal(harness.sessionId, "legacy-session-0001");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
      sessionId: "legacy-session-0001",
      hermesSessionId: "legacy-session-0001",
    });
  } finally {
    await harness?.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("exposes one Hermes session and maps text/history/info to the official provider shape", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const sessions = await harness.provider.listSessions(10);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, harness.sessionId);
  assert.equal(sessions[0].title, "Hermes");
  assert.equal(sessions[0].provider, "claude");

  const info = await harness.provider.getInfo();
  assert.equal(info.provider, "claude");
  assert.match(info.model, /^Iris/);
  assert.equal(info.account.organization, "Iris");

  const accepted = await harness.provider.prompt(
    harness.sessionId,
    "olá Iris",
  );
  assert.deepEqual(
    { sessionId: accepted.sessionId, provider: accepted.provider },
    { sessionId: harness.sessionId, provider: "claude" },
  );
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  const messages = messagesOf(harness);
  assert.ok(messages.some((message) => message.type === "user_prompt"));
  assert.ok(
    messages.some(
      (message) =>
        message.type === "text_delta" && message.text === "Iris: olá Iris",
    ),
  );
  assert.ok(
    messages.some(
      (message) =>
        message.type === "result" &&
        message.success === true &&
        message.provider === "claude",
    ),
  );

  const history = await harness.provider.getHistory(harness.sessionId, 10);
  assert.deepEqual(history, [
    { role: "user", text: "olá Iris" },
    { role: "assistant", text: "Iris: olá Iris" },
  ]);

  const resultIndex = messages.findIndex(
    (message) => message.type === "result",
  );
  assert.ok(resultIndex > 1);
  assert.equal(messages[resultIndex - 1].type, "status");
  assert.equal(messages[resultIndex - 1].state, "text_end");
  assert.equal(messages[resultIndex - 2].type, "running_stats");
  assert.equal(typeof messages[resultIndex].durationMs, "number");
  assert.ok(messages[resultIndex].durationMs >= 0);
});

test("keeps the client-visible Hermes title invariant against Hermes title events", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.rpc.request("test.emit_title", { title: "renamed internally" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [session] = await harness.provider.listSessions(10);
  assert.equal(session.title, "Hermes");
});

test("pins a resumed session without changing its client id or global profile", async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), "iris-profile-resume-"));
  const stateDirectory = join(hermesHome, "terminal-mode");
  const statePath = join(stateDirectory, "session.json");
  const profilePath = join(hermesHome, "fake-session-profile.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      sessionId: "stable-g2-session",
      hermesSessionId: "stored-hermes-session",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      model: "gpt-5.5",
      provider: "openai-codex",
      reasoningEffort: "medium",
    }),
    { mode: 0o600 },
  );

  let first;
  let second;
  try {
    first = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_PROFILE_PATH: profilePath },
    });
    assert.equal(first.sessionId, "stable-g2-session");
    const firstRuntime = await first.rpc.request("test.state");
    assert.deepEqual(firstRuntime.sessionProfile, {
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "low",
    });
    assert.deepEqual(
      firstRuntime.configSetCalls.map(({ key }) => key),
      ["model", "reasoning"],
    );
    assert.match(firstRuntime.configSetCalls[0].value, /--session$/);
    assert.equal(
      firstRuntime.configSetCalls[0].confirm_expensive_model,
      true,
    );
    assert.deepEqual(firstRuntime.globalProfile, {
      model: "fake-hermes",
      provider: "fake-global",
      reasoningEffort: "medium",
    });
    await first.close();
    first = null;

    second = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_PROFILE_PATH: profilePath },
    });
    assert.equal(second.sessionId, "stable-g2-session");
    const secondRuntime = await second.rpc.request("test.state");
    assert.deepEqual(secondRuntime.sessionProfile, {
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "low",
    });
    assert.deepEqual(secondRuntime.configSetCalls, []);
    assert.deepEqual(secondRuntime.globalProfile, firstRuntime.globalProfile);
  } finally {
    await first?.close();
    await second?.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("repairs reasoning-only drift without a redundant model switch", async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), "iris-reasoning-drift-"));
  const stateDirectory = join(hermesHome, "terminal-mode");
  const profilePath = join(hermesHome, "fake-session-profile.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, "session.json"),
    `${JSON.stringify({
      sessionId: "stable-g2-reasoning",
      hermesSessionId: "stored-g2-reasoning",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "medium",
    }),
    { mode: 0o600 },
  );

  let harness;
  try {
    harness = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_PROFILE_PATH: profilePath },
    });
    const runtime = await harness.rpc.request("test.state");
    assert.deepEqual(runtime.configSetCalls.map(({ key }) => key), [
      "reasoning",
    ]);
    assert.deepEqual(runtime.sessionProfile, {
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "low",
    });
  } finally {
    await harness?.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("config.set failure keeps the provider unready", async () => {
  class FailingConfigRpc extends EventEmitter {
    isReady = true;

    async start() {}

    async stop() {
      this.isReady = false;
    }

    async request(method) {
      if (method === "session.create") {
        return {
          session_id: "live-fail",
          stored_session_id: "stored-fail",
          messages: [],
          info: {
            model: "gpt-5.5",
            provider: "openai-codex",
            reasoning_effort: "medium",
          },
        };
      }
      if (method === "config.set") {
        throw new Error("simulated config.set failure");
      }
      throw new Error(`unexpected method: ${method}`);
    }
  }

  const hermesHome = await mkdtemp(join(tmpdir(), "iris-profile-fail-"));
  const rpc = new FailingConfigRpc();
  const provider = new HermesProvider({
    rpc,
    hermesHome,
    emit() {},
  });
  try {
    await assert.rejects(
      provider.initialize(),
      /simulated config\.set failure/,
    );
    assert.equal(provider.isReady, false);
  } finally {
    await provider.stop();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("filters Hermes system/tool records from native conversation history", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__history_roles__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  assert.deepEqual(
    await harness.provider.getHistory(harness.sessionId, 10),
    [
      { role: "user", text: "__history_roles__" },
      { role: "assistant", text: "visible history" },
    ],
  );
});

test("maps Hermes tool.start/tool.complete to native tool_start/tool_end", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__tool__");
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  const messages = messagesOf(harness);
  const start = messages.find((message) => message.type === "tool_start");
  const end = messages.find((message) => message.type === "tool_end");
  assert.deepEqual(start, {
    id: start.id,
    type: "tool_start",
    name: "terminal",
    toolId: "tool-1",
  });
  assert.equal(end.name, "terminal");
  assert.equal(end.toolId, "tool-1");
  assert.equal(end.summary, "Ran pwd");
  assert.equal(end.detail.input, "pwd");
  assert.equal(end.detail.output, "/tmp/iris");
});

test("approval waits for a native gesture and translates allow/always/deny", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__approval__");
  await waitFor(
    () => messagesOf(harness).find((message) => message.type === "permission_request"),
  );
  assert.equal(harness.provider.getStatus(harness.sessionId).state, "awaiting");
  const request = messagesOf(harness).find(
    (message) => message.type === "permission_request",
  );
  assert.deepEqual(
    request.options.map((option) => option.key),
    ["allow", "allowAlways", "deny"],
  );

  assert.equal(
    await harness.provider.respondPermission(harness.sessionId, "allowAlways"),
    true,
  );
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" && message.text === "approval:always",
    ),
  );
  assert.ok(
    messagesOf(harness).some(
      (message) =>
        message.type === "permission_result" &&
        message.decision === "always",
    ),
  );
});

test("non-permanent approvals never forward an always decision", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__approval_once__");
  const request = await waitFor(() =>
    messagesOf(harness).find((message) => message.type === "permission_request"),
  );
  assert.deepEqual(
    request.options.map((option) => option.key),
    ["allow", "deny"],
  );
  await harness.provider.respondPermission(harness.sessionId, "allowAlways");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" && message.text === "approval:once",
    ),
  );
});

test("approval timeout auto-denies after the configured 120s seam", async (t) => {
  const harness = await createHarness({ approvalTimeoutMs: 30 });
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__approval__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "permission_result" &&
        message.decision === "denied",
    ),
  );
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" && message.text === "approval:deny",
    ),
  );
});

test("clarify.request becomes user_question and the answer returns to Hermes", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__question__");
  const question = await waitFor(() =>
    messagesOf(harness).find((message) => message.type === "user_question"),
  );
  assert.equal(question.questions[0].question, "Which environment?");
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["staging", "local"],
  );
  await harness.provider.respondQuestion(
    harness.sessionId,
    JSON.stringify({ "Which environment?": "staging" }),
  );
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" && message.text === "answer:staging",
    ),
  );
});

test("secret and sudo requests fail closed with a visible admin notice", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__secret__");
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  assert.ok(
    messagesOf(harness).some(
      (message) =>
        message.type === "notification" &&
        /secret cannot be entered/i.test(message.message),
    ),
  );

  await harness.provider.prompt(harness.sessionId, "__sudo__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "notification" &&
        /sudo password cannot be entered/i.test(message.message),
    ),
  );
});

test("serializes turns and deduplicates an ambiguous immediate retry against history", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__slow__");
  await assert.rejects(
    harness.provider.prompt(harness.sessionId, "must not queue"),
    (error) => error.statusCode === 409,
  );
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  await harness.provider.prompt(harness.sessionId, "same prompt");
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  const retry = await harness.provider.prompt(harness.sessionId, "same prompt");
  assert.equal(retry.deduplicated, true);
  const history = await harness.provider.getHistory(harness.sessionId, 10);
  assert.equal(
    history.filter(
      (message) =>
        message.role === "user" && message.text === "same prompt",
    ).length,
    1,
  );
});

test("interrupt generation discards late deltas/tools and emits one clean result", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__slow__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) => message.type === "text_delta" && message.text === "BEFORE",
    ),
  );
  const marker = messagesOf(harness).at(-1).id;
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  const after = harness.events.getMessages(harness.sessionId, marker);
  assert.equal(
    after.some(
      (message) =>
        (message.type === "text_delta" && message.text === "LATE") ||
        (message.type === "tool_start" && message.toolId === "late-tool"),
    ),
    false,
  );
  assert.ok(
    after.some(
      (message) =>
        message.type === "result" &&
        message.success === false &&
        message.text === "Interrupted by user" &&
        typeof message.durationMs === "number",
    ),
  );
});

test("interrupt ACK alone settles the turn and keeps late events quarantined", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__slow_ack_only__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "text_delta" && message.text === "BEFORE_ACK_ONLY",
    ),
  );
  const marker = messagesOf(harness).at(-1).id;
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = harness.events.getMessages(harness.sessionId, marker);
  assert.equal(
    after.some(
      (message) =>
        (message.type === "text_delta" &&
          message.text === "LATE_ACK_ONLY") ||
        (message.type === "tool_start" &&
          message.toolId === "late-ack-only-tool"),
    ),
    false,
  );
  await harness.provider.prompt(harness.sessionId, "after ack-only interrupt");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" &&
        message.text === "Iris: after ack-only interrupt",
    ),
  );
});

test("interrupt generation drops events that race ahead of the ACK", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__slow_pre_ack__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "text_delta" &&
        message.text === "BEFORE_PRE_ACK",
    ),
  );
  const marker = messagesOf(harness).at(-1).id;
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  const after = harness.events.getMessages(harness.sessionId, marker);
  assert.equal(
    after.some(
      (message) =>
        (message.type === "text_delta" &&
          message.text === "LATE_PRE_ACK") ||
        (message.type === "tool_start" &&
          message.toolId === "late-pre-ack-tool"),
    ),
    false,
  );
});

test("interrupt clears pending approvals so the session returns to idle", async (t) => {
  const harness = await createHarness({ approvalTimeoutMs: 100 });
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__approval__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "awaiting",
  );
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(
    messagesOf(harness).some(
      (message) =>
        message.type === "permission_result" &&
        message.decision === "denied",
    ),
    false,
  );
});

test("normal turn completion clears stale interactive requests", async (t) => {
  const harness = await createHarness({ approvalTimeoutMs: 50 });
  t.after(() => harness.close());

  await harness.provider.prompt(
    harness.sessionId,
    "__approval_then_complete__",
  );
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" &&
        message.text === "completed before approval",
    ),
  );
  assert.equal(
    harness.provider.getStatus(harness.sessionId)?.state,
    "idle",
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    messagesOf(harness).some(
      (message) =>
        message.type === "permission_result" &&
        message.decision === "denied",
    ),
    false,
  );
});

test("unknown interactive *.request fails closed by interrupting the turn", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__unknown_request__");
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");
  const messages = messagesOf(harness);
  assert.ok(
    messages.some(
      (message) =>
        message.type === "error" &&
        /unsupported interactive request/i.test(message.message),
    ),
  );
  assert.equal(
    messages.some(
      (message) => message.type === "text_delta" && message.text === "LATE",
    ),
    false,
  );
});

test("terminal Hermes errors settle the turn even without message.complete", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__error__");
  await waitFor(
    () => harness.provider.getStatus(harness.sessionId)?.state === "idle",
  );
  const messages = messagesOf(harness);
  const errorIndex = messages.findIndex(
    (message) =>
      message.type === "error" &&
      message.message === "simulated terminal turn failure",
  );
  const textEndIndex = messages.findIndex(
    (message, index) =>
      index > errorIndex &&
      message.type === "status" &&
      message.state === "text_end",
  );
  const resultIndex = messages.findIndex(
    (message, index) =>
      index > textEndIndex &&
      message.type === "result" &&
      message.success === false,
  );
  const idleIndex = messages.findIndex(
    (message, index) =>
      index > resultIndex &&
      message.type === "status" &&
      message.state === "idle",
  );
  assert.ok(errorIndex >= 0);
  assert.ok(textEndIndex > errorIndex);
  assert.ok(resultIndex > textEndIndex);
  assert.ok(idleIndex > resultIndex);

  await harness.provider.prompt(harness.sessionId, "after terminal error");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" &&
        message.text === "Iris: after terminal error",
    ),
  );
});

test("recovers the persisted session after a Hermes TUI crash", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const stableId = harness.sessionId;

  await harness.provider.prompt(stableId, "__crash__");
  await waitFor(() => !harness.provider.isReady, {
    message: "provider did not observe the child crash",
  });
  await waitFor(() => harness.provider.isReady, {
    timeoutMs: 3_000,
    message: "provider did not recover the child",
  });
  assert.equal(harness.provider.stableSessionId, stableId);

  await harness.provider.prompt(stableId, "after restart");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "result" &&
        message.text === "Iris: after restart",
    ),
  );
});

test("keeps the client session stable when an empty Hermes draft expires", async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), "iris-draft-recovery-"));
  let first;
  let second;
  try {
    first = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_STORED_SESSION_ID: "draft-one" },
    });
    const stableId = first.sessionId;
    await first.close();
    first = null;

    second = await createHarness({
      hermesHome,
      fakeEnv: {
        FAKE_RESUME_MODE: "missing",
        FAKE_STORED_SESSION_ID: "draft-two",
      },
    });
    assert.equal(second.sessionId, stableId);
    const state = JSON.parse(
      await readFile(
        join(hermesHome, "terminal-mode", "session.json"),
        "utf8",
      ),
    );
    assert.equal(state.sessionId, stableId);
    assert.equal(state.hermesSessionId, "draft-two");
  } finally {
    await first?.close();
    await second?.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("restart reconstructs the ambiguous accepted prompt from history", async () => {
  const hermesHome = await mkdtemp(join(tmpdir(), "iris-restart-dedupe-"));
  const historyPath = join(hermesHome, "fake-history.json");
  let first;
  let second;
  try {
    first = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_HISTORY_PATH: historyPath },
    });
    const stableId = first.sessionId;
    await first.provider.prompt(stableId, "__crash__");
    await waitFor(() => !first.provider.isReady);
    await first.close();
    first = null;

    second = await createHarness({
      hermesHome,
      fakeEnv: { FAKE_HISTORY_PATH: historyPath },
    });
    assert.equal(second.sessionId, stableId);
    const retry = await second.provider.prompt(stableId, "__crash__");
    assert.equal(retry.deduplicated, true);
    assert.equal(
      (await second.provider.getHistory(stableId, 10)).filter(
        (message) =>
          message.role === "user" && message.text === "__crash__",
      ).length,
      1,
    );
  } finally {
    await first?.close();
    await second?.close();
    await rm(hermesHome, { recursive: true, force: true });
  }
});

test("provider.stop terminates the prewarmed Hermes TUI child", async () => {
  const harness = await createHarness();
  const child = harness.rpc.child;
  assert.ok(child?.pid);
  await harness.close();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
    message: "Hermes TUI child remained alive after provider.stop",
  });
});
