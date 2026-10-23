import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRecallBlock, formatRecallBlock, registerAutoRecall, tokenizeQuery } from "../../src/handlers/auto-recall.js";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory } from "../../src/store/sqlite-memory-store.js";

const NL = String.fromCharCode(10);
let dir = "";
let dbManager: DatabaseManager;

describe("auto recall", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
    dbManager = new DatabaseManager(dir);
    addMemory(dbManager, "项目统一使用 pnpm workspaces 管理依赖", "memory", null);
    addMemory(dbManager, "Windows 上 mklink 需要管理员权限，路径分隔符要转义", "failure", null);
    addMemory(dbManager, "piTest 项目自己的部署流程约定", "memory", "piTest");
    addMemory(dbManager, "另一个项目的私密约定不应泄漏", "memory", "other-project");
  });

  afterEach(() => {
    dbManager.close();
    AtomicLockCoordinator.closeHandles();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tokenizes CJK into bigrams and keeps ascii words", () => {
    const tokens = tokenizeQuery("pnpm 部署失败 npm");
    assert.ok(tokens.includes("pnpm"));
    assert.ok(tokens.includes("部署"));
    assert.ok(!tokens.includes("部"));
  });

  it("retrieves through the FTS index and keeps the block within budget", () => {
    const block = buildRecallBlock({
      query: "pnpm workspaces",
      dbManager,
      config: { autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 },
    });
    assert.match(block, /^<recalled-memory note="recalled context/);
    assert.match(block, /pnpm workspaces/);
    assert.match(block, /\(global \| /);
    assert.ok(block.length <= 1500);
    assert.ok(!block.includes("<!--"));
  });

  it("returns nothing for an unrelated question", () => {
    const block = buildRecallBlock({
      query: "kubernetes helm chart",
      dbManager,
      config: { autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 },
    });
    assert.equal(block, "");
    assert.equal(formatRecallBlock([]), "");
  });

  it("never leaks another project's entries", () => {
    const block = buildRecallBlock({
      query: "私密约定 部署流程",
      dbManager,
      projectName: "piTest",
      config: { autoRecallMaxEntries: 5, autoRecallMaxChars: 1500 },
    });
    assert.ok(block.includes("piTest"), "the active project's entry may appear");
    assert.ok(!block.includes("另一个项目"), "another project's entry must not");
  });

  it("injects only when enabled, and never mutates the caller's messages", async () => {
    let handler: ((event: unknown) => Promise<unknown>) | null = null;
    const pi = { on: (_event: string, fn: (event: unknown) => Promise<unknown>) => { handler = fn; } } as never;
    const deps = {
      dbManager,
      store: {} as never,
      projectStoreRef: null,
      projectNameRef: "piTest",
    };

    registerAutoRecall(pi, { ...deps, config: { autoRecall: false } });
    const messages = [{ role: "user", content: [{ type: "text", text: "pnpm workspaces" }] }];
    assert.equal(await handler!({ type: "context", messages }), undefined, "disabled by default");
    assert.equal(messages.length, 1, "the request copy must not be mutated");

    handler = null;
    registerAutoRecall(pi, { ...deps, config: { autoRecall: true, autoRecallMaxEntries: 3, autoRecallMaxChars: 1500 } });
    const result = (await handler!({ type: "context", messages })) as { messages: unknown[] };
    assert.equal(result.messages.length, 2);
    const injected = result.messages[1] as { role: string; customType: string };
    assert.equal(injected.role, "custom");
    assert.equal(injected.customType, "memory-recall");
  });
});
