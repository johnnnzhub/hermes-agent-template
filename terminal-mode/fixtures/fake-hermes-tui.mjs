import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const liveSessionId = `live-${process.pid}`;
const defaultStoredSessionId =
  process.env.FAKE_STORED_SESSION_ID || "iris-session-test-0001";
const historyPath = process.env.FAKE_HISTORY_PATH;
let storedSessionId = defaultStoredSessionId;
let history = loadHistory();
let active = null;
let requestCounter = 0;

function loadHistory() {
  if (!historyPath) return [];
  try {
    const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  if (!historyPath) return;
  writeFileSync(historyPath, JSON.stringify(history), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result = {}) {
  write({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function event(type, payload, sessionId = liveSessionId) {
  const params = { type, session_id: sessionId };
  if (payload !== undefined) params.payload = payload;
  write({ jsonrpc: "2.0", method: "event", params });
}

function sessionInfo() {
  return {
    model: "fake-hermes",
    version: "2026.test",
    cwd: "/tmp/iris",
    tools: { hermes: ["terminal", "web_search"] },
    skills: {},
  };
}

function complete(text, status = "complete") {
  history.push({ role: "assistant", text });
  persistHistory();
  event("message.complete", {
    text,
    status,
    usage: { input: 3, output: 5, total: 8, calls: 1, cost_usd: 0 },
  });
  event("session.info", sessionInfo());
  active = null;
}

function beginPrompt(text) {
  history.push({ role: "user", text });
  persistHistory();
  active = { text };
  event("message.start");

  if (text === "__tool__") {
    event("tool.start", {
      name: "terminal",
      tool_id: "tool-1",
      args_text: "pwd",
      context: "pwd",
    });
    event("message.delta", { text: "working " });
    event("tool.complete", {
      name: "terminal",
      tool_id: "tool-1",
      summary: "Ran pwd",
      result_text: "/tmp/iris",
    });
    complete("tool complete");
    return;
  }

  if (text === "__history_roles__") {
    history.push(
      { role: "system", text: "must stay private" },
      { role: "tool", text: "must stay private too" },
    );
    persistHistory();
    event("message.delta", { text: "visible history" });
    complete("visible history");
    return;
  }

  if (text === "__approval__") {
    event("approval.request", {
      command: "touch /tmp/iris-approved",
      description: "Create a disposable canary file",
      allow_permanent: true,
    });
    active.kind = "approval";
    return;
  }

  if (text === "__approval_once__") {
    event("approval.request", {
      command: "touch /tmp/iris-approved-once",
      description: "Create a one-time disposable canary file",
      allow_permanent: false,
    });
    active.kind = "approval";
    return;
  }

  if (text === "__approval_then_complete__") {
    event("approval.request", {
      command: "touch /tmp/iris-never-runs",
      description: "Approval that becomes stale when the turn completes",
      allow_permanent: false,
    });
    active.kind = "approval";
    setImmediate(() => complete("completed before approval"));
    return;
  }

  if (text === "__question__") {
    const requestId = `question-${++requestCounter}`;
    event("clarify.request", {
      request_id: requestId,
      question: "Which environment?",
      choices: ["staging", "local"],
    });
    active.kind = "question";
    active.requestId = requestId;
    return;
  }

  if (text === "__secret__") {
    const requestId = `secret-${++requestCounter}`;
    event("secret.request", {
      request_id: requestId,
      env_var: "IRIS_SECRET",
      prompt: "Enter secret",
    });
    active.kind = "secret";
    active.requestId = requestId;
    return;
  }

  if (text === "__sudo__") {
    const requestId = `sudo-${++requestCounter}`;
    event("sudo.request", { request_id: requestId });
    active.kind = "sudo";
    active.requestId = requestId;
    return;
  }

  if (text === "__unknown_request__") {
    event("future.request", { request_id: `future-${++requestCounter}` });
    active.kind = "unknown";
    return;
  }

  if (text === "__slow__") {
    event("message.delta", { text: "BEFORE" });
    active.kind = "slow";
    return;
  }

  if (text === "__slow_ack_only__") {
    event("message.delta", { text: "BEFORE_ACK_ONLY" });
    active.kind = "slow-ack-only";
    return;
  }

  if (text === "__slow_pre_ack__") {
    event("message.delta", { text: "BEFORE_PRE_ACK" });
    active.kind = "slow-pre-ack";
    return;
  }

  if (text === "__crash__") {
    setTimeout(() => process.exit(23), 5);
    return;
  }

  if (text === "__error__") {
    event("message.delta", { text: "partial response" });
    event("error", { message: "simulated terminal turn failure" });
    event("session.info", sessionInfo());
    active = null;
    return;
  }

  const replayMatch = /^__replay_(\d+)__$/.exec(text);
  if (replayMatch) {
    const count = Number(replayMatch[1]);
    for (let index = 0; index < count; index += 1) {
      event("message.delta", { text: `chunk-${index};` });
    }
    complete(`replayed ${count}`);
    return;
  }

  event("message.delta", { text: `Iris: ${text}` });
  complete(`Iris: ${text}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = request;

  switch (method) {
    case "session.create": {
      storedSessionId = defaultStoredSessionId;
      ok(id, {
        session_id: liveSessionId,
        stored_session_id: storedSessionId,
        messages: [],
        message_count: 0,
        info: sessionInfo(),
      });
      setImmediate(() => event("session.info", sessionInfo()));
      break;
    }
    case "session.resume": {
      if (process.env.FAKE_RESUME_MODE === "missing") {
        error(id, 4007, "session not found");
        break;
      }
      storedSessionId = params.session_id || defaultStoredSessionId;
      ok(id, {
        session_id: liveSessionId,
        resumed: storedSessionId,
        messages: history,
        message_count: history.length,
        info: sessionInfo(),
      });
      setImmediate(() => event("session.info", sessionInfo()));
      break;
    }
    case "session.history":
      ok(id, { count: history.length, messages: history });
      break;
    case "prompt.submit":
      ok(id, { status: "streaming" });
      setImmediate(() => beginPrompt(String(params.text ?? "")));
      break;
    case "approval.respond": {
      ok(id, { resolved: Boolean(active?.kind === "approval") });
      if (active?.kind === "approval") {
        const choice = String(params.choice ?? "deny");
        setImmediate(() => complete(`approval:${choice}`));
      }
      break;
    }
    case "clarify.respond": {
      ok(id, { status: "ok" });
      if (active?.kind === "question") {
        const answer = String(params.answer ?? "skip");
        setImmediate(() => complete(`answer:${answer}`));
      }
      break;
    }
    case "secret.respond": {
      ok(id, { status: "ok" });
      if (active?.kind === "secret") {
        setImmediate(() => complete("secret:blocked"));
      }
      break;
    }
    case "sudo.respond": {
      ok(id, { status: "ok" });
      if (active?.kind === "sudo") {
        setImmediate(() => complete("sudo:blocked"));
      }
      break;
    }
    case "session.interrupt": {
      const interrupted = active;
      if (interrupted?.kind === "slow-pre-ack") {
        event("message.delta", { text: "LATE_PRE_ACK" });
        event("tool.start", {
          name: "terminal",
          tool_id: "late-pre-ack-tool",
          args_text: "echo late",
        });
        ok(id, { status: "interrupted" });
        setImmediate(() => {
          event("message.complete", {
            text: "LATE_PRE_ACK",
            status: "interrupted",
            usage: { input: 0, output: 0, total: 0, calls: 0 },
          });
          event("session.info", sessionInfo());
          active = null;
        });
        break;
      }
      ok(id, { status: "interrupted" });
      if (interrupted?.kind === "slow-ack-only") {
        setTimeout(() => {
          event("message.delta", { text: "LATE_ACK_ONLY" });
          event("tool.start", {
            name: "terminal",
            tool_id: "late-ack-only-tool",
            args_text: "echo late",
          });
          active = null;
        }, 20);
        break;
      }
      if (interrupted) {
        setImmediate(() => {
          event("message.delta", { text: "LATE" });
          event("tool.start", {
            name: "terminal",
            tool_id: "late-tool",
            args_text: "echo late",
          });
          event("message.complete", {
            text: "LATE",
            status: "interrupted",
            usage: { input: 0, output: 0, total: 0, calls: 0 },
          });
          event("session.info", sessionInfo());
          active = null;
        });
      }
      break;
    }
    default:
      error(id, -32601, `unknown method: ${method}`);
  }
});

input.once("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

write({
  jsonrpc: "2.0",
  method: "event",
  params: { type: "gateway.ready", session_id: "", payload: {} },
});
