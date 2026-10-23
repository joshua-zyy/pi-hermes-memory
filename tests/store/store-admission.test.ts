import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "../../src/store/memory-store.js";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import { readTraceRecords } from "../../src/store/admission.js";
import type { MemoryConfig } from "../../src/types.js";

let dir = "";

function config(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: dir,
    ...overrides,
  };
}

describe("write admission inside the store", () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-admission-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("defers a first sighting and promotes the repeat", async () => {
    const store = new MemoryStore(config({ writeAdmission: "enforce", admissionMinRepeats: 2 }));

    const first = await store.addFailure("spawn error surfaced only after the retry", { category: "insight" });
    assert.equal(first.success, true);
    assert.match(first.message ?? "", /Deferred to the trace log/);
    assert.equal(store.getFailureEntries(3650).length, 0, "a deferred entry must not reach the store");
    assert.equal(readTraceRecords(dir).length, 1);

    const second = await store.addFailure("spawn error surfaced only after the retry", { category: "insight" });
    assert.equal(second.success, true);
    assert.doesNotMatch(second.message ?? "", /Deferred/);
    assert.equal(store.getFailureEntries(3650).length, 1, "the repeat must be promoted");
    assert.equal(readTraceRecords(dir).length, 2);
  });

  it("admits corrections immediately", async () => {
    const store = new MemoryStore(config({ writeAdmission: "enforce" }));
    const result = await store.addFailure("use pnpm, not npm", { category: "correction" });
    assert.equal(result.success, true);
    assert.doesNotMatch(result.message ?? "", /Deferred/);
    assert.equal(store.getFailureEntries(3650).length, 1);
  });

  it("writes through in trace mode and still records the decision", async () => {
    const store = new MemoryStore(config({ writeAdmission: "trace" }));
    const result = await store.addFailure("one-off observation", { category: "insight" });
    assert.equal(result.success, true);
    assert.equal(store.getFailureEntries(3650).length, 1, "trace mode must not change behaviour");
    const records = readTraceRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].decision, "defer");
  });

  it("does not count a duplicate the store already holds", async () => {
    const store = new MemoryStore(config({ writeAdmission: "enforce" }));
    await store.addFailure("duplicate me", { category: "correction" });
    assert.equal(readTraceRecords(dir).length, 1, "an immediate category is still logged");

    await store.addFailure("duplicate me", { category: "correction" });
    assert.equal(readTraceRecords(dir).length, 1, "the duplicate check answers before the gate");
    assert.equal(store.getFailureEntries(3650).length, 1);
  });
});

describe("write admission inside an atomic plan", () => {
  it("refuses the whole plan when a new fact would be deferred", async () => {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "plan-admission-"));
    try {
      const store = new MemoryStore({ ...config(), memoryDir: dir2, writeAdmission: "enforce" });
      await store.addFailure("keep me", { category: "correction" });

      const result = await store.applyMutationPlan("failure", [
        { action: "remove", oldText: "keep me" },
        { action: "add", content: "a brand new claim", category: "insight" },
      ]);

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /deferred new fact/);
      assert.equal(store.getFailureEntries(3650).length, 1, "the plan's delete must not have been applied");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });
});

describe("capacity demotion", () => {
  it("keeps the store within its goal and never demotes a durable entry", async () => {
    const capacityDir = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-"));
    try {
      const store = new MemoryStore({
        ...config(),
        memoryDir: capacityDir,
        memoryCharLimit: 300,
        enforceCapacity: true,
      });

      await store.add("memory", "[correction] always run the migration before deploy");
      for (let index = 0; index < 12; index++) {
        await store.add("memory", `[tool-quirk] observation ${index} ${"x".repeat(40)}`);
      }

      const raw = await fs.readFile(path.join(capacityDir, "MEMORY.md"), "utf-8");
      assert.ok(raw.length <= 300, `store must stay within its goal, got ${raw.length}`);
      assert.ok(raw.includes("always run the migration"), "a durable entry must survive demotion");

      const demoted = (await fs.readFile(path.join(capacityDir, "demoted.jsonl"), "utf-8"))
        .trim()
        .split(String.fromCharCode(10))
        .map((line) => JSON.parse(line) as { reason: string; text: string });
      assert.ok(demoted.length > 0, "overflow must be demoted, not deleted");
      assert.ok(demoted.every((record) => record.reason === "capacity"));
      assert.ok(!demoted.some((record) => record.text.includes("always run the migration")));
    } finally {
      await fs.rm(capacityDir, { recursive: true, force: true });
    }
  });
});
