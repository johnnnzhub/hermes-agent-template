import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { delimiter } from "node:path";
import express from "express";
import { EventBuffer } from "./event-buffer.mjs";
import {
  HermesProvider,
  ProviderError,
  providerWireName,
} from "./hermes-provider.mjs";
import { HermesRpcClient } from "./rpc-client.mjs";

const UPSTREAM_PACKAGE = "@evenrealities/even-terminal";
const UPSTREAM_VERSION = "0.8.1";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3456;
const DEFAULT_HERMES_ROOT = "/opt/hermes-agent";

const consoleLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function assertStrongToken(token) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 32 ||
    new Set(token).size < 8
  ) {
    throw new Error(
      "IRIS_TERMINAL_TOKEN must be a strong token of at least 32 bytes",
    );
  }
  return token;
}

export function assertLoopbackHost(host) {
  if (host !== DEFAULT_HOST) {
    throw new Error("Iris Terminal Mode must bind to IPv4 loopback");
  }
  return host;
}

export function hermesGatewaySpawnConfig(env = process.env) {
  const root =
    env.IRIS_TERMINAL_HERMES_ROOT || env.HERMES_PYTHON_SRC_ROOT || DEFAULT_HERMES_ROOT;
  const python = env.IRIS_TERMINAL_PYTHON || "python";
  const inheritedPythonPath = env.PYTHONPATH?.trim();
  return {
    command: python,
    args: ["-m", "tui_gateway.entry"],
    cwd: root,
    env: {
      PYTHONPATH: inheritedPythonPath
        ? `${root}${delimiter}${inheritedPythonPath}`
        : root,
      HERMES_PYTHON_SRC_ROOT: root,
    },
  };
}

function tokenMatches(provided, expected) {
  if (typeof provided !== "string") return false;
  const actualBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function authMiddleware(token, logger) {
  return (req, res, next) => {
    const authorization = req.get("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;
    const queryToken =
      typeof req.query.token === "string" ? req.query.token : null;
    const provided = bearer ?? queryToken;
    if (!tokenMatches(provided, token)) {
      logger.warn(`[terminal-mode] rejected ${req.method} ${req.path}`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

function requestedProvider(req) {
  return req.body?.provider ?? req.query.provider ?? req.query.defaultProvider;
}

function providerCompatibilityMiddleware(req, res, next) {
  const requested = requestedProvider(req);
  if (requested !== undefined && requested !== providerWireName) {
    res.status(400).json({
      error: `Unsupported provider "${String(requested)}". Supported providers: ${providerWireName}`,
    });
    return;
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function parseAfter(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function createApp({
  provider,
  events,
  token,
  logger = consoleLogger,
  now = () => new Date(),
}) {
  assertStrongToken(token);
  if (!provider || !events) throw new Error("provider and events are required");

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Last-Event-ID",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.status(provider.isReady ? 200 : 503).json({
      ok: provider.isReady,
    });
  });

  app.use("/api", authMiddleware(token, logger));
  app.use("/api", providerCompatibilityMiddleware);

  app.get(
    "/api/events",
    asyncRoute(async (req, res) => {
      const sessionId = req.query.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        res
          .status(400)
          .json({ error: "Missing 'sessionId' query parameter" });
        return;
      }
      if (!provider.hasSession(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const headerAfter = req.get("last-event-id");
      const after = parseAfter(headerAfter ?? req.query.after);
      const replay =
        req.query.needReplay === "true" || typeof headerAfter === "string";
      events.subscribe(req, res, sessionId, { replay, after });
    }),
  );

  app.get(
    "/api/sessions",
    asyncRoute(async (req, res) => {
      const limit = Number(req.query.limit) || 10;
      try {
        const sessions = await provider.listSessions(limit);
        res.json({ sessions });
      } catch {
        res.json({ sessions: [], error: "Iris sessions are unavailable" });
      }
    }),
  );

  app.get(
    "/api/info",
    asyncRoute(async (_req, res) => {
      try {
        res.json(await provider.getInfo());
      } catch {
        res.json({
          account: {},
          model: "Iris",
          version: "Unknown",
          provider: providerWireName,
          error: "Iris info is unavailable",
        });
      }
    }),
  );

  app.get("/api/update-check", (_req, res) => {
    res.json({
      packageName: UPSTREAM_PACKAGE,
      currentVersion: UPSTREAM_VERSION,
      newestVersion: null,
      updateAvailable: null,
      checkedAt: now().toISOString(),
    });
  });

  app.post(
    "/api/prompt",
    asyncRoute(async (req, res) => {
      const { text, sessionId } = req.body ?? {};
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing 'text' field" });
        return;
      }
      try {
        // cwd is deliberately not forwarded: Terminal Mode shares the existing
        // Iris HERMES_HOME/persona/memory/tool policy, not client-selected state.
        const result = await provider.prompt(sessionId, text);
        res.status(202).json({
          ok: true,
          sessionId: result.sessionId,
          provider: result.provider,
        });
      } catch (error) {
        const status =
          error instanceof ProviderError ? error.statusCode : 500;
        res.status(status).json({
          error:
            status === 409
              ? error.message
              : status === 404
                ? "Session not found"
                : "Iris could not accept the prompt",
        });
      }
    }),
  );

  app.post(
    "/api/permission-response",
    asyncRoute(async (req, res) => {
      const { sessionId, decision } = req.body ?? {};
      if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await provider.respondPermission(sessionId, decision || "deny");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/question-response",
    asyncRoute(async (req, res) => {
      const { sessionId, answer } = req.body ?? {};
      if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await provider.respondQuestion(sessionId, answer || "skip");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/interrupt",
    asyncRoute(async (req, res) => {
      const { sessionId } = req.body ?? {};
      if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
      }
      if (!provider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await provider.interrupt(sessionId);
      res.json({ ok: true });
    }),
  );

  app.get("/api/status", (req, res) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const status = provider.getStatus(sessionId);
    if (!status) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      state: status.state,
      sessionId,
      provider: status.provider,
    });
  });

  app.get("/api/messages", (req, res) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const after = parseAfter(req.query.after);
    const status = provider.getStatus(sessionId);
    res.json({
      messages: events.getMessages(sessionId, after),
      state: status?.state ?? "idle",
      sessionId,
      provider: status?.provider ?? providerWireName,
    });
  });

  app.get(
    "/api/sessions/:id/history",
    asyncRoute(async (req, res) => {
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 10, 10);
      try {
        const history = await provider.getHistory(req.params.id, limit);
        res.json({ history });
      } catch {
        res.json({ history: [], error: "Iris history is unavailable" });
      }
    }),
  );

  // Hardened overlay: no /debug, /metrics, /codex, /expose, update mutation,
  // or any other upstream-adjacent API route is mounted.
  app.all("/api/*splat", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error, _req, res, _next) => {
    logger.error("[terminal-mode] request failed");
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

export async function startTerminalServer({
  host = process.env.IRIS_TERMINAL_HOST || DEFAULT_HOST,
  port = Number.parseInt(
    process.env.IRIS_TERMINAL_PORT || String(DEFAULT_PORT),
    10,
  ),
  token = process.env.IRIS_TERMINAL_TOKEN,
  hermesHome = process.env.HERMES_HOME,
  logger = consoleLogger,
  rpc,
  provider,
  events,
} = {}) {
  assertLoopbackHost(host);
  assertStrongToken(token);
  const eventBuffer = events ?? new EventBuffer();
  const gatewaySpawn = hermesGatewaySpawnConfig();
  const rpcClient =
    rpc ??
    new HermesRpcClient({
      ...gatewaySpawn,
      logger,
    });
  const hermesProvider =
    provider ??
    new HermesProvider({
      rpc: rpcClient,
      hermesHome,
      emit: (sessionId, message) => eventBuffer.push(sessionId, message),
      logger,
    });

  await hermesProvider.initialize();
  const app = createApp({
    provider: hermesProvider,
    events: eventBuffer,
    token,
    logger,
  });

  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(port, host, () =>
      resolve(listeningServer),
    );
    listeningServer.once("error", reject);
  });
  const address = server.address();
  const listeningPort =
    address && typeof address === "object" ? address.port : port;
  logger.info(
    `[terminal-mode] Iris ready on ${host === DEFAULT_HOST ? "loopback" : "configured host"} port ${listeningPort}`,
  );

  let closing = null;
  return {
    app,
    events: eventBuffer,
    host,
    port: listeningPort,
    provider: hermesProvider,
    rpc: rpcClient,
    server,
    close() {
      if (closing) return closing;
      closing = (async () => {
        eventBuffer.close();
        await new Promise((resolve) => server.close(resolve));
        await hermesProvider.stop();
      })();
      return closing;
    },
  };
}

async function main() {
  const runtime = await startTerminalServer();
  let shuttingDown = false;
  const shutdown = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.close();
    } finally {
      process.exitCode = exitCode;
    }
  };

  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.once("uncaughtException", () => {
    console.error("[terminal-mode] fatal process error");
    void shutdown(1);
  });
  process.once("unhandledRejection", () => {
    console.error("[terminal-mode] fatal async error");
    void shutdown(1);
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch(() => {
    console.error("[terminal-mode] startup failed");
    process.exitCode = 1;
  });
}
