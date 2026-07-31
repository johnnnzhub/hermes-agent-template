import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

export class RpcError extends Error {
  constructor(message, { rpcCode, cause } = {}) {
    super(message, { cause });
    this.name = "RpcError";
    this.rpcCode = rpcCode;
  }
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

export class HermesRpcClient extends EventEmitter {
  constructor({
    command = "python",
    args = ["-m", "tui_gateway.entry"],
    cwd,
    env = {},
    logger = silentLogger,
    spawnImpl = nodeSpawn,
    requestTimeoutMs = 30_000,
    startupTimeoutMs = 60_000,
    restartMinMs = 250,
    restartMaxMs = 5_000,
    stopTimeoutMs = 2_000,
    stopKillTimeoutMs = 1_000,
  } = {}) {
    super();
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...env };
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.restartMinMs = restartMinMs;
    this.restartMaxMs = restartMaxMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.stopKillTimeoutMs = stopKillTimeoutMs;

    this.child = null;
    this.ready = false;
    this.stopping = false;
    this.nextId = 1;
    this.pending = new Map();
    this.readyWaiters = new Set();
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.processGeneration = 0;
  }

  get isReady() {
    return this.ready && Boolean(this.child);
  }

  async start() {
    this.stopping = false;
    if (!this.child && !this.restartTimer) this.#spawn();
    return this.waitUntilReady(this.startupTimeoutMs);
  }

  waitUntilReady(timeoutMs = this.startupTimeoutMs) {
    if (this.isReady) return Promise.resolve();
    if (this.stopping) {
      return Promise.reject(new RpcError("Hermes TUI is stopping"));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new RpcError("Hermes TUI did not become ready in time"));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.readyWaiters.add(waiter);
    });
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof method !== "string" || !method) {
      throw new RpcError("JSON-RPC method is required");
    }
    await this.start();
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new RpcError("Hermes TUI command channel is unavailable");
    }

    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Hermes TUI request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });

      const frame = `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      })}\n`;
      child.stdin.write(frame, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new RpcError("Failed to write to Hermes TUI", { cause: error }));
      });
    });
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.#rejectPending(new RpcError("Hermes TUI stopped"));
    this.#rejectReadyWaiters(new RpcError("Hermes TUI stopped"));

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    const exitedGracefully = await this.#signalAndWait(
      child,
      "SIGTERM",
      this.stopTimeoutMs,
    );
    if (exitedGracefully) return;
    this.logger.warn(
      "[terminal-mode] Hermes TUI ignored SIGTERM; escalating to SIGKILL",
    );
    await this.#signalAndWait(child, "SIGKILL", this.stopKillTimeoutMs);
  }

  #signalAndWait(child, signal, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      try {
        const signalled = child.kill(signal);
        if (
          !signalled &&
          (child.exitCode !== null || child.signalCode !== null)
        ) {
          finish(true);
        }
      } catch {
        finish(child.exitCode !== null || child.signalCode !== null);
      }
    });
  }

  #spawn() {
    if (this.stopping || this.child) return;
    this.processGeneration += 1;
    const generation = this.processGeneration;
    this.ready = false;

    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.logger.error("[terminal-mode] Hermes TUI spawn failed");
      this.emit("crash", { generation });
      this.#scheduleRestart();
      return;
    }
    this.child = child;

    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    stdout.on("line", (line) => this.#onLine(line, generation));

    // Drain stderr so a verbose child cannot block. Its contents can include
    // prompts, commands, URLs, or credentials and are intentionally discarded.
    child.stderr.on("data", () => {});

    child.once("error", () => {
      this.logger.error("[terminal-mode] Hermes TUI process error");
    });
    child.once("exit", () => {
      stdout.close();
      if (this.child === child) this.child = null;
      const wasReady = this.ready;
      this.ready = false;
      this.#rejectPending(new RpcError("Hermes TUI exited"));
      if (!this.stopping) {
        this.logger.warn("[terminal-mode] Hermes TUI exited; restarting");
        this.emit("crash", { generation, wasReady });
        this.#scheduleRestart();
      }
    });
  }

  #onLine(line, generation) {
    if (generation !== this.processGeneration || !line) return;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024) {
      this.emit("protocolError", { generation });
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", { generation });
      return;
    }

    if (message?.method === "event" && message.params) {
      const event = message.params;
      if (event.type === "gateway.ready") {
        this.ready = true;
        this.restartAttempt = 0;
        this.#resolveReadyWaiters();
        this.emit("ready", { generation, payload: event.payload ?? {} });
      }
      this.emit("event", event, generation);
      return;
    }

    if (message?.id === undefined || message?.id === null) return;
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (message.error) {
      pending.reject(
        new RpcError(
          typeof message.error.message === "string"
            ? message.error.message
            : "Hermes TUI JSON-RPC error",
          { rpcCode: message.error.code },
        ),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(
      this.restartMinMs * 2 ** this.restartAttempt,
      this.restartMaxMs,
    );
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.#spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  #resolveReadyWaiters() {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  #rejectReadyWaiters(error) {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
