import { getMessageText } from "../types.js";

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

export function collectMessageParts(entries: unknown[], recentMessages = 0): string[] {
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const msg = (entry as { message?: unknown }).message;
    const text = getMessageText(msg);
    if (!text) continue;

    const role = (msg as { role?: unknown } | null)?.role;
    // Tool output and host-injected context are observations, not assertions the
    // assistant made. Labelling them [ASSISTANT] let a recalled memory or a
    // command result be re-extracted as if it were new evidence (#226).
    const prefix = role === "user"
      ? "[USER]"
      : role === "toolResult" || role === "bashExecution"
        ? "[TOOL]"
        : role === "custom"
          ? "[CONTEXT]"
          : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}
