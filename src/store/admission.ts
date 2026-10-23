/**
 * Write-side admission for the memory store.
 *
 * The measured problem: the failure tier takes tens of thousands of characters a
 * day while only a fraction of the entries is ever recalled, and every write also
 * pays an LLM review/flush turn (token write amplification). Consolidation cannot
 * drain that, and pruning only removes what is already stale.
 *
 * Admission makes the *expensive* store earned rather than default:
 *   - corrections and durable preferences/conventions are admitted immediately;
 *   - everything else must be seen at least `admissionMinRepeats` times inside
 *     `admissionWindowDays` before it is promoted;
 *   - the first sighting is recorded in an append-only trace log.
 *
 * Modes (`writeAdmission`):
 *   - `off`     — current behaviour: decide nothing, log nothing.
 *   - `trace`   — shadow mode: decide and log, but always write to the store.
 *   - `enforce` — non-admitted writes are deferred to the trace log only.
 *
 * `trace` is the intended first deployment: it changes no behaviour and produces
 * the admission-rate data needed to tune the rules.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type AdmissionMode = "off" | "trace" | "enforce";
export type AdmissionTarget = "memory" | "user" | "failure" | "project";
export type AdmissionDecision = "admit" | "defer";

/** Categories that never wait for repetition. */
const IMMEDIATE_CATEGORIES = new Set(["correction", "preference", "convention"]);

export const TRACE_FILE = "trace.jsonl";
const TRACE_MAX_BYTES = 8 * 1024 * 1024;

export interface AdmissionRecord {
  ts: string;
  target: AdmissionTarget;
  project: string | null;
  category: string | null;
  /** Content hash, so repeats are detected without comparing full text. */
  sig: string;
  chars: number;
  decision: AdmissionDecision;
  reason: "immediate-category" | "repeat" | "first-sighting";
  repeats: number;
  /** Retained so the trace log can act as the cold tier later. */
  text: string;
}

export interface AdmissionInput {
  target: AdmissionTarget;
  project?: string | null;
  category?: string | null;
  text: string;
}

export interface AdmissionConfig {
  writeAdmission?: AdmissionMode;
  admissionMinRepeats?: number;
  admissionWindowDays?: number;
}

export interface AdmissionOutcome {
  decision: AdmissionDecision;
  reason: AdmissionRecord["reason"];
  repeats: number;
  /** True when the caller should write to the store. */
  writeStore: boolean;
  /** Path of the trace log, when it was read or written. */
  traceFile: string | null;
}

/**
 * Stable signature for duplicate detection: category tags, metadata comments and
 * whitespace differences do not create a new identity.
 */
export function normalizeSignature(text: string): string {
  const normalized = text
    .replace(/\s*<!--[\s\S]*?-->\s*$/g, " ")
    .replace(/^\s*\[[a-z-]+\]\s*/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** Read every record the trace log holds. Malformed lines are skipped. */
export function readTraceRecords(storeDir: string): AdmissionRecord[] {
  const file = path.join(storeDir, TRACE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const records: AdmissionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AdmissionRecord);
    } catch {
      // A partially written last line must not break the reader.
    }
  }
  return records;
}

function rotateIfLarge(file: string): void {
  try {
    const size = fs.statSync(file).size;
    if (size < TRACE_MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Missing file or a locked rename: keep appending rather than lose the record.
  }
}

export function appendTraceRecord(storeDir: string, record: AdmissionRecord): string {
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, TRACE_FILE);
  rotateIfLarge(file);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
  return file;
}

/** Entry text without the trailing metadata comment. */
export function stripEntryMetadata(raw: string): string {
  return raw.replace(/\s*<!--[\s\S]*?-->\s*$/g, "").trim();
}

/**
 * True when the store already holds this text.
 *
 * A write that the store would reject as a duplicate is not a new observation, so
 * it must not count towards promotion: re-adding an existing entry is the model
 * being repetitive, not a lesson recurring.
 */
export function isAlreadyStored(text: string, existingEntries: readonly string[]): boolean {
  const needle = stripEntryMetadata(text);
  return existingEntries.some((entry) => stripEntryMetadata(entry) === needle);
}

export function admissionMode(config: AdmissionConfig): AdmissionMode {
  return config.writeAdmission ?? "off";
}

function windowStart(days: number, now: Date): number {
  return now.getTime() - Math.max(1, days) * 86_400_000;
}

/**
 * Decide whether a write is promoted to the store. Pure with respect to the
 * store: the only side effect is appending to the trace log, and only when the
 * mode is not `off`.
 */
export function decideAdmission(
  input: AdmissionInput,
  options: { storeDir: string; config: AdmissionConfig; now?: Date },
): AdmissionOutcome {
  const mode = admissionMode(options.config);
  // No gate and no store directory (tests, standalone stores) both mean "admit".
  if (mode === "off" || !options.storeDir) {
    return { decision: "admit", reason: "immediate-category", repeats: 0, writeStore: true, traceFile: null };
  }
  const traceFile = path.join(options.storeDir, TRACE_FILE);

  const now = options.now ?? new Date();
  const minRepeats = Math.max(2, options.config.admissionMinRepeats ?? 2);
  const days = options.config.admissionWindowDays ?? 14;
  const sig = normalizeSignature(input.text);
  const since = windowStart(days, now);

  const repeats = readTraceRecords(options.storeDir).filter(
    (record) => record.sig === sig && Date.parse(record.ts) >= since,
  ).length;

  const category = input.category ?? null;
  const immediate = category !== null && IMMEDIATE_CATEGORIES.has(category);
  const promoted = repeats + 1 >= minRepeats;

  const decision: AdmissionDecision = immediate || promoted ? "admit" : "defer";
  const reason: AdmissionRecord["reason"] = immediate ? "immediate-category" : promoted ? "repeat" : "first-sighting";
  // In trace mode the shadow decision is recorded but the store write proceeds.
  const writeStore = mode === "trace" ? true : decision === "admit";

  appendTraceRecord(options.storeDir, {
    ts: now.toISOString(),
    target: input.target,
    project: input.project ?? null,
    category,
    sig,
    chars: input.text.length,
    decision,
    reason,
    repeats,
    text: input.text,
  });

  return { decision, reason, repeats, writeStore, traceFile };
}

export interface AdmissionStats {
  total: number;
  admitted: number;
  deferred: number;
  byReason: Record<string, number>;
  byTarget: Record<string, number>;
  charsDeferred: number;
  topRepeated: Array<{ sig: string; repeats: number; preview: string }>;
}

export function summarizeAdmission(
  records: AdmissionRecord[],
  options: { days?: number; now?: Date } = {},
): AdmissionStats {
  const since = windowStart(options.days ?? 7, options.now ?? new Date());
  const windowed = records.filter((record) => Date.parse(record.ts) >= since);

  const byReason: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  const texts = new Map<string, { repeats: number; preview: string }>();
  let admitted = 0;
  let deferred = 0;
  let charsDeferred = 0;

  for (const record of windowed) {
    byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
    byTarget[record.target] = (byTarget[record.target] ?? 0) + 1;
    if (record.decision === "admit") admitted++;
    else {
      deferred++;
      charsDeferred += record.chars;
    }
    const current = texts.get(record.sig);
    texts.set(record.sig, {
      repeats: (current?.repeats ?? 0) + 1,
      preview: current?.preview ?? record.text.replace(/\s+/g, " ").slice(0, 80),
    });
  }

  const topRepeated = [...texts.entries()]
    .filter(([, value]) => value.repeats > 1)
    .sort((left, right) => right[1].repeats - left[1].repeats)
    .slice(0, 5)
    .map(([sig, value]) => ({ sig, repeats: value.repeats, preview: value.preview }));

  return { total: windowed.length, admitted, deferred, byReason, byTarget, charsDeferred, topRepeated };
}
