import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyPrunePlan,
  buildPrunePlan,
  defaultPruneOptions,
  formatPruneReport,
  parsePruneArgs,
  parsePruneEntry,
  shouldKeepEntry,
  type PrunePlan,
} from "../../src/handlers/memory-prune.js";
import type { MemoryConfig } from "../../src/types.js";

const DELIMITER = "\n§\n";
const TODAY = new Date("2026-10-23T00:00:00Z");

function config(projectsRoot: string): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    projectsMemoryDir: projectsRoot,
  } as MemoryConfig;
}

function entry(text: string, created: string, last = created): string {
  return `${text} <!-- created=${created}, last=${last} -->`;
}

describe("memory prune", () => {
  it("keeps durable categories, recalled entries, recent entries and merged summaries", () => {
    const hits = new Map([["recalled fact", 3]]);
    const options = defaultPruneOptions();

    const keep = (text: string, created: string, last?: string) =>
      shouldKeepEntry(parsePruneEntry(entry(text, created, last), hits), options, TODAY);

    assert.equal(keep("[correction] old correction", "2026-01-01"), true);
    assert.equal(keep("[convention] old convention", "2026-01-01"), true);
    assert.equal(keep("recalled fact", "2026-01-01"), true);
    assert.equal(keep("[insight] recent insight", "2026-10-20"), true);
    assert.equal(keep("merged summary （合并旧多条）", "2026-01-01"), true);
    assert.equal(keep("[insight] stale and never recalled", "2026-08-01"), false);
    // No metadata at all: never drop something we cannot date.
    assert.equal(shouldKeepEntry(parsePruneEntry("bare entry", hits), options, TODAY), true);
  });

  it("parses command arguments with safe defaults", () => {
    assert.deepEqual([...parsePruneArgs("").targets], ["failure"]);
    const applied = parsePruneArgs("--apply --keep-days 3 --min-hits 2 --target all");
    assert.equal(applied.apply, true);
    assert.equal(applied.keepDays, 3);
    assert.equal(applied.minHits, 2);
    assert.deepEqual([...applied.targets].sort(), ["failure", "memory", "user"]);
    // Invalid numbers fall back to the defaults instead of disabling retention.
    const broken = parsePruneArgs("--keep-days nope --min-hits 0");
    assert.equal(broken.keepDays, 3);
    assert.equal(broken.minHits, 1);
  });

  it("plans and applies an archive without losing an entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    const globalDir = path.join(root, "global");
    const projectsRoot = path.join(root, "projects");
    const archiveDir = path.join(root, "archive");
    try {
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectsRoot, { recursive: true });
      const failures = [
        entry("[correction] durable", "2026-01-01"),
        entry("[insight] retrieved often", "2026-01-02"),
        entry("[insight] fresh", "2026-10-22"),
        entry("[tool-quirk] stale one", "2026-08-01"),
        entry("[insight] stale two", "2026-08-02"),
      ];
      fs.writeFileSync(path.join(globalDir, "failures.md"), failures.join(DELIMITER), "utf-8");
      fs.writeFileSync(
        path.join(globalDir, "MEMORY.md"),
        entry("memory stays untouched", "2026-10-22"),
        "utf-8",
      );

      const plans = await buildPrunePlan({
        config: config(projectsRoot),
        globalDir,
        dbManager: null,
        prune: defaultPruneOptions(),
        today: TODAY,
        hits: new Map([["[insight] retrieved often", 2]]),
      });
      assert.equal(plans.length, 1, "only the failure file has droppable entries");
      const plan = plans[0];
      assert.equal(path.basename(plan.file), "failures.md");
      assert.equal(plan.dropped.length, 2);
      assert.equal(plan.kept.length, 3);
      assert.deepEqual(plan.dropped.map((raw) => /stale (one|two)/.exec(raw)?.[0]).sort(), ["stale one", "stale two"]);

      // Dry run reports but writes nothing.
      const dry = formatPruneReport({ plans, dryRun: true });
      assert.match(dry, /dry run/);
      assert.equal(fs.existsSync(archiveDir), false);

      const result = applyPrunePlan(plans, archiveDir, TODAY);
      assert.equal(result.removedEntries, 2);
      assert.ok(result.removedChars > 0);

      const rewritten = fs.readFileSync(path.join(globalDir, "failures.md"), "utf-8");
      assert.equal(rewritten, plan.kept.join(DELIMITER));
      assert.equal(fs.readFileSync(path.join(globalDir, "MEMORY.md"), "utf-8"), entry("memory stays untouched", "2026-10-22"));

      const droppedFile = fs.readFileSync(path.join(archiveDir, "global", "failures.md.dropped-entries.md"), "utf-8");
      assert.equal(droppedFile, plan.dropped.join(DELIMITER));
      assert.equal(
        fs.readFileSync(path.join(archiveDir, "global", "failures.md.bak"), "utf-8"),
        failures.join(DELIMITER),
      );
      const manifest = fs.readFileSync(path.join(archiveDir, "MANIFEST.md"), "utf-8");
      assert.match(manifest, /restore/);
      assert.match(manifest, /memory-sync-markdown/);

      // Re-applying the same plan no longer matches the rewritten file: the
      // reconstruction guard fires before anything is written.
      assert.throws(() => applyPrunePlan(plans, archiveDir, TODAY), /does not reconstruct the file/);
      // A plan that does match the current file still refuses to reuse the archive.
      assert.throws(
        () => applyPrunePlan([{ ...plan, dropped: [] }], archiveDir, TODAY),
        /archive directory already exists/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates no archive when nothing is droppable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    try {
      const archive = path.join(root, "archive");
      const result = applyPrunePlan([], archive, TODAY);
      assert.equal(result.removedEntries, 0);
      assert.equal(fs.existsSync(archive), false);
      const text = formatPruneReport(result);
      assert.match(text, /every entry is protected by the keep rules/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a plan whose kept and dropped entries do not reconstruct the file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    try {
      const file = path.join(root, "failures.md");
      fs.writeFileSync(file, entry("on disk", "2026-08-01"), "utf-8");
      const plan: PrunePlan = {
        file,
        storeLabel: "(global)",
        target: "failure",
        kept: [entry("kept", "2026-10-22")],
        dropped: [entry("dropped", "2026-08-01")],
        charsBefore: 0,
        charsKept: 0,
      };
      assert.throws(
        () => applyPrunePlan([plan], path.join(root, "archive"), TODAY),
        /does not reconstruct the file/,
      );
      assert.equal(fs.existsSync(path.join(root, "archive")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
