import test from "node:test";
import assert from "node:assert/strict";
import {
  createHarness,
  messagesOf,
  waitFor,
} from "./helpers/harness.mjs";

test("negative seam: disabling the production generation guard reproduces the late-event bug", async (t) => {
  const harness = await createHarness({ generationGuard: false });
  t.after(() => harness.close());

  await harness.provider.prompt(harness.sessionId, "__slow_pre_ack__");
  await waitFor(() =>
    messagesOf(harness).some(
      (message) =>
        message.type === "text_delta" &&
        message.text === "BEFORE_PRE_ACK",
    ),
  );
  const marker = messagesOf(harness).at(-1).id;
  await harness.provider.interrupt(harness.sessionId);
  await waitFor(() => harness.provider.getStatus(harness.sessionId)?.state === "idle");

  const after = harness.events.getMessages(harness.sessionId, marker);
  assert.ok(
    after.some(
      (message) =>
        message.type === "text_delta" &&
        message.text === "LATE_PRE_ACK",
    ),
    "the reversed seam must surface the exact event the guarded contract rejects",
  );
});
