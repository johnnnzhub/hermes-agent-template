import { RpcError } from "./rpc-client.mjs";
import {
  createStableSessionId,
  SessionStore,
} from "./session-store.mjs";

const WIRE_PROVIDER = "claude";
const DEFAULT_TITLE = "Hermes";
const REQUIRED_MODEL = "gpt-5.6-sol";
const REQUIRED_PROVIDER = "openai-codex";
const REQUIRED_REASONING = "low";
const REQUIRED_MODEL_SWITCH =
  `${REQUIRED_MODEL} --provider ${REQUIRED_PROVIDER} --session`;
const PROFILE_READY_TIMEOUT_MS = 30_000;

export const terminalSessionProfile = Object.freeze({
  title: DEFAULT_TITLE,
  model: REQUIRED_MODEL,
  provider: REQUIRED_PROVIDER,
  reasoningEffort: REQUIRED_REASONING,
});

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

export class ProviderError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
  }
}

function messageText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  return "";
}

function normalizeAnswer(answer) {
  if (typeof answer !== "string") return "skip";
  try {
    const parsed = JSON.parse(answer);
    if (parsed && typeof parsed === "object") {
      const first = Object.values(parsed).find(
        (value) => typeof value === "string" && value.trim(),
      );
      if (first) return first;
    }
  } catch {
    // Plain text is the normal native-client shape.
  }
  return answer.trim() || "skip";
}

function isSessionMissing(error) {
  return (
    error instanceof RpcError &&
    (error.rpcCode === 4007 || /session not found/i.test(error.message))
  );
}

export class HermesProvider {
  constructor({
    rpc,
    hermesHome,
    emit,
    logger = silentLogger,
    approvalTimeoutMs = 120_000,
    questionTimeoutMs = 120_000,
    dedupeWindowMs = 15_000,
    generationGuard = true,
  }) {
    if (!rpc) throw new Error("rpc is required");
    if (typeof emit !== "function") throw new Error("emit is required");
    this.rpc = rpc;
    this.emit = emit;
    this.logger = logger;
    this.title = DEFAULT_TITLE;
    this.store = new SessionStore(hermesHome);
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.questionTimeoutMs = questionTimeoutMs;
    this.dedupeWindowMs = dedupeWindowMs;
    this.generationGuard = generationGuard;

    this.stableSessionId = null;
    this.hermesSessionId = null;
    this.liveSessionId = null;
    this.initialized = false;
    this.initializePromise = null;
    this.recoverPromise = null;
    this.profilePromise = null;
    this.profileReady = false;
    this.profileWaiters = new Set();
    this.metadata = {
      cwd: "",
      model: "",
      provider: "",
      reasoningEffort: "",
      version: "Unknown",
      title: DEFAULT_TITLE,
      timestamp: new Date().toISOString(),
    };

    this.turnGeneration = 0;
    this.activeGeneration = 0;
    this.eventGeneration = 0;
    this.turnActive = false;
    this.turnStartedAt = 0;
    this.discardInterrupted = false;
    this.currentText = "";
    this.lastAcceptedPrompt = null;
    this.toolCalls = new Map();
    this.pendingApprovals = [];
    this.pendingQuestions = [];
    this.requestSequence = 0;

    rpc.on("event", (event) => {
      void this.#handleEvent(event).catch(() => {
        this.logger.error("[terminal-mode] Hermes event handling failed");
      });
    });
    rpc.on("ready", () => {
      if (this.initialized) {
        void this.#recover().catch(() => {
          this.logger.error("[terminal-mode] Hermes session recovery failed");
        });
      }
    });
    rpc.on("crash", () => this.#handleCrash());
    rpc.on("protocolError", () => {
      this.#safeEmit({
        type: "error",
        message: "Iris received an invalid local agent event.",
      });
    });
  }

  get isReady() {
    return Boolean(
      this.rpc.isReady &&
        this.liveSessionId &&
        this.stableSessionId &&
        this.profileReady,
    );
  }

  async initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      const persisted = await this.store.read();
      this.stableSessionId =
        persisted?.sessionId ?? createStableSessionId();
      this.hermesSessionId = persisted?.hermesSessionId ?? null;
      await this.rpc.start();
      this.initialized = true;
      await this.#recover();
      return this.stableSessionId;
    })();
    try {
      return await this.initializePromise;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  async stop() {
    for (const pending of [
      ...this.pendingApprovals,
      ...this.pendingQuestions,
    ]) {
      clearTimeout(pending.timer);
    }
    this.pendingApprovals = [];
    this.pendingQuestions = [];
    this.initialized = false;
    this.liveSessionId = null;
    this.profileReady = false;
    this.#rejectProfileWaiters(
      new ProviderError("Iris terminal profile stopped", 503),
    );
    await this.rpc.stop();
  }

  hasSession(sessionId) {
    return Boolean(sessionId && sessionId === this.stableSessionId);
  }

  getStatus(sessionId) {
    if (!this.hasSession(sessionId)) return null;
    return {
      state: this.#state(),
      provider: WIRE_PROVIDER,
      // Nada limita a duracao de um turno: turnActive so cai com result, error ou crash.
      // Sem expor ha quanto tempo ele dura, o cliente nao consegue distinguir "pensando"
      // de "travado" e fica em PENSANDO para sempre.
      turnDurationMs: this.#turnDurationMs(),
    };
  }

  async getSessionStatus(sessionId) {
    this.#assertSession(sessionId);
    return this.#state();
  }

  async listSessions(limit = 10) {
    await this.#ensureSession();
    if (limit < 1) return [];
    return [
      {
        id: this.stableSessionId,
        title: DEFAULT_TITLE,
        timestamp: this.metadata.timestamp,
        cwd: this.metadata.cwd,
        provider: WIRE_PROVIDER,
        status: this.#state(),
      },
    ];
  }

  async getInfo() {
    await this.#ensureSession();
    return {
      account: {
        organization: "Iris",
      },
      model:
        this.metadata.model && this.metadata.model !== "Hermes"
          ? `Iris · ${this.metadata.model}`
          : "Iris",
      version: this.metadata.version || "Unknown",
      provider: WIRE_PROVIDER,
    };
  }

  async getHistory(sessionId, limit = 10) {
    this.#assertSession(sessionId);
    await this.#ensureSession();
    const result = await this.rpc.request("session.history", {
      session_id: this.liveSessionId,
    });
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return messages
      .filter(
        (message) =>
          message?.role === "user" || message?.role === "assistant",
      )
      .map((message) => ({
        role: message.role,
        text: messageText(message),
      }))
      .filter((message) => message.text)
      .slice(-Math.min(Math.max(Number(limit) || 10, 1), 50));
  }

  async prompt(sessionId, text) {
    if (sessionId) this.#assertSession(sessionId);
    if (typeof text !== "string" || !text.trim()) {
      throw new ProviderError("Missing 'text' field", 400);
    }
    await this.#ensureSession();
    if (this.turnActive) {
      throw new ProviderError(
        "Iris is busy; wait for the current turn or interrupt it",
        409,
      );
    }

    const normalizedText = text.trim();
    if (await this.#isAmbiguousRetry(normalizedText)) {
      return {
        sessionId: this.stableSessionId,
        provider: WIRE_PROVIDER,
        deduplicated: true,
      };
    }

    const generation = ++this.turnGeneration;
    this.activeGeneration = generation;
    this.eventGeneration = 0;
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.discardInterrupted = false;
    this.currentText = "";
    this.metadata.timestamp = new Date().toISOString();

    try {
      await this.rpc.request("prompt.submit", {
        session_id: this.liveSessionId,
        text: normalizedText,
      });
      this.lastAcceptedPrompt = {
        text: normalizedText,
        acceptedAt: Date.now(),
      };
      this.#safeEmit({ type: "user_prompt", text: normalizedText });
      this.#safeEmit({
        type: "status",
        state: "busy",
        sessionId: this.stableSessionId,
      });
      return {
        sessionId: this.stableSessionId,
        provider: WIRE_PROVIDER,
      };
    } catch (error) {
      if (this.activeGeneration === generation) {
        this.turnActive = false;
        this.turnStartedAt = 0;
        this.activeGeneration = 0;
        this.eventGeneration = 0;
      }
      throw new ProviderError("Iris could not accept the prompt", 503);
    }
  }

  async respondPermission(sessionId, decision = "deny") {
    this.#assertSession(sessionId);
    const pending = this.pendingApprovals.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);

    let choice = "deny";
    let resultDecision = "denied";
    if (decision === "allowAlways" && pending.allowPermanent) {
      choice = "always";
      resultDecision = "always";
    } else if (decision === "allow" || decision === "allowAlways") {
      choice = "once";
      resultDecision = "allowed";
    }

    try {
      await this.rpc.request("approval.respond", {
        session_id: this.liveSessionId,
        choice,
      });
      this.#safeEmit({
        type: "permission_result",
        toolName: pending.toolName,
        summary: pending.description,
        decision: resultDecision,
      });
      return true;
    } catch {
      this.#safeEmit({
        type: "error",
        message: "Iris could not deliver the tool decision.",
      });
      return false;
    }
  }

  async respondQuestion(sessionId, answer = "skip") {
    this.#assertSession(sessionId);
    const pending = this.pendingQuestions.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);
    const normalized = normalizeAnswer(answer);

    try {
      await this.rpc.request("clarify.respond", {
        session_id: this.liveSessionId,
        request_id: pending.requestId,
        answer: normalized,
      });
      this.#safeEmit({
        type: "question_answer",
        answers: { [pending.question]: normalized },
      });
      return true;
    } catch {
      this.#safeEmit({
        type: "error",
        message: "Iris could not deliver the answer.",
      });
      return false;
    }
  }

  async interrupt(sessionId) {
    this.#assertSession(sessionId);
    await this.#ensureSession();
    const hadActiveTurn = this.turnActive;
    if (hadActiveTurn) {
      this.discardInterrupted = this.generationGuard;
      this.eventGeneration = 0;
      this.activeGeneration = ++this.turnGeneration;
    }
    try {
      await this.rpc.request("session.interrupt", {
        session_id: this.liveSessionId,
      });
    } catch (error) {
      if (hadActiveTurn && this.turnActive) {
        this.discardInterrupted = false;
        this.#settleError();
      }
      throw error;
    }
    if (hadActiveTurn && this.turnActive) {
      this.#settleInterrupted();
    }
    return true;
  }

  async #ensureSession() {
    if (!this.initialized) await this.initialize();
    if (this.isReady) return;
    if (this.rpc.isReady && this.liveSessionId && this.stableSessionId) {
      await this.#ensureRequiredProfile();
      if (this.isReady) return;
    }
    await this.rpc.start();
    await this.#recover();
    if (!this.isReady) {
      throw new ProviderError("Iris session is unavailable", 503);
    }
  }

  async #recover() {
    if (this.recoverPromise) return this.recoverPromise;
    this.recoverPromise = (async () => {
      if (!this.rpc.isReady) return;
      this.liveSessionId = null;
      this.profileReady = false;
      this.metadata.model = "";
      this.metadata.provider = "";
      this.metadata.reasoningEffort = "";

      if (this.hermesSessionId) {
        try {
          const resumed = await this.rpc.request("session.resume", {
            session_id: this.hermesSessionId,
            cols: 80,
          });
          if (!resumed.session_id) {
            throw new RpcError("Hermes resume returned no live session id");
          }
          this.liveSessionId = resumed.session_id;
          if (
            typeof resumed.resumed === "string" &&
            resumed.resumed.trim()
          ) {
            this.hermesSessionId = resumed.resumed.trim();
          }
          await this.store.write({
            sessionId: this.stableSessionId,
            hermesSessionId: this.hermesSessionId,
          });
          this.#updateMetadata(resumed.info);
          await this.#ensureRequiredProfile(resumed.info);
          await this.#rememberRecoveredPrompt(resumed.messages);
          return;
        } catch (error) {
          if (!isSessionMissing(error)) throw error;
        }
      }

      const created = await this.rpc.request("session.create", {
        title: this.title,
        source: "even-terminal",
        cols: 80,
        close_on_disconnect: false,
        model: REQUIRED_MODEL,
        provider: REQUIRED_PROVIDER,
        reasoning_effort: REQUIRED_REASONING,
      });
      if (!created.session_id || !created.stored_session_id) {
        throw new RpcError("Hermes create returned an incomplete session");
      }
      this.liveSessionId = created.session_id;
      this.hermesSessionId = created.stored_session_id;
      await this.store.write({
        sessionId: this.stableSessionId,
        hermesSessionId: this.hermesSessionId,
      });
      this.#updateMetadata(created.info);
      await this.#ensureRequiredProfile(created.info);
    })();

    try {
      await this.recoverPromise;
    } finally {
      this.recoverPromise = null;
    }
  }

  async #isAmbiguousRetry(text) {
    const recent = this.lastAcceptedPrompt;
    if (
      !recent ||
      recent.text !== text ||
      Date.now() - recent.acceptedAt > this.dedupeWindowMs
    ) {
      return false;
    }
    try {
      const result = await this.rpc.request("session.history", {
        session_id: this.liveSessionId,
      });
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const lastUser = [...messages]
        .reverse()
        .find((message) => message?.role === "user");
      return messageText(lastUser).trim() === text;
    } catch {
      return false;
    }
  }

  async #rememberRecoveredPrompt(resumedMessages) {
    let messages = resumedMessages;
    if (!Array.isArray(messages)) {
      try {
        const history = await this.rpc.request("session.history", {
          session_id: this.liveSessionId,
        });
        messages = history.messages;
      } catch {
        return;
      }
    }
    if (!Array.isArray(messages)) return;
    const lastUser = [...messages]
      .reverse()
      .find((message) => message?.role === "user");
    const text = messageText(lastUser).trim();
    if (!text) return;
    this.lastAcceptedPrompt = {
      text,
      acceptedAt: Date.now(),
    };
  }

  async #handleEvent(event) {
    const type = event?.type;
    const payload = event?.payload ?? {};
    if (typeof type !== "string") return;

    if (type === "gateway.ready") return;
    if (
      event.session_id &&
      this.liveSessionId &&
      event.session_id !== this.liveSessionId
    ) {
      return;
    }

    if (type === "session.info") {
      this.#updateMetadata(payload);
      if (
        this.initialized &&
        this.liveSessionId &&
        this.profileReady &&
        !this.#profileMatches()
      ) {
        void this.#ensureRequiredProfile(payload, { probeActive: true }).catch(() => {
          this.logger.error(
            "[terminal-mode] required G2 session profile could not be restored",
          );
        });
      }
      if (this.discardInterrupted && this.turnActive) {
        this.#settleInterrupted();
      }
      return;
    }
    if (type === "session.title") {
      // The native client exposes exactly one server-owned session. Hermes may
      // derive or mutate its internal DB title, but that must never rename the
      // G2 surface or make "New Session" appear to create another identity.
      return;
    }

    if (type === "message.start") {
      if (this.discardInterrupted) return;
      if (!this.turnActive) {
        this.activeGeneration = ++this.turnGeneration;
        this.turnActive = true;
        this.turnStartedAt = Date.now();
      }
      this.eventGeneration = this.activeGeneration;
      this.currentText = "";
      this.#safeEmit({
        type: "status",
        state: "text_start",
        sessionId: this.stableSessionId,
      });
      return;
    }

    if (type === "message.delta") {
      if (!this.#acceptTurnEvent()) return;
      const text =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.rendered === "string"
            ? payload.rendered
            : "";
      if (!text) return;
      this.currentText += text;
      this.#safeEmit({ type: "text_delta", text });
      return;
    }

    if (type === "message.complete") {
      if (this.discardInterrupted) {
        if (this.turnActive) this.#settleInterrupted();
        return;
      }
      if (!this.#acceptTurnEvent()) return;
      const text =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.rendered === "string"
            ? payload.rendered
            : this.currentText;
      const usage = payload.usage ?? {};
      const durationMs = this.#turnDurationMs();
      const inputTokens = Number(usage.input) || 0;
      const outputTokens = Number(usage.output) || 0;
      this.#safeEmit({
        type: "running_stats",
        durationMs,
        inputTokens,
        outputTokens,
      });
      this.#safeEmit({
        type: "status",
        state: "text_end",
        sessionId: this.stableSessionId,
      });
      this.#safeEmit({
        type: "result",
        success: payload.status === undefined || payload.status === "complete",
        text,
        sessionId: this.stableSessionId,
        costUsd: Number(usage.cost_usd) || 0,
        provider: WIRE_PROVIDER,
        turns: 1,
        durationMs,
        inputTokens,
        outputTokens,
      });
      this.#finishTurn();
      return;
    }

    if (type === "tool.start") {
      if (!this.#acceptTurnEvent()) return;
      const toolId =
        typeof payload.tool_id === "string"
          ? payload.tool_id
          : `hermes-tool-${++this.requestSequence}`;
      const name =
        typeof payload.name === "string" && payload.name
          ? payload.name
          : "Hermes";
      this.toolCalls.set(toolId, {
        name,
        input: payload.args_text ?? payload.context ?? "",
      });
      this.#safeEmit({ type: "tool_start", name, toolId });
      return;
    }

    if (type === "tool.complete") {
      if (!this.#acceptTurnEvent()) return;
      const toolId =
        typeof payload.tool_id === "string"
          ? payload.tool_id
          : `hermes-tool-${++this.requestSequence}`;
      const pending = this.toolCalls.get(toolId) ?? {};
      this.toolCalls.delete(toolId);
      const name = payload.name || pending.name || "Hermes";
      const output = payload.result_text ?? payload.error ?? "";
      this.#safeEmit({
        type: "tool_end",
        name,
        toolId,
        summary:
          payload.summary ||
          payload.context ||
          (payload.error ? `${name} failed` : `${name} completed`),
        detail: {
          input: pending.input ?? "",
          output,
        },
      });
      return;
    }

    if (type === "approval.request") {
      await this.#handleApproval(payload);
      return;
    }

    if (type === "clarify.request") {
      await this.#handleQuestion(payload);
      return;
    }

    if (type === "secret.request" || type === "sudo.request") {
      await this.#failClosedCredentialRequest(type, payload);
      return;
    }

    if (type.endsWith(".request")) {
      this.#safeEmit({
        type: "error",
        message:
          "Iris blocked an unsupported interactive request. Use the admin dashboard.",
      });
      await this.interrupt(this.stableSessionId).catch(() => {});
      return;
    }

    if (type === "error") {
      const message =
        typeof payload.message === "string" && payload.message
          ? payload.message
          : "Iris encountered an agent error.";
      this.#safeEmit({ type: "error", message });
      if (this.turnActive && !this.discardInterrupted) {
        this.#settleError();
      }
      return;
    }

    if (type === "status.update" && typeof payload.text === "string") {
      this.#safeEmit({
        type: "notification",
        title: "Iris",
        message: payload.text,
      });
    }
  }

  async #handleApproval(payload) {
    const allowPermanent = payload.allow_permanent !== false;
    const toolName =
      typeof payload.tool_name === "string" && payload.tool_name
        ? payload.tool_name
        : "Hermes";
    const description =
      typeof payload.description === "string" && payload.description
        ? payload.description
        : "Hermes requested permission to use a tool.";
    const detail =
      typeof payload.command === "string" ? payload.command.slice(0, 400) : "";
    const pending = {
      toolName,
      description,
      allowPermanent,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      const index = this.pendingApprovals.indexOf(pending);
      if (index < 0) return;
      this.pendingApprovals.splice(index, 1);
      void this.rpc
        .request("approval.respond", {
          session_id: this.liveSessionId,
          choice: "deny",
        })
        .catch(() => {});
      this.#safeEmit({
        type: "permission_result",
        toolName,
        summary: description,
        decision: "denied",
      });
    }, this.approvalTimeoutMs);
    pending.timer.unref?.();
    this.pendingApprovals.push(pending);

    const options = [{ text: "Yes", key: "allow" }];
    if (allowPermanent) {
      options.push({ text: "Yes, always", key: "allowAlways" });
    }
    options.push({ text: "No", key: "deny" });
    this.#safeEmit({
      type: "permission_request",
      toolName,
      description,
      detail,
      toolUseId: `hermes-approval-${++this.requestSequence}`,
      options,
      suggestions: null,
    });
  }

  async #handleQuestion(payload) {
    const question =
      typeof payload.question === "string" && payload.question
        ? payload.question
        : "Iris needs more information.";
    const requestId =
      typeof payload.request_id === "string" && payload.request_id
        ? payload.request_id
        : `hermes-question-${++this.requestSequence}`;
    const choices = Array.isArray(payload.choices)
      ? payload.choices.filter((choice) => typeof choice === "string")
      : [];
    const pending = { requestId, question, timer: null };
    pending.timer = setTimeout(() => {
      const index = this.pendingQuestions.indexOf(pending);
      if (index < 0) return;
      this.pendingQuestions.splice(index, 1);
      void this.rpc
        .request("clarify.respond", {
          session_id: this.liveSessionId,
          request_id: requestId,
          answer: "skip",
        })
        .catch(() => {});
      this.#safeEmit({
        type: "question_answer",
        answers: { [question]: "skip" },
      });
    }, this.questionTimeoutMs);
    pending.timer.unref?.();
    this.pendingQuestions.push(pending);
    this.#safeEmit({
      type: "user_question",
      questions: [
        {
          question,
          header: "Iris",
          options: choices.map((choice) => ({
            label: choice,
            description: "",
            preview: "",
          })),
        },
      ],
      toolUseId: requestId,
    });
  }

  async #failClosedCredentialRequest(type, payload) {
    const requestId =
      typeof payload.request_id === "string" ? payload.request_id : "";
    const method = type === "secret.request" ? "secret.respond" : "sudo.respond";
    const key = type === "secret.request" ? "value" : "password";
    await this.rpc
      .request(method, {
        session_id: this.liveSessionId,
        request_id: requestId,
        [key]: "",
      })
      .catch(() => {});
    this.#safeEmit({
      type: "notification",
      title: "Iris requires admin input",
      message:
        type === "secret.request"
          ? "A secret cannot be entered from the glasses. Use the Iris admin dashboard."
          : "A sudo password cannot be entered from the glasses. Use the Iris admin dashboard.",
    });
  }

  #acceptTurnEvent() {
    if (!this.generationGuard) return this.turnActive;
    return Boolean(
      this.turnActive &&
        !this.discardInterrupted &&
        this.eventGeneration !== 0 &&
        this.eventGeneration === this.activeGeneration,
    );
  }

  #settleInterrupted() {
    const durationMs = this.#turnDurationMs();
    this.#clearPendingInteractions();
    this.#safeEmit({
      type: "running_stats",
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.#safeEmit({
      type: "status",
      state: "text_end",
      sessionId: this.stableSessionId,
    });
    this.#safeEmit({
      type: "result",
      success: false,
      text: "Interrupted by user",
      sessionId: this.stableSessionId,
      costUsd: 0,
      provider: WIRE_PROVIDER,
      turns: 0,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.#finishTurn();
  }

  #settleError() {
    const durationMs = this.#turnDurationMs();
    this.#clearPendingInteractions();
    this.#safeEmit({
      type: "running_stats",
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.#safeEmit({
      type: "status",
      state: "text_end",
      sessionId: this.stableSessionId,
    });
    this.#safeEmit({
      type: "result",
      success: false,
      text: "Iris could not complete this turn.",
      sessionId: this.stableSessionId,
      costUsd: 0,
      provider: WIRE_PROVIDER,
      turns: 0,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.#finishTurn();
  }

  #finishTurn() {
    this.#clearPendingInteractions();
    this.turnActive = false;
    this.turnStartedAt = 0;
    this.activeGeneration = 0;
    this.eventGeneration = 0;
    this.currentText = "";
    this.toolCalls.clear();
    this.metadata.timestamp = new Date().toISOString();
    this.#safeEmit({
      type: "status",
      state: "idle",
      sessionId: this.stableSessionId,
    });
  }

  #handleCrash() {
    this.liveSessionId = null;
    this.profileReady = false;
    this.#rejectProfileWaiters(
      new ProviderError("Iris terminal profile interrupted", 503),
    );
    this.discardInterrupted = false;
    this.turnActive = false;
    this.turnStartedAt = 0;
    this.activeGeneration = 0;
    this.eventGeneration = 0;
    this.#clearPendingInteractions();
    this.#safeEmit({
      type: "error",
      message: "Iris restarted its local terminal agent. The session will resume.",
    });
    this.#safeEmit({
      type: "status",
      state: "idle",
      sessionId: this.stableSessionId,
    });
  }

  #state() {
    if (this.pendingApprovals.length || this.pendingQuestions.length) {
      return "awaiting";
    }
    return this.turnActive ? "busy" : "idle";
  }

  #turnDurationMs() {
    return this.turnStartedAt > 0
      ? Math.max(0, Date.now() - this.turnStartedAt)
      : 0;
  }

  #clearPendingInteractions() {
    for (const pending of [
      ...this.pendingApprovals,
      ...this.pendingQuestions,
    ]) {
      clearTimeout(pending.timer);
    }
    this.pendingApprovals = [];
    this.pendingQuestions = [];
  }

  #assertSession(sessionId) {
    if (!this.hasSession(sessionId)) {
      throw new ProviderError("Session not found", 404);
    }
  }

  #updateMetadata(info) {
    if (!info || typeof info !== "object") return;
    if (typeof info.cwd === "string") this.metadata.cwd = info.cwd;
    if (typeof info.model === "string" && info.model) {
      this.metadata.model = info.model;
    }
    if (typeof info.provider === "string" && info.provider) {
      this.metadata.provider = info.provider;
    }
    if (
      typeof info.reasoning_effort === "string" &&
      info.reasoning_effort
    ) {
      this.metadata.reasoningEffort = info.reasoning_effort;
    }
    if (typeof info.version === "string" && info.version) {
      this.metadata.version = info.version;
    }
    this.#resolveProfileWaiters();
  }

  #modelProfileMatches(info = this.metadata) {
    return (
      info.model === REQUIRED_MODEL &&
      info.provider === REQUIRED_PROVIDER
    );
  }

  #profileMatches(info = this.metadata) {
    const reasoningEffort =
      info.reasoningEffort ?? info.reasoning_effort ?? "";
    return (
      info.model === REQUIRED_MODEL &&
      info.provider === REQUIRED_PROVIDER &&
      reasoningEffort === REQUIRED_REASONING
    );
  }

  async #ensureRequiredProfile(
    info = this.metadata,
    { probeActive = false } = {},
  ) {
    if (this.profilePromise) return this.profilePromise;
    this.profileReady = false;
    this.profilePromise = (async () => {
      if (!this.liveSessionId) {
        throw new ProviderError("Iris session is unavailable", 503);
      }

      if (probeActive) {
        const active = await this.rpc.request("session.activate", {
          session_id: this.liveSessionId,
        });
        if (!active?.info || typeof active.info !== "object") {
          throw new ProviderError(
            "Hermes did not report the active G2 session profile",
            503,
          );
        }
        info = active.info;
        this.#updateMetadata(info);
        if (this.#profileMatches(info)) {
          this.profileReady = true;
          return;
        }
      }

      if (!this.#modelProfileMatches(info)) {
        const modelResult = await this.rpc.request("config.set", {
          session_id: this.liveSessionId,
          key: "model",
          value: REQUIRED_MODEL_SWITCH,
          confirm_expensive_model: true,
        });
        if (
          modelResult?.confirm_required === true ||
          modelResult?.value !== REQUIRED_MODEL
        ) {
          throw new ProviderError(
            "Hermes rejected the required G2 model profile",
            503,
          );
        }
      }

      const reportedReasoning =
        info.reasoningEffort ?? info.reasoning_effort ?? "";
      if (reportedReasoning !== REQUIRED_REASONING) {
        const reasoningResult = await this.rpc.request("config.set", {
          session_id: this.liveSessionId,
          key: "reasoning",
          value: REQUIRED_REASONING,
        });
        if (reasoningResult?.value !== REQUIRED_REASONING) {
          throw new ProviderError(
            "Hermes rejected the required G2 reasoning profile",
            503,
          );
        }
      }

      await this.#waitForRequiredProfile();
      this.profileReady = true;
    })();

    try {
      await this.profilePromise;
    } finally {
      this.profilePromise = null;
    }
  }

  #waitForRequiredProfile() {
    if (this.#profileMatches()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.profileWaiters.delete(waiter);
        reject(
          new ProviderError(
            "Hermes did not confirm the required G2 session profile",
            503,
          ),
        );
      }, PROFILE_READY_TIMEOUT_MS);
      waiter.timer.unref?.();
      this.profileWaiters.add(waiter);
    });
  }

  #resolveProfileWaiters() {
    if (!this.#profileMatches()) return;
    for (const waiter of this.profileWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.profileWaiters.clear();
  }

  #rejectProfileWaiters(error) {
    for (const waiter of this.profileWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.profileWaiters.clear();
  }

  #safeEmit(message) {
    if (!this.stableSessionId) return;
    try {
      this.emit(this.stableSessionId, message);
    } catch {
      this.logger.error("[terminal-mode] Event delivery failed");
    }
  }
}

export const providerWireName = WIRE_PROVIDER;
