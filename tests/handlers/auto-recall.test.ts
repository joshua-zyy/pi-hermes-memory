import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildRecallBlock,
  formatRecallBlock,
  registerAutoRecall,
  selectRecallCandidates,
  tokenizeQuery,
} from "../../src/handlers/auto-recall.js";

const MEMORY = [
  '项目使用 pnpm 而不是 npm <!-- created=2026-10-01, last=2026-10-20 -->',
  'pi-cli-subagents 的父代理只能交目标与验收条件 <!-- created=2026-10-02, last=2026-10-02 -->',
];
const FAILURES = [
  '[tool-quirk] npm run build 在 Windows 上因路径分隔符失败 <!-- created=2026-10-10, last=2026-10-18 -->',
];

function fakeStore() {
  return {
    getMemoryEntries: () => [...MEMORY],
    getFailureEntries: () => [...FAILURES],
  } as never;
}

describe("auto recall", () => {
  it("tokenizes CJK into bigrams and keeps ascii words", () => {
    const tokens = tokenizeQuery("pnpm 部署失败 npm");
    assert.ok(tokens.includes("pnpm"));
    assert.ok(tokens.includes("npm"));
    assert.ok(tokens.includes("部署"));
    assert.ok(tokens.includes("失败"));
    assert.ok(!tokens.includes("部"), "single CJK characters are too weak on their own");
  });

  it("respects the entry and character budget", () => {
    const candidates = selectRecallCandidates({
      entries: [
        { scope: "global", raw: MEMORY[0] },
        { scope: "failure", raw: FAILURES[0] },
        { scope: "global", raw: MEMORY[1] },
      ],
      query: "pnpm 部署失败 npm",
      maxEntries: 1,
      maxChars: 1500,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].scope, "global");

    const tight = selectRecallCandidates({
      entries: [{ scope: "global", raw: MEMORY[0] }],
      query: "pnpm npm",
      maxEntries: 3,
      maxChars: 10,
    });
    assert.equal(tight.length, 0, "an entry larger than the budget is skipped, not truncated");
  });

  it("labels the block as recalled, low-trust context with provenance", () => {
    const block = buildRecallBlock({
      query: "pnpm npm 失败",
      store: fakeStore(),
      config: { autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 },
    });
    assert.match(block, /^<recalled-memory note="recalled context/);
    assert.match(block, /\(global \| 2026-10-20\)/);
    assert.match(block, /\(failure \| 2026-10-18\)/);
    assert.ok(!block.includes("<!--"), "metadata comments must not leak into the prompt");
  });

  it("returns nothing when no entry clears the score floor", () => {
    const block = buildRecallBlock({
      query: "kubernetes helm chart",
      store: fakeStore(),
      config: { autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 },
    });
    assert.equal(block, "");
    assert.equal(formatRecallBlock([]), "");
  });

  it("only injects when enabled, and never mutates the caller's messages", async () => {
    let handler: ((event: unknown) => Promise<unknown>) | null = null;
    const pi = { on: (_event: string, fn: (event: unknown) => Promise<unknown>) => { handler = fn; } } as never;

    registerAutoRecall(pi, {
      store: fakeStore(),
      projectStoreRef: null,
      projectNameRef: null,
      config: { autoRecall: false },
    });
    assert.ok(handler, "the context handler must be registered");
    const messages = [{ role: "user", content: [{ type: "text", text: "pnpm npm 失败" }] }];
    assert.equal(await handler!({ type: "context", messages }), undefined, "disabled by default");
    assert.equal(messages.length, 1, "the handler must not mutate the request copy");

    handler = null;
    registerAutoRecall(pi, {
      store: fakeStore(),
      projectStoreRef: null,
      projectNameRef: null,
      config: { autoRecall: true, autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 },
    });
    const result = (await handler!({ type: "context", messages })) as { messages: unknown[] };
    assert.equal(result.messages.length, 2);
    const injected = result.messages[1] as { role: string; customType: string };
    assert.equal(injected.role, "custom");
    assert.equal(injected.customType, "memory-recall");
  });
});
