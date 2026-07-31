import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HermesRpcClient } from "../src/rpc-client.mjs";

test("stop escalates a non-cooperative child from SIGTERM to SIGKILL", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };

  const rpc = new HermesRpcClient({
    stopTimeoutMs: 10,
    stopKillTimeoutMs: 50,
  });
  rpc.child = child;
  await rpc.stop();

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});
