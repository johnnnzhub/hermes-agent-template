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
      if (
        keys.length !== 1 ||
        keys[0] !== "sessionId" ||
        !SESSION_ID_PATTERN.test(parsed.sessionId)
      ) {
        throw new Error("terminal-mode session state is invalid");
      }
      await chmod(this.path, 0o600);
      return parsed.sessionId;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("refusing to persist an invalid Hermes session id");
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
      await handle.writeFile(`${JSON.stringify({ sessionId })}\n`, "utf8");
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
