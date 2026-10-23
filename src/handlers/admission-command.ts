/**
 * `/memory-admission` — what the write-side admission gate would promote or defer.
 *
 * Reads the append-only trace log and summarises the last N days: how many
 * candidate writes arrived, how many would be promoted, why, and which signatures
 * keep repeating (the strongest promotion signal).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { readTraceRecords, summarizeAdmission, type AdmissionStats } from "../store/admission.js";
import { resolveProjectStore, type ProjectStoreRef } from "../project-context.js";
import type { MemoryConfig } from "../types.js";

export function formatAdmissionReport(stats: AdmissionStats, options: { days: number; mode: string }): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  🚦 Memory Admission (last ${options.days} day${options.days === 1 ? "" : "s"})`);
  lines.push("  " + "─".repeat(62));
  lines.push(`  mode: ${options.mode}`);
  lines.push("");

  if (stats.total === 0) {
    lines.push("  no candidate writes in the window");
    if (options.mode === "off") {
      lines.push("  set \"writeAdmission\": \"trace\" to start collecting admission data");
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`  candidates: ${stats.total}`);
  lines.push(`  would promote: ${stats.admitted}   would defer: ${stats.deferred} (${stats.charsDeferred} chars)`);
  lines.push("");
  lines.push("  by reason:");
  for (const [reason, count] of Object.entries(stats.byReason).sort((left, right) => right[1] - left[1])) {
    lines.push(`    ${reason.padEnd(20)}${count}`);
  }
  lines.push("  by target:");
  for (const [target, count] of Object.entries(stats.byTarget).sort((left, right) => right[1] - left[1])) {
    lines.push(`    ${target.padEnd(20)}${count}`);
  }
  if (stats.topRepeated.length > 0) {
    lines.push("");
    lines.push("  most repeated candidates (promotion evidence):");
    for (const entry of stats.topRepeated) {
      lines.push(`    ${entry.repeats}× ${entry.preview}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function registerAdmissionCommand(
  pi: ExtensionAPI,
  options: {
    config: MemoryConfig;
    store: MemoryStore;
    projectStoreRef: ProjectStoreRef;
  },
): void {
  pi.registerCommand("memory-admission", {
    description: "Write-side admission stats from the trace log (--days N, default 7)",
    handler: async (args, ctx) => {
      const match = /--days\s+(\d+)/.exec(args ?? "");
      const days = match ? Math.max(1, Number(match[1])) : 7;
      const stores = [options.store, resolveProjectStore(options.projectStoreRef)].filter(
        (candidate): candidate is MemoryStore => candidate !== null,
      );
      const records = stores.flatMap((candidate) => readTraceRecords(candidate.storageDir));
      const stats = summarizeAdmission(records, { days });
      ctx.ui.notify(
        formatAdmissionReport(stats, { days, mode: options.config.writeAdmission ?? "off" }),
        "info",
      );
    },
  });
}
