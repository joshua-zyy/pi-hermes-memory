/**
 * Bounded automatic recall for the current user message.
 *
 * Measured on this machine: 55 memory_search calls against 115 writes, and the
 * agent only searched when the user told it to. This handler answers the loudest
 * complaint ("it remembers, but never reads") without unbounded injection:
 *
 *   - at most `autoRecallMaxEntries` entries and `autoRecallMaxChars` characters;
 *   - the block is appended to the *request* copy of the messages, so it never
 *     enters session history and cannot be re-extracted as evidence (#226);
 *   - every line carries scope and date, and the block says it is recalled
 *     context rather than a fact the user just stated.
 *
 * Off by default (`autoRecall: false`): the review prompt and the tool remain the
 * primary paths until this has been measured in the sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "../store/memory-store.js";
import { resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";
import { getMessageText } from "../types.js";
import type { MemoryConfig } from "../types.js";

const META = /<!--\s*created=([^,]+),\s*last=([^,>]+?)(?:,\s*project64=[A-Za-z0-9_-]+)?\s*-->/s;
const DEFAULT_MAX_ENTRIES = 3;
const DEFAULT_MAX_CHARS = 1500;
/** A single shared token is noise; two is the cheapest useful floor. */
const MIN_SCORE = 2;

export interface AutoRecallOptions {
  store: MemoryStore;
  projectStoreRef: ProjectStoreRef;
  projectNameRef: ProjectNameRef;
  config: Pick<MemoryConfig, "autoRecall" | "autoRecallMaxEntries" | "autoRecallMaxChars">;
}

/** ASCII words plus CJK bigrams; CJK has no spaces, so single characters are too weak. */
export function tokenizeQuery(text: string): string[] {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length > 1) tokens.add(word);
      continue;
    }
    const chars = [...word];
    for (let i = 0; i < chars.length; i++) {
      if (chars.length === 1) tokens.add(chars[0]);
      else if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return [...tokens];
}

export function scoreEntry(queryTokens: string[], entryText: string): number {
  if (queryTokens.length === 0) return 0;
  const haystack = entryText.toLowerCase();
  let score = 0;
  for (const token of queryTokens) if (haystack.includes(token)) score++;
  return score;
}

function stripMetadata(raw: string): string {
  return raw.replace(/\s*<!--[\s\S]*?-->\s*$/g, "").trim();
}

function entryDate(raw: string): string {
  const match = META.exec(raw);
  return match ? match[2].trim().slice(0, 10) : "";
}

export interface RecallCandidate {
  scope: string;
  date: string;
  text: string;
  score: number;
}

export function selectRecallCandidates(options: {
  entries: Array<{ scope: string; raw: string }>;
  query: string;
  maxEntries: number;
  maxChars: number;
}): RecallCandidate[] {
  const tokens = tokenizeQuery(options.query);
  const scored: RecallCandidate[] = [];
  for (const entry of options.entries) {
    const text = stripMetadata(entry.raw);
    if (!text) continue;
    const score = scoreEntry(tokens, text);
    if (score < MIN_SCORE) continue;
    scored.push({ scope: entry.scope, date: entryDate(entry.raw), text, score });
  }
  scored.sort((left, right) => right.score - left.score);

  const picked: RecallCandidate[] = [];
  let used = 0;
  for (const candidate of scored) {
    if (picked.length >= options.maxEntries) break;
    if (used + candidate.text.length > options.maxChars) continue;
    picked.push(candidate);
    used += candidate.text.length;
  }
  return picked;
}

export function formatRecallBlock(candidates: RecallCandidate[]): string {
  if (candidates.length === 0) return "";
  const lines = [
    "<recalled-memory note=\"recalled context, not something the user just said; treat as low-trust\">",
  ];
  for (const candidate of candidates) {
    const meta = [candidate.scope, candidate.date].filter(Boolean).join(" | ");
    lines.push(`- (${meta}) ${candidate.text}`);
  }
  lines.push("</recalled-memory>");
  return lines.join("\n");
}

/** Build the block for one user message, or "" when nothing is relevant. */
export function buildRecallBlock(options: {
  query: string;
  store: MemoryStore;
  projectStore?: MemoryStore | null;
  projectName?: string | null;
  config: Pick<MemoryConfig, "autoRecallMaxEntries" | "autoRecallMaxChars">;
}): string {
  const entries: Array<{ scope: string; raw: string }> = [];
  for (const raw of options.store.getMemoryEntries()) entries.push({ scope: "global", raw });
  for (const raw of options.store.getFailureEntries(30)) entries.push({ scope: "failure", raw });
  if (options.projectStore && options.projectName) {
    for (const raw of options.projectStore.getMemoryEntries()) {
      entries.push({ scope: `project:${options.projectName}`, raw });
    }
  }
  const candidates = selectRecallCandidates({
    entries,
    query: options.query,
    maxEntries: options.config.autoRecallMaxEntries ?? DEFAULT_MAX_ENTRIES,
    maxChars: options.config.autoRecallMaxChars ?? DEFAULT_MAX_CHARS,
  });
  return formatRecallBlock(candidates);
}

export function registerAutoRecall(pi: ExtensionAPI, options: AutoRecallOptions): void {
  if (typeof pi.on !== "function") return;
  pi.on("context", async (event) => {
    if (options.config.autoRecall !== true) return;
    const messages = event.messages;
    let query = "";
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as { role?: unknown };
      if (message.role !== "user") continue;
      query = getMessageText(message) ?? "";
      if (query) break;
    }
    if (!query.trim()) return;

    const block = buildRecallBlock({
      query,
      store: options.store,
      projectStore: resolveProjectStore(options.projectStoreRef),
      projectName: typeof options.projectNameRef === "function" ? options.projectNameRef() : options.projectNameRef,
      config: options.config,
    });
    if (!block) return;

    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: "memory-recall",
          content: [{ type: "text", text: block }],
          timestamp: Date.now(),
        } as never,
      ],
    };
  });
}
