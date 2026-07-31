const DEFAULT_MAX_MESSAGES = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function encodeSse(id, message) {
  return `id: ${id}\ndata: ${JSON.stringify(message)}\n\n`;
}

export class EventBuffer {
  constructor({
    maxMessages = DEFAULT_MAX_MESSAGES,
    maxBytes = DEFAULT_MAX_BYTES,
    heartbeatMs = 15_000,
  } = {}) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new Error("maxMessages must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
      throw new Error("maxBytes must be at least 1024");
    }
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.heartbeatMs = heartbeatMs;
    this.sessions = new Map();
  }

  #session(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        bytes: 0,
        clients: new Set(),
        messages: [],
        nextId: 1,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  push(sessionId, message) {
    if (!sessionId) return 0;
    const session = this.#session(sessionId);
    const id = session.nextId++;
    const serialized = JSON.stringify(message);
    const size = Buffer.byteLength(serialized, "utf8");

    const replayMessage =
      size <= this.maxBytes
        ? message
        : {
            type: "error",
            message: "An Iris event was too large to replay; reconnect and retry.",
          };
    const replaySize = Buffer.byteLength(JSON.stringify(replayMessage), "utf8");
    session.messages.push({ id, message: replayMessage, size: replaySize });
    session.bytes += replaySize;

    while (
      session.messages.length > this.maxMessages ||
      session.bytes > this.maxBytes
    ) {
      const removed = session.messages.shift();
      session.bytes -= removed.size;
    }

    const frame = encodeSse(id, replayMessage);
    for (const client of [...session.clients]) {
      try {
        client.write(frame);
      } catch {
        session.clients.delete(client);
      }
    }
    return id;
  }

  getMessages(sessionId, after = 0) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages
      .filter((entry) => entry.id > after)
      .map((entry) => ({ id: entry.id, ...entry.message }));
  }

  subscribe(req, res, sessionId, { replay = false, after = 0 } = {}) {
    const session = this.#session(sessionId);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");

    if (replay) {
      for (const entry of session.messages) {
        if (entry.id > after) {
          res.write(encodeSse(entry.id, entry.message));
        }
      }
    }

    session.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        session.clients.delete(res);
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      session.clients.delete(res);
    };
    req.once("close", close);
    res.once("close", close);
  }

  close() {
    for (const session of this.sessions.values()) {
      for (const client of session.clients) {
        try {
          client.end();
        } catch {
          // The peer is already gone.
        }
      }
      session.clients.clear();
    }
  }
}
