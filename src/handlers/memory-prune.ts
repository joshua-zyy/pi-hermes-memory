/**
 * `/memory-prune` — deterministic, archive-first pruning for memory stores.
 *
 * The consolidation loop is an LLM merge with a bounded budget; it cannot drain a
 * store that receives tens of thousands of characters a day (see the "cannot
 * drain" report). Pruning is the deterministic counterpart: keep what has
 * evidence of value, move everything else into a dated archive, and leave a
 * manifest that can restore it verbatim.
 *
 * Keep rules (all optional inputs, all deterministic):
 *   - durable categories (preference / correction / convention) are never dropped;
 *   - entries recalled at least `--min-hits` times are kept;
 *   - entries created or last referenced within `--keep-days` are kept;
 *   - merged / superseding summaries are kept.
 *
 * Dry run by default. `--apply` archives first, then rewrites each file from the
 * kept entries, then reconciles the SQLite mirror so search cannot return rows
 * whose Markdown entry is gone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY_DELIMITER } from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { listMemoryStoreDirs } from "../store/recovery-maintenance.js";
import { resolveProjectStore, type ProjectStoreRef } from "../project-context.js";
import { parseRetentionEntry, shouldKeepEntry as shouldKeepRetentionEntry, stripEntryMetadata } from "../store/retention.js";
import type { MemoryConfig } from "../types.js";

export type PruneTarget = "memory" | "user" | "failure";

export interface PruneOptions {
  /** Keep entries referenced within this many days. */
  keepDays: number;
  /** Keep entries recalled at least this many times. */
  minHits: number;
  targets: Set<PruneTarget>;
  apply: boolean;
  /** Archive root; defaults to `<archiveBase>/archive-prune-<stamp>`. */
  archiveDir?: string;
}

export function defaultPruneOptions(overrides: Partial<PruneOptions> = {}): PruneOptions {
  return {
    keepDays: 3,
    minHits: 1,
    targets: new Set<PruneTarget>(["failure"]),
    apply: false,
    ...overrides,
  };
}

export interface PrunePlan {
  file: string;
  /** Store directory name, used as the archive subdirectory. */
  storeLabel: string;
  target: PruneTarget;
  kept: string[];
  dropped: string[];
  charsBefore: number;
  charsKept: number;
}

export interface PruneArchiveResult {
  archiveDir: string;
  files: PrunePlan[];
  removedEntries: number;
  removedChars: number;
}

export {
  parseRetentionEntry as parsePruneEntry,
  shouldKeepEntry,
  type RetentionEntry as PruneEntry,
  type RetentionOptions,
} from "../store/retention.js";

function targetFiles(dir: string, isGlobal: boolean): Array<{ target: PruneTarget; name: string }> {
  const files: Array<{ target: PruneTarget; name: string }> = [
    { target: "memory", name: "MEMORY.md" },
    { target: "user", name: "USER.md" },
  ];
  if (isGlobal) files.push({ target: "failure", name: "failures.md" });
  return files;
}

/**
 * Load recall counters for every entry, keyed by stripped content. One query for
 * all scopes: the same text can appear in several scopes and the maximum is the
 * strongest evidence we have.
 */
export function loadHitCounts(dbManager: DatabaseManager | null): Map<string, number> {
  const hits = new Map<string, number>();
  if (!dbManager) return hits;
  try {
    const rows = dbManager.getDb()
      .prepare("SELECT content, max(hit_count) AS hits FROM memories GROUP BY content")
      .all() as Array<{ content: string; hits: number }>;
    for (const row of rows) hits.set(row.content.trim(), row.hits);
  } catch {
    // A read failure must not disable pruning; it degrades to "never recalled".
  }
  return hits;
}

export async function buildPrunePlan(options: {
  config: MemoryConfig;
  globalDir: string;
  dbManager: DatabaseManager | null;
  prune: PruneOptions;
  today?: Date;
  /** Pre-loaded recall counters; defaults to a database read. */
  hits?: Map<string, number>;
}): Promise<PrunePlan[]> {
  const today = options.today ?? new Date();
  const hits = options.hits ?? loadHitCounts(options.dbManager);
  const plans: PrunePlan[] = [];

  for (const dir of await listMemoryStoreDirs({ config: options.config, globalDir: options.globalDir })) {
    const isGlobal = path.resolve(dir) === path.resolve(options.globalDir);
    const storeLabel = isGlobal ? "(global)" : path.basename(dir);
    for (const file of targetFiles(dir, isGlobal)) {
      if (!options.prune.targets.has(file.target)) continue;
      const full = path.join(dir, file.name);
      let content: string;
      try {
        content = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const raws = content.split(ENTRY_DELIMITER).filter((raw) => raw.trim());
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const raw of raws) {
        const entry = parseRetentionEntry(raw, hits);
        (shouldKeepRetentionEntry(entry, options.prune, today) ? kept : dropped).push(raw);
      }
      if (dropped.length === 0) continue;
      plans.push({
        file: full,
        storeLabel,
        target: file.target,
        kept,
        dropped,
        charsBefore: content.length,
        charsKept: kept.join(ENTRY_DELIMITER).length,
      });
    }
  }
  return plans;
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Write the archive and rewrite every planned file. Verifies first that the plan
 * loses nothing: the kept and dropped entries must reconstruct the original set.
 */
export function applyPrunePlan(plans: PrunePlan[], archiveDir: string, today = new Date()): PruneArchiveResult {
  for (const plan of plans) {
    const original = [...plan.kept, ...plan.dropped].sort();
    const onDisk = fs.readFileSync(plan.file, "utf-8").split(ENTRY_DELIMITER).filter((raw) => raw.trim()).sort();
    if (original.length !== onDisk.length || original.some((entry, index) => entry !== onDisk[index])) {
      throw new Error(`prune plan for ${plan.file} does not reconstruct the file; nothing was written`);
    }
  }

  if (plans.length === 0) {
    return { archiveDir, files: [], removedEntries: 0, removedChars: 0 };
  }
  if (fs.existsSync(archiveDir)) {
    throw new Error(`archive directory already exists: ${archiveDir}`);
  }
  fs.mkdirSync(archiveDir, { recursive: true });

  const manifest = [
    `# archive-prune-${stamp(today)}`,
    "",
    `- created: ${today.toISOString()}`,
    "- method: dropped entries are stored verbatim in <store>/<file>.dropped-entries.md, full pre-prune copies in <store>/<file>.bak",
    "- restore: append the dropped file back (entries are separated by an empty line, a section sign, an empty line),",
    "  or copy the .bak over the store file, then run /memory-sync-markdown",
    "- note: archived entries are no longer returned by memory_search",
    "",
    "| store | file | before | after | dropped entries | dropped chars |",
    "|---|---|---|---|---|---|",
  ];
  let removedEntries = 0;
  let removedChars = 0;

  for (const plan of plans) {
    const storeDir = path.join(archiveDir, plan.storeLabel === "(global)" ? "global" : plan.storeLabel);
    fs.mkdirSync(storeDir, { recursive: true });
    const base = path.basename(plan.file);
    fs.writeFileSync(path.join(storeDir, `${base}.bak`), fs.readFileSync(plan.file));
    fs.writeFileSync(path.join(storeDir, `${base}.dropped-entries.md`), plan.dropped.join(ENTRY_DELIMITER), "utf-8");

    const next = plan.kept.join(ENTRY_DELIMITER);
    const temp = `${plan.file}.prune.tmp`;
    fs.writeFileSync(temp, next, "utf-8");
    fs.renameSync(temp, plan.file);

    const droppedChars = plan.charsBefore - next.length;
    manifest.push(
      `| ${plan.storeLabel} | ${base} | ${plan.charsBefore} | ${next.length} | ${plan.dropped.length} | ${droppedChars} |`,
    );
    removedEntries += plan.dropped.length;
    removedChars += droppedChars;
  }

  fs.writeFileSync(path.join(archiveDir, "MANIFEST.md"), `${manifest.join("\n")}\n`, "utf-8");
  return { archiveDir, files: plans, removedEntries, removedChars };
}

export function formatPruneReport(result: PruneArchiveResult | { plans: PrunePlan[]; dryRun: true }): string {
  const plans = "plans" in result ? result.plans : result.files;
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ✂️ Memory Prune ${"dryRun" in result ? "(dry run — nothing written)" : "(applied)"}`);
  lines.push("  " + "─".repeat(66));
  for (const plan of plans) {
    lines.push(
      `  ${plan.storeLabel} ${path.basename(plan.file)}: keep ${plan.kept.length}, drop ${plan.dropped.length} (${plan.charsBefore} → ${plan.charsKept} chars)`,
    );
  }
  if (plans.length === 0) {
    lines.push("  nothing to prune: every entry is protected by the keep rules");
    lines.push("  (durable category, recalled, merged summary, or inside --keep-days)");
  } else if ("archiveDir" in result) {
    lines.push("");
    lines.push(`  removed ${result.removedEntries} entries / ${result.removedChars} chars`);
    lines.push(`  archive: ${result.archiveDir}`);
    lines.push("  restore steps are in MANIFEST.md; the SQLite mirror was reconciled");
  } else {
    lines.push("");
    lines.push("  re-run with --apply to archive and rewrite");
  }
  lines.push("");
  return lines.join("\n");
}

export interface PruneCommandOptions {
  config: MemoryConfig;
  globalDir: string;
  dbManager: DatabaseManager | null;
  store: MemoryStore;
  projectStoreRef: ProjectStoreRef;
  /** Reconcile the SQLite mirror after rewriting files; injected for tests. */
  runSync?: () => Promise<void>;
}

export function parsePruneArgs(args: string): PruneOptions {
  const options = defaultPruneOptions();
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = () => tokens[++index] ?? "";
    if (token === "--apply") options.apply = true;
    else if (token === "--keep-days") options.keepDays = Number(next());
    else if (token === "--min-hits") options.minHits = Number(next());
    else if (token === "--archive") options.archiveDir = next();
    else if (token === "--target") {
      const value = next();
      options.targets = new Set(
        value === "all" ? (["memory", "user", "failure"] as PruneTarget[]) : [value as PruneTarget],
      );
    }
  }
  if (!Number.isFinite(options.keepDays) || options.keepDays < 0) options.keepDays = 3;
  if (!Number.isFinite(options.minHits) || options.minHits < 1) options.minHits = 1;
  return options;
}

export function registerMemoryPruneCommand(pi: ExtensionAPI, options: PruneCommandOptions): void {
  pi.registerCommand("memory-prune", {
    description:
      "Archive-first deterministic prune. Dry run by default; --apply --keep-days N --min-hits N --target failure|memory|user|all",
    handler: async (args, ctx) => {
      const prune = parsePruneArgs(args ?? "");
      const plans = await buildPrunePlan({
        config: options.config,
        globalDir: options.globalDir,
        dbManager: options.dbManager,
        prune,
      });

      if (!prune.apply) {
        ctx.ui.notify(formatPruneReport({ plans, dryRun: true }), "info");
        return;
      }

      if (plans.length === 0) {
        ctx.ui.notify(formatPruneReport({ plans, dryRun: true }), "info");
        return;
      }

      const archiveDir = prune.archiveDir
        ?? path.join(options.globalDir, `archive-prune-${stamp(new Date())}`);
      const result = applyPrunePlan(plans, archiveDir);

      // Rewritten files invalidate both the in-memory stores and the mirror.
      await options.store.loadFromDisk();
      const projectStore = resolveProjectStore(options.projectStoreRef);
      if (projectStore) await projectStore.loadFromDisk();
      if (options.runSync) await options.runSync();

      ctx.ui.notify(formatPruneReport(result), "info");
    },
  });
}
