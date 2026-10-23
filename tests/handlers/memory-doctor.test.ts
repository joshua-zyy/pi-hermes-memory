import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectDoctorReport, formatDoctorReport } from "../../src/handlers/memory-doctor.js";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory } from "../../src/store/sqlite-memory-store.js";
import type { MemoryConfig } from "../../src/types.js";

const DELIMITER = "\n§\n";

function writeStore(dir: string, files: Record<string, string[]>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, entries] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), entries.join(DELIMITER), "utf-8");
  }
}

function config(projectsRoot: string): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: 100,
    userCharLimit: 50,
    projectCharLimit: 80,
    projectsMemoryDir: projectsRoot,
  } as MemoryConfig;
}

describe("memory doctor", () => {
  it("reports sizes, goals and snapshots for global and project stores", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
    const globalDir = path.join(root, "global");
    const projectsRoot = path.join(root, "projects");
    try {
      writeStore(globalDir, {
        "MEMORY.md": ["aaaa", "bbbb"],
        "USER.md": ["cccc"],
        "failures.md": ["dddd", "ffff"],
      });
      writeStore(path.join(projectsRoot, "proj"), { "MEMORY.md": ["eeee"] });
      fs.writeFileSync(path.join(globalDir, ".failures.md.recovery-1-x"), Buffer.alloc(10, 1));
      fs.writeFileSync(path.join(globalDir, "MEMORY.md.bak"), "ignored");

      const dbManager = new DatabaseManager(globalDir);
      try {
        addMemory(dbManager, "aaaa", "memory");
        addMemory(dbManager, "bbbb", "memory");
        addMemory(dbManager, "cccc", "user");
        addMemory(dbManager, "dddd", "failure");
        addMemory(dbManager, "project-tagged failure", "failure", "proj");
        addMemory(dbManager, "eeee", "memory", "proj");

        const report = await collectDoctorReport({ config: config(projectsRoot), globalDir, dbManager });
        const globalMemory = report.rows.find((row) => row.label === "(global) memory");
        const globalFailure = report.rows.find((row) => row.label === "(global) failure");
        const projectMemory = report.rows.find((row) => row.label === "proj memory");
        assert.ok(globalMemory && globalFailure && projectMemory, "all rows must be reported");

        // Chars are counted per file (entries joined by the delimiter):
        // MEMORY 4+3+4 = 11, failures 4.
        assert.equal(globalMemory.entries, 2);
        assert.equal(globalMemory.chars, 11);
        assert.equal(globalMemory.goal, 100);
        assert.equal(globalMemory.overGoal, 0);
        assert.equal(globalMemory.mirrorRows, 2);
        assert.equal(globalFailure.chars, 11);
        assert.equal(globalFailure.goal, 200);
        // failures.md is global, so every failure row counts regardless of project tag.
        assert.equal(globalFailure.mirrorRows, 2);
        assert.equal(projectMemory.chars, 4);
        assert.equal(projectMemory.goal, 80);
        assert.equal(projectMemory.mirrorRows, 1);

        const globalStore = report.stores.find((store) => store.label === "(global)");
        assert.ok(globalStore);
        assert.equal(globalStore.snapshots.count, 1);
        assert.equal(globalStore.snapshots.bytes, 10);

        assert.deepEqual(report.warnings, []);
        assert.equal(report.totals.entries, 6);
        const text = formatDoctorReport(report);
        assert.match(text, /Memory Doctor/);
        assert.match(text, /no findings/);
      } finally {
        dbManager.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags stores over goal, mirror drift and expensive snapshots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
    const globalDir = path.join(root, "global");
    const projectsRoot = path.join(root, "projects");
    try {
      writeStore(globalDir, {
        "MEMORY.md": ["x".repeat(150), "y".repeat(150), "w".repeat(150)],
        "failures.md": ["z".repeat(60)],
      });
      writeStore(path.join(projectsRoot, "proj"), { "MEMORY.md": ["small"] });
      // 11 MB snapshot: sparse so the test stays cheap.
      const snapshot = path.join(globalDir, ".failures.md.retired-2-x");
      fs.writeFileSync(snapshot, "");
      fs.truncateSync(snapshot, 11 * 1024 * 1024);
      fs.mkdirSync(projectsRoot, { recursive: true });

      const dbManager = new DatabaseManager(globalDir);
      try {
        addMemory(dbManager, "x".repeat(150), "memory");
        addMemory(dbManager, "y".repeat(150), "memory");
        addMemory(dbManager, "w".repeat(150), "memory");
        addMemory(dbManager, "z".repeat(60), "failure");
        addMemory(dbManager, "stale row that no longer exists in markdown", "memory");
        addMemory(dbManager, "another stale row", "memory");

        const report = await collectDoctorReport({ config: config(projectsRoot), globalDir, dbManager });
        const globalMemory = report.rows.find((row) => row.label === "(global) memory");
        assert.ok(globalMemory);
        assert.ok(globalMemory.overGoal > 0, "store must be over its goal");

        const joined = report.warnings.join("\n");
        assert.match(joined, /over its goal/);
        assert.match(joined, /run \/memory-sync-markdown/);
        assert.match(joined, /snapshots cost/);

        const text = formatDoctorReport(report);
        assert.match(text, /finding/);
      } finally {
        dbManager.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
