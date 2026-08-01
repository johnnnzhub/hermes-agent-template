import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { ProviderError } from "./hermes-provider.mjs";

const DEFAULT_STT_URL = "https://n8n.cobaiateam.com.br/webhook/g2-voice";
const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHANNELS = 1;
const AUDIO_BIT_DEPTH = 16;
const MAX_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 * 45;
const MAX_HISTORY_MESSAGES = 50;
const DEFAULT_TURN_LIMIT = 6;
const MAX_TURN_LIMIT = 10;
const MAX_DEDUPE_ENTRIES = 128;
const CLIENT_MSG_ID = /^[A-Za-z0-9._:-]{6,80}$/;
const REVISION = /^[a-f0-9]{16}$/;

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const actualBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function assertGlassToken(token) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 32 ||
    new Set(token).size < 8
  ) {
    throw new Error("GLASS_TOKEN must be a strong token of at least 32 bytes");
  }
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function parseInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, maximum);
}

function revisionFor(messages) {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 16);
}

function safeToolName(value) {
  if (typeof value !== "string") return "Hermes";
  const cleaned = value.replace(/[^\p{L}\p{N} ._/-]/gu, "").trim();
  return cleaned.slice(0, 42) || "Hermes";
}

function activePrompt(events, sessionId, history) {
  const buffered = events.getMessages(sessionId, 0);
  const latestResult = buffered.findLastIndex(
    (event) => event.type === "result" || event.type === "error",
  );
  const prompt = buffered
    .slice(latestResult + 1)
    .findLast((event) => event.type === "user_prompt");
  const text = typeof prompt?.text === "string" ? prompt.text.trim() : "";
  if (!text) return null;
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  return lastUser?.text === text ? null : { role: "user", text };
}

function visibleMessages(history, events, sessionId, state) {
  const messages = history.map((message) => ({
    role: message.role,
    text: message.text,
  }));
  if (state === "busy" || state === "awaiting") {
    const prompt = activePrompt(events, sessionId, messages);
    if (prompt) messages.push(prompt);
  }
  return messages;
}

export function groupConversationTurns(messages) {
  const turns = [];
  for (const message of messages) {
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (!text) continue;
    if (message.role === "user") {
      turns.push({ user: text, assistant: "" });
      continue;
    }
    if (message.role !== "assistant") continue;
    const current = turns.at(-1);
    if (current && !current.assistant) {
      current.assistant = text;
    } else {
      turns.push({ user: "", assistant: text });
    }
  }
  return turns.map((turn, index) => ({
    id: createHash("sha256")
      .update(`${index}\u0000${turn.user}\u0000${turn.assistant}`)
      .digest("hex")
      .slice(0, 12),
    ...turn,
  }));
}

export function safeProgress(events, sessionId, state) {
  if (state === "idle") return null;
  const buffered = events.getMessages(sessionId, 0);
  const latestResult = buffered.findLastIndex(
    (event) => event.type === "result" || event.type === "error",
  );
  const current = buffered.slice(latestResult + 1);
  if (
    current.some(
      (event) =>
        event.type === "permission_request" || event.type === "user_question",
    )
  ) {
    return { kind: "awaiting", text: "Aguardando no Terminal Mode" };
  }

  const activeTools = new Map();
  for (const event of current) {
    if (event.type === "tool_start") {
      activeTools.set(event.toolId, safeToolName(event.name));
    } else if (event.type === "tool_end") {
      activeTools.delete(event.toolId);
    }
  }
  const toolName = [...activeTools.values()].at(-1);
  if (toolName) {
    return { kind: "tool", text: `Usando ${toolName}` };
  }
  if (current.some((event) => event.type === "text_delta")) {
    return { kind: "answer", text: "Preparando resposta" };
  }
  return { kind: state === "awaiting" ? "awaiting" : "thinking", text: "Pensando" };
}

function validateAudioBody(body) {
  const {
    pcmB64,
    sampleRate,
    channels,
    bitDepth,
    clientMsgId,
    expectedRevision,
  } = body ?? {};
  if (!CLIENT_MSG_ID.test(String(clientMsgId ?? ""))) {
    return { error: "clientMsgId inválido" };
  }
  if (!REVISION.test(String(expectedRevision ?? ""))) {
    return { error: "expectedRevision inválida" };
  }
  if (
    sampleRate !== AUDIO_SAMPLE_RATE ||
    channels !== AUDIO_CHANNELS ||
    bitDepth !== AUDIO_BIT_DEPTH
  ) {
    return { error: "Formato de áudio inválido" };
  }
  if (
    typeof pcmB64 !== "string" ||
    pcmB64.length < 4 ||
    pcmB64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      pcmB64,
    )
  ) {
    return { error: "Áudio inválido" };
  }
  const pcm = Buffer.from(pcmB64, "base64");
  if (!pcm.length || pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 !== 0) {
    return { error: "Áudio inválido" };
  }
  return {
    value: {
      pcmB64,
      sampleRate,
      channels,
      bitDepth,
      clientMsgId,
      expectedRevision,
    },
  };
}

export class GlassTranscriber {
  constructor({
    url = process.env.IRIS_GLASS_STT_URL || DEFAULT_STT_URL,
    token = process.env.IRIS_GLASS_STT_TOKEN,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get isConfigured() {
    return Boolean(this.url && this.token && this.fetchImpl);
  }

  async transcribe(audio) {
    if (!this.isConfigured) {
      throw new ProviderError("Glass transcription is unavailable", 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pcmB64: audio.pcmB64,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: AUDIO_CHANNELS,
          bitDepth: AUDIO_BIT_DEPTH,
          clientMsgId: audio.clientMsgId,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProviderError("Glass transcription failed", 502);
      }
      const payload = await response.json();
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (payload?.ok !== true || !text) {
        throw new ProviderError("Glass transcription returned no speech", 422);
      }
      return text.slice(0, 4_000);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Glass transcription failed", 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function sessionSnapshot(provider, events) {
  const sessions = await provider.listSessions(1);
  const session = sessions[0];
  if (!session) throw new ProviderError("Iris session is unavailable", 503);
  const status = provider.getStatus(session.id);
  const state = status?.state ?? "idle";
  const history = await provider.getHistory(session.id, MAX_HISTORY_MESSAGES);
  const messages = visibleMessages(history, events, session.id, state);
  return {
    session,
    state,
    messages,
    revision: revisionFor(messages),
  };
}

function publicError(error) {
  const status = error instanceof ProviderError ? error.statusCode : 500;
  if (status === 409) return { status, error: error.message };
  if (status === 422) return { status, error: "Não encontrei fala nesse áudio." };
  if (status === 503) return { status, error: "A conversa está indisponível." };
  if (status === 502) return { status, error: "Não consegui transcrever o áudio." };
  return { status: 500, error: "A Iris não conseguiu receber a mensagem." };
}

export function createGlassConversationRouter({
  provider,
  events,
  token,
  transcriber = new GlassTranscriber(),
  logger = { warn() {}, error() {} },
} = {}) {
  if (!provider || !events) throw new Error("provider and events are required");
  assertGlassToken(token);
  const router = express.Router();
  const dedupe = new Map();

  router.use((req, res, next) => {
    const authorization = req.get("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;
    if (!tokenMatches(bearer, token)) {
      logger.warn(`[glass-hermes] rejected ${req.method} ${req.path}`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "2mb" }));

  router.get(
    "/session",
    asyncRoute(async (req, res) => {
      const cursor = parseInteger(req.query.cursor, 0, MAX_HISTORY_MESSAGES);
      const limit = parseInteger(
        req.query.limit,
        DEFAULT_TURN_LIMIT,
        MAX_TURN_LIMIT,
      );
      if (cursor === null || limit === null || limit < 1) {
        res.status(400).json({ error: "Cursor inválido" });
        return;
      }
      const snapshot = await sessionSnapshot(provider, events);
      const allTurns = groupConversationTurns(snapshot.messages);
      const end = Math.max(0, allTurns.length - cursor);
      const start = Math.max(0, end - limit);
      const turns = allTurns.slice(start, end);
      res.json({
        ok: true,
        sessionId: snapshot.session.id,
        revision: snapshot.revision,
        state: snapshot.state,
        progress: safeProgress(events, snapshot.session.id, snapshot.state),
        turns,
        cursor,
        nextCursor: start > 0 ? cursor + turns.length : null,
      });
    }),
  );

  router.post(
    "/turn",
    asyncRoute(async (req, res) => {
      const parsed = validateAudioBody(req.body);
      if (parsed.error) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const audio = parsed.value;
      const fingerprint = createHash("sha256")
        .update(`${audio.expectedRevision}\u0000${audio.pcmB64}`)
        .digest("hex");
      let entry = dedupe.get(audio.clientMsgId);
      if (entry && entry.fingerprint !== fingerprint) {
        res.status(409).json({ error: "clientMsgId já foi utilizado." });
        return;
      }
      if (!entry) {
        const pending = (async () => {
          try {
            let snapshot = await sessionSnapshot(provider, events);
            if (snapshot.state !== "idle") {
              return { status: 409, body: { error: "A Iris já está trabalhando." } };
            }
            if (snapshot.revision !== audio.expectedRevision) {
              return {
                status: 409,
                body: { error: "A conversa mudou; atualize antes de enviar." },
              };
            }
            const transcript = await transcriber.transcribe(audio);
            snapshot = await sessionSnapshot(provider, events);
            if (snapshot.state !== "idle") {
              return { status: 409, body: { error: "A Iris já está trabalhando." } };
            }
            if (snapshot.revision !== audio.expectedRevision) {
              return {
                status: 409,
                body: { error: "A conversa mudou; atualize antes de enviar." },
              };
            }
            const accepted = await provider.prompt(snapshot.session.id, transcript);
            return {
              status: 202,
              body: {
                ok: true,
                sessionId: accepted.sessionId,
                clientMsgId: audio.clientMsgId,
                transcript,
              },
            };
          } catch (error) {
            const mapped = publicError(error);
            return { status: mapped.status, body: { error: mapped.error } };
          }
        })();
        entry = { fingerprint, pending };
        dedupe.set(audio.clientMsgId, entry);
        void pending.then((result) => {
          if (result.status >= 500 && dedupe.get(audio.clientMsgId) === entry) {
            dedupe.delete(audio.clientMsgId);
          }
        });
        if (dedupe.size > MAX_DEDUPE_ENTRIES) {
          dedupe.delete(dedupe.keys().next().value);
        }
      }
      const result = await entry.pending;
      res.status(result.status).json(result.body);
    }),
  );

  router.all("/*splat", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  router.use((error, _req, res, _next) => {
    logger.error("[glass-hermes] request failed");
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Áudio excede o limite" });
      return;
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON inválido" });
      return;
    }
    const mapped = publicError(error);
    res.status(mapped.status).json({ error: mapped.error });
  });

  return router;
}
