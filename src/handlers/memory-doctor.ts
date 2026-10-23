/**
 * `/memory-doctor` — read-only health report for every memory store on disk.
 *
 * Answers the three questions that were previously only visible by hand:
 *   1. How big is each store file against the goal the runtime enforces?
 *   2. Does the SQLite mirror agree with the Markdown truth?
 *   3. How much do the recovery snapshots cost on disk?
 *
 * Nothing is written: files are read, the database is queried, and the result is
 * formatted. Repairs stay explicit (`/memory-sync-markdown`, `/memory-consolidate`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY_DELIMITER } from "../constants.js";
import { listMemoryStoreDirs } from "../store/recovery-maintenance.js";
import { DatabaseManager } from "../store/db.js";
import type { MemoryConfig } from "../types.js";

/** Snapshot sidecars written by saveToDisk() and its retention sweep. */
const SNAPSHOT_PATTERN = /^\..+\.(?:recovery|retired|preconsolidate)\b/;

/** Warn when snapshots for one store exceed this. */
const SNAPSHOT_WARN_BYTES = 10 * 1024 * 1024;

type Target = "memory" | "user" | "failure";

export interface DoctorRow {
  /** "<store> <target>", e.g. "(global) failure" or "piTest memory". */
  label: string;
  dir: string;
  target: Target;
  entries: number;
  chars: number;
  goal: number;
  overGoal: number;
  /** Rows the SQLite mirror holds for this scope, or null when unavailable. */
  mirrorRows: number | null;
}

export interface DoctorStore {
  label: string;
  dir: string;
  snapshots: { count: number; bytes: number };
}

export interface DoctorReport {
  mode: string;
  limits: { memory: number; user: number; failure: number; project: number };
  stores: DoctorStore[];
  rows: DoctorRow[];
  totals: { entries: number; chars: number; mirrorRows: number };
  warnings: string[];
}

export interface DoctorOptions {
  config: MemoryConfig;
  globalDir: string;
  dbManager: DatabaseManager | null;
}

function readEntries(file: string): { entries: number; chars: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { entries: 0, chars: 0 };
  }
  if (!raw.trim()) return { entries: 0, chars: 0 };
  const entries = raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
  return { entries: entries.length, chars: entries.join(ENTRY_DELIMITER).length };
}

function readSnapshots(dir: string): { count: number; bytes: number } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!SNAPSHOT_PATTERN.test(name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      count++;
      bytes += stat.size;
    } catch {
      // A snapshot removed between readdir and stat is not a finding.
    }
  }
  return { count, bytes };
}

function mirrorCount(dbManager: DatabaseManager | null, target: Target, project: string | null): number | null {
  if (!dbManager) return null;
  try {
    const db = dbManager.getDb();
    // failures.md is one global file whose entries carry per-project tags, so the
    // mirror comparison must count every failure row regardless of project.
    const row = target === "failure"
      ? db.prepare("SELECT count(*) AS n FROM memories WHERE target = 'failure'").get()
      : project === null
        ? db.prepare("SELECT count(*) AS n FROM memories WHERE target = ? AND project IS NULL").get(target)
        : db.prepare("SELECT count(*) AS n FROM memories WHERE target = ? AND project = ?").get(target, project);
    return (row as { n: number } | undefined)?.n ?? 0;
  } catch {
    return null;
  }
}

/** Collect the report. Exported for tests; the command is a thin wrapper. */
export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const { config, globalDir, dbManager } = options;
  const limits = {
    memory: config.memoryCharLimit,
    user: config.userCharLimit,
    failure: config.memoryCharLimit * 2,
    project: config.projectCharLimit ?? config.memoryCharLimit,
  };

  const dirs = await listMemoryStoreDirs({ config, globalDir });
  const stores: DoctorStore[] = [];
  const rows: DoctorRow[] = [];

  for (const dir of dirs) {
    const isGlobal = path.resolve(dir) === path.resolve(globalDir);
    const scope = isGlobal ? null : path.basename(dir);
    const storeLabel = scope ?? "(global)";
    stores.push({ label: storeLabel, dir, snapshots: readSnapshots(dir) });

    const files: Array<{ target: Target; name: string; goal: number }> = [
      { target: "memory", name: "MEMORY.md", goal: isGlobal ? limits.memory : limits.project },
      { target: "user", name: "USER.md", goal: limits.user },
    ];
    // The failure tier is one global file; project stores have no failure file.
    if (isGlobal) files.push({ target: "failure", name: "failures.md", goal: limits.failure });

    for (const file of files) {
      const stat = readEntries(path.join(dir, file.name));
      rows.push({
        label: `${storeLabel} ${file.target}`,
        dir,
        target: file.target,
        entries: stat.entries,
        chars: stat.chars,
        goal: file.goal,
        overGoal: Math.max(0, stat.chars - file.goal),
        mirrorRows: mirrorCount(dbManager, file.target, scope),
      });
    }
  }

  const warnings: string[] = [];
  for (const row of rows) {
    if (row.overGoal > 0) {
      warnings.push(`${row.label}: ${row.chars - row.goal} chars over its goal (${row.chars}/${row.goal})`);
    }
    if (row.mirrorRows !== null && row.mirrorRows > row.entries) {
      warnings.push(
        `${row.label}: mirror holds ${row.mirrorRows} rows for ${row.entries} Markdown entries — run /memory-sync-markdown`,
      );
    }
  }
  for (const store of stores) {
    if (store.snapshots.bytes > SNAPSHOT_WARN_BYTES) {
      warnings.push(`${store.label}: ${store.snapshots.count} snapshots cost ${(store.snapshots.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
  }

  return {
    mode: config.memoryMode,
    limits,
    stores,
    rows,
    totals: {
      entries: rows.reduce((sum, row) => sum + row.entries, 0),
      chars: rows.reduce((sum, row) => sum + row.chars, 0),
      mirrorRows: rows.reduce((sum, row) => sum + (row.mirrorRows ?? 0), 0),
    },
    warnings,
  };
}

const LABEL_WIDTH = 26;

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  🧠 Memory Doctor (read-only)");
  lines.push("  " + "─".repeat(74));
  lines.push(`  mode: ${report.mode}`);
  lines.push(
    `  goals: memory ${report.limits.memory}, user ${report.limits.user}, failure ${report.limits.failure}, project ${report.limits.project}`,
  );
  lines.push("");
  lines.push(`  ${"store".padEnd(LABEL_WIDTH)}${pad("chars", 8)}${pad("goal", 8)}${pad("over", 8)}${pad("ent", 6)}${pad("mirror", 7)}`);

  for (const store of report.stores) {
    const snapshots = `${store.snapshots.count} snap / ${(store.snapshots.bytes / 1024 / 1024).toFixed(1)} MB`;
    lines.push(`  ${store.label.padEnd(LABEL_WIDTH)}${" ".repeat(29)}${pad(snapshots, 20)}`);
    for (const row of report.rows.filter((candidate) => candidate.dir === store.dir)) {
      lines.push(
        `  ${row.label.padEnd(LABEL_WIDTH)}${pad(row.chars, 8)}${pad(row.goal, 8)}${pad(row.overGoal || "-", 8)}${pad(row.entries, 6)}${pad(row.mirrorRows ?? "n/a", 7)}`,
      );
    }
  }

  lines.push(
    `  ${"TOTAL".padEnd(LABEL_WIDTH)}${pad(report.totals.chars, 8)}${pad("-", 8)}${pad("-", 8)}${pad(report.totals.entries, 6)}${pad(report.totals.mirrorRows, 7)}`,
  );
  lines.push("");
  if (report.warnings.length === 0) {
    lines.push("  ✅ no findings");
  } else {
    lines.push(`  ⚠️ ${report.warnings.length} finding${report.warnings.length === 1 ? "" : "s"}:`);
    for (const warning of report.warnings) lines.push(`   - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function registerMemoryDoctorCommand(pi: ExtensionAPI, options: DoctorOptions): void {
  pi.registerCommand("memory-doctor", {
    description: "Read-only health check: store sizes vs goals, SQLite mirror drift, snapshot cost",
    handler: async (_args, ctx) => {
      const report = await collectDoctorReport(options);
      ctx.ui.notify(formatDoctorReport(report), report.warnings.length > 0 ? "warning" : "info");
    },
  });
}
