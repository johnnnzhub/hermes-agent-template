import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export function createStableSessionId() {
  return `iris-g2-${randomBytes(18).toString("base64url")}`;
}

export class SessionStore {
  constructor(hermesHome) {
    if (typeof hermesHome !== "string" || !hermesHome.trim()) {
      throw new Error("HERMES_HOME is required");
    }
    this.directory = join(hermesHome, "terminal-mode");
    this.path = join(this.directory, "session.json");
  }

  async read() {
    try {
      const fileStat = await stat(this.path);
      if (!fileStat.isFile()) {
        throw new Error("terminal-mode session state is not a regular file");
      }
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      const keys = Object.keys(parsed);
      const legacy =
        keys.length === 1 &&
        keys[0] === "sessionId" &&
        SESSION_ID_PATTERN.test(parsed.sessionId);
      const current =
        keys.length === 2 &&
        keys[0] === "sessionId" &&
        keys[1] === "hermesSessionId" &&
        SESSION_ID_PATTERN.test(parsed.sessionId) &&
        SESSION_ID_PATTERN.test(parsed.hermesSessionId);
      if (!legacy && !current) {
        throw new Error("terminal-mode session state is invalid");
      }
      await chmod(this.path, 0o600);
      return {
        sessionId: parsed.sessionId,
        hermesSessionId: legacy
          ? parsed.sessionId
          : parsed.hermesSessionId,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write({ sessionId, hermesSessionId }) {
    if (
      !SESSION_ID_PATTERN.test(sessionId) ||
      !SESSION_ID_PATTERN.test(hermesSessionId)
    ) {
      throw new Error("refusing to persist invalid terminal session state");
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);

    const temporaryPath = join(
      this.directory,
      `.session.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ sessionId, hermesSessionId })}\n`,
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}
