import { describe, expect, it } from "vitest";
import {
  ABSENT,
  formatBytes,
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokenCount,
  truncate,
} from "../src/format.js";

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(760_000)).toBe("12m 40s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(7_890_000)).toBe("2h 11m");
  });

  it("floors sub-second and invalid inputs", () => {
    expect(formatDuration(400)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");

  it("uses the coarsest unit that fits", () => {
    expect(formatRelativeTime("2026-08-03T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-08-03T11:57:00.000Z", now)).toBe("3m ago");
    expect(formatRelativeTime("2026-08-03T10:00:00.000Z", now)).toBe("2h ago");
    expect(formatRelativeTime("2026-07-29T12:00:00.000Z", now)).toBe("5d ago");
  });

  it("does not round up partial units", () => {
    expect(formatRelativeTime("2026-08-03T10:30:00.000Z", now)).toBe("1h ago");
  });

  it("marks an unparseable timestamp as absent", () => {
    expect(formatRelativeTime("not a date", now)).toBe(ABSENT);
  });
});

describe("formatTokenCount", () => {
  it("compacts thousands and millions", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(742)).toBe("742");
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(18_240)).toBe("18.2k");
    expect(formatTokenCount(1_540_000)).toBe("1.5M");
  });
});

describe("formatCost", () => {
  it("formats dollars and marks unknown pricing", () => {
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0004)).toBe("<$0.01");
    expect(formatCost(null)).toBe(ABSENT);
  });
});

describe("formatBytes", () => {
  it("scales to KB and MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
});

describe("truncate", () => {
  it("only marks text it actually cut", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("0123456789", 10)).toBe("0123456789");
    expect(truncate("0123456789x", 10)).toBe("0123456789…");
    expect(truncate("0123456789x", 10, "!")).toBe("0123456789!");
  });
});
