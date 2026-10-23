/**
 * Retention rules shared by `/memory-prune` and capacity demotion.
 *
 * One definition of "worth keeping" keeps the two paths from disagreeing: a
 * write-time demotion that used different rules than the prune command would
 * either delete what prune protects or keep what prune drops.
 */

/** Categories that carry durable, human-relevant value. */
export const DURABLE_CATEGORIES = new Set(["preference", "correction", "convention"]);

/** Markers a consolidation merge leaves behind; those entries are the distilled core. */
export const MERGED_MARKERS = ["合并", "取代", "supersedes"];

const META_PATTERN = /<!--\s*created=([^,]+),\s*last=([^,>]+?)(?:,\s*project64=[A-Za-z0-9_-]+)?\s*-->/s;
const CATEGORY_PATTERN = /^\s*\[([a-z-]+)\]/;

export interface RetentionEntry {
  raw: string;
  created: string;
  last: string;
  category: string | null;
  hits: number;
}

export interface RetentionOptions {
  /** Keep entries referenced within this many days. */
  keepDays: number;
  /** Keep entries recalled at least this many times. */
  minHits: number;
}

export function stripEntryMetadata(raw: string): string {
  return raw.replace(/\s*<!--[\s\S]*?-->\s*$/g, "").trim();
}

export function parseRetentionEntry(raw: string, hits: Map<string, number>): RetentionEntry {
  const meta = META_PATTERN.exec(raw);
  const text = stripEntryMetadata(raw);
  const category = CATEGORY_PATTERN.exec(text)?.[1] ?? null;
  return {
    raw,
    created: meta ? meta[1].trim().slice(0, 10) : "",
    last: meta ? meta[2].trim().slice(0, 10) : "",
    category,
    hits: hits.get(text) ?? 0,
  };
}

function daysSince(value: string, today: Date): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Math.floor((today.getTime() - parsed) / 86_400_000);
}

/** True when an entry must never be demoted or pruned by an automatic rule. */
export function isProtectedEntry(entry: RetentionEntry): boolean {
  if (entry.category && DURABLE_CATEGORIES.has(entry.category)) return true;
  const text = stripEntryMetadata(entry.raw);
  return MERGED_MARKERS.some((marker) => text.includes(marker));
}

export function shouldKeepEntry(entry: RetentionEntry, options: RetentionOptions, today = new Date()): boolean {
  if (isProtectedEntry(entry)) return true;
  if (entry.hits >= Math.max(1, options.minHits)) return true;
  const newest = entry.last || entry.created;
  if (!newest) return true; // no metadata: never drop something we cannot date
  return daysSince(newest, today) <= options.keepDays;
}
