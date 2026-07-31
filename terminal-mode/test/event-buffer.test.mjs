import test from "node:test";
import assert from "node:assert/strict";
import { EventBuffer } from "../src/event-buffer.mjs";

test("bounded replay retains at most the configured message count", () => {
  const buffer = new EventBuffer({ maxMessages: 128, maxBytes: 1024 * 1024 });
  for (let index = 0; index < 300; index += 1) {
    buffer.push("session", { type: "text_delta", text: `event-${index}` });
  }
  const messages = buffer.getMessages("session", 0);
  assert.equal(messages.length, 128);
  assert.equal(messages[0].id, 173);
  assert.equal(messages.at(-1).id, 300);
});

test("bounded replay enforces its byte cap and preserves monotonic ids", () => {
  const buffer = new EventBuffer({ maxMessages: 256, maxBytes: 2_048 });
  for (let index = 0; index < 40; index += 1) {
    buffer.push("session", {
      type: "text_delta",
      text: `${index}:${"x".repeat(180)}`,
    });
  }
  const messages = buffer.getMessages("session", 0);
  assert.ok(messages.length < 40);
  assert.equal(messages.at(-1).id, 40);
  for (let index = 1; index < messages.length; index += 1) {
    assert.equal(messages[index].id, messages[index - 1].id + 1);
  }
});

test("messages after a cursor exclude already acknowledged events", () => {
  const buffer = new EventBuffer();
  buffer.push("session", { type: "text_delta", text: "one" });
  buffer.push("session", { type: "text_delta", text: "two" });
  buffer.push("session", { type: "result", text: "done" });
  assert.deepEqual(
    buffer.getMessages("session", 2).map((message) => message.id),
    [3],
  );
});

test("oversized live events are replaced by the same bounded replay event", () => {
  const buffer = new EventBuffer({ maxMessages: 8, maxBytes: 1_024 });
  buffer.push("session", { type: "status", state: "idle" });
  const frames = [];
  buffer.sessions.get("session").clients.add({
    write(frame) {
      frames.push(frame);
    },
  });

  buffer.push("session", {
    type: "text_delta",
    text: `private-${"x".repeat(5_000)}`,
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0].includes("private-"), false);
  assert.match(frames[0], /too large to replay/);
  assert.equal(
    buffer.getMessages("session", 0).at(-1).message,
    "An Iris event was too large to replay; reconnect and retry.",
  );
});
