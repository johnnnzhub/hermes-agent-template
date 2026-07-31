import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBuffer } from "../../src/event-buffer.mjs";
import { HermesProvider } from "../../src/hermes-provider.mjs";
import { HermesRpcClient } from "../../src/rpc-client.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeTui = join(
  testDirectory,
  "..",
  "..",
  "fixtures",
  "fake-hermes-tui.mjs",
);

export async function createHarness({
  hermesHome,
  approvalTimeoutMs = 500,
  questionTimeoutMs = 500,
  dedupeWindowMs = 5_000,
  generationGuard = true,
  fakeEnv = {},
  bufferOptions = {},
} = {}) {
  const ownedHome = !hermesHome;
  const home = hermesHome ?? (await mkdtemp(join(tmpdir(), "iris-terminal-test-")));
  const events = new EventBuffer({
    heartbeatMs: 50,
    ...bufferOptions,
  });
  const logs = [];
  const logger = {
    info: (message) => logs.push(String(message)),
    warn: (message) => logs.push(String(message)),
    error: (message) => logs.push(String(message)),
  };
  const rpc = new HermesRpcClient({
    command: process.execPath,
    args: [fakeTui],
    env: fakeEnv,
    logger,
    requestTimeoutMs: 2_000,
    startupTimeoutMs: 2_000,
    restartMinMs: 10,
    restartMaxMs: 50,
  });
  const provider = new HermesProvider({
    rpc,
    hermesHome: home,
    emit: (sessionId, message) => events.push(sessionId, message),
    logger,
    approvalTimeoutMs,
    questionTimeoutMs,
    dedupeWindowMs,
    generationGuard,
  });
  await provider.initialize();

  return {
    events,
    hermesHome: home,
    logs,
    provider,
    rpc,
    sessionId: provider.stableSessionId,
    async close() {
      events.close();
      await provider.stop();
      if (ownedHome) await rm(home, { recursive: true, force: true });
    },
  };
}

export async function waitFor(check, {
  timeoutMs = 2_000,
  intervalMs = 10,
  message = "condition not reached",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

export function messagesOf(harness) {
  return harness.events.getMessages(harness.sessionId, 0);
}
