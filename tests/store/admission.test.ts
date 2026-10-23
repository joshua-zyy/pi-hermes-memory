import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decideAdmission,
  normalizeSignature,
  readTraceRecords,
  summarizeAdmission,
  TRACE_FILE,
} from "../../src/store/admission.js";

const NOW = new Date("2026-10-23T12:00:00Z");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admission-"));
}

describe("write admission", () => {
  it("gives the same signature to texts that differ only in tags, metadata or whitespace", () => {
    const base = normalizeSignature("未捕获的 spawn 错误会让子进程静默失败");
    assert.equal(normalizeSignature("  [insight] 未捕获的 spawn  错误会让子进程静默失败  "), base);
    assert.equal(
      normalizeSignature("未捕获的 spawn 错误会让子进程静默失败 <!-- created=2026-10-01, last=2026-10-02 -->"),
      base,
    );
    assert.notEqual(normalizeSignature("另一条完全不同的内容"), base);
  });

  it("does nothing in off mode", () => {
    const dir = tempDir();
    try {
      const outcome = decideAdmission(
        { target: "failure", category: "insight", text: "first sighting" },
        { storeDir: dir, config: { writeAdmission: "off" }, now: NOW },
      );
      assert.equal(outcome.writeStore, true);
      assert.equal(outcome.traceFile, null);
      assert.equal(fs.existsSync(path.join(dir, TRACE_FILE)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs the shadow decision without changing what is written in trace mode", () => {
    const dir = tempDir();
    try {
      const outcome = decideAdmission(
        { target: "failure", category: "insight", text: "one-off lesson" },
        { storeDir: dir, config: { writeAdmission: "trace" }, now: NOW },
      );
      assert.equal(outcome.decision, "defer");
      assert.equal(outcome.writeStore, true, "trace mode must not change behaviour");
      const records = readTraceRecords(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].reason, "first-sighting");
      assert.equal(records[0].text, "one-off lesson");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers a first sighting and promotes the second one in enforce mode", () => {
    const dir = tempDir();
    try {
      const config = { writeAdmission: "enforce" as const, admissionMinRepeats: 2 };
      const input = { target: "failure" as const, category: "insight", text: "repeated lesson" };

      const first = decideAdmission(input, { storeDir: dir, config, now: NOW });
      assert.equal(first.decision, "defer");
      assert.equal(first.writeStore, false);

      const second = decideAdmission(input, { storeDir: dir, config, now: NOW });
      assert.equal(second.repeats, 1);
      assert.equal(second.decision, "admit");
      assert.equal(second.writeStore, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits corrections and durable categories immediately", () => {
    const dir = tempDir();
    try {
      for (const category of ["correction", "preference", "convention"]) {
        const outcome = decideAdmission(
          { target: "memory", category, text: `durable ${category}` },
          { storeDir: dir, config: { writeAdmission: "enforce" }, now: NOW },
        );
        assert.equal(outcome.reason, "immediate-category");
        assert.equal(outcome.writeStore, true);
      }
      assert.equal(readTraceRecords(dir).length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores repeats that fell out of the window", () => {
    const dir = tempDir();
    try {
      const config = { writeAdmission: "enforce" as const, admissionMinRepeats: 2, admissionWindowDays: 3 };
      const input = { target: "failure" as const, category: "insight", text: "stale repeat" };
      const old = new Date("2026-10-01T12:00:00Z");
      decideAdmission(input, { storeDir: dir, config, now: old });

      const outcome = decideAdmission(input, { storeDir: dir, config, now: NOW });
      assert.equal(outcome.repeats, 0, "a repeat outside the window must not promote");
      assert.equal(outcome.decision, "defer");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarises the trace log for the report", () => {
    const dir = tempDir();
    try {
      const config = { writeAdmission: "trace" as const };
      decideAdmission({ target: "failure", category: "insight", text: "repeat me" }, { storeDir: dir, config, now: NOW });
      decideAdmission({ target: "failure", category: "insight", text: "repeat me" }, { storeDir: dir, config, now: NOW });
      decideAdmission({ target: "memory", category: null, text: "single" }, { storeDir: dir, config, now: NOW });

      const stats = summarizeAdmission(readTraceRecords(dir), { days: 7, now: NOW });
      assert.equal(stats.total, 3);
      assert.equal(stats.byTarget.failure, 2);
      assert.equal(stats.byTarget.memory, 1);
      assert.equal(stats.topRepeated[0]?.repeats, 2);
      assert.match(stats.topRepeated[0]?.preview ?? "", /repeat me/);

      const oldStats = summarizeAdmission(readTraceRecords(dir), { days: 7, now: new Date("2026-12-01T00:00:00Z") });
      assert.equal(oldStats.total, 0, "records outside the window are excluded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
