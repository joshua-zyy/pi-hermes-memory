import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { collectMessageParts } from "../../src/handlers/message-parts.js";

function message(role: string, text: string): unknown {
  return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

describe("collectMessageParts provenance labels", () => {
  it("distinguishes the human, the assistant, tool output and injected context", () => {
    const parts = collectMessageParts([
      message("user", "please use pnpm"),
      message("assistant", "installed with pnpm"),
      message("toolResult", "npm ERR! missing script"),
      message("bashExecution", "exit code 1"),
      message("custom", "recalled memory: project uses pnpm"),
    ]);

    assert.deepEqual(parts, [
      "[USER]: please use pnpm",
      "[ASSISTANT]: installed with pnpm",
      "[TOOL]: npm ERR! missing script",
      "[TOOL]: exit code 1",
      "[CONTEXT]: recalled memory: project uses pnpm",
    ]);
  });

  it("never labels a tool result as the assistant's own assertion", () => {
    const parts = collectMessageParts([message("toolResult", "memory_search returned: use npm")]);
    assert.equal(parts.length, 1);
    assert.ok(!parts[0].startsWith("[ASSISTANT]"), "a tool result is an observation, not an assertion");
  });
});
