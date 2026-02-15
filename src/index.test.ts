import { describe, it, expect } from "vitest";
import { formatDuration } from "./index.js";

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(300000)).toBe("5m 0s");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(3660000)).toBe("1h 1m");
    expect(formatDuration(7200000)).toBe("2h 0m");
    expect(formatDuration(86399000)).toBe("23h 59m");
  });

  it("formats days and hours", () => {
    expect(formatDuration(86400000)).toBe("1d 0h");
    expect(formatDuration(90000000)).toBe("1d 1h");
    expect(formatDuration(172800000)).toBe("2d 0h");
    expect(formatDuration(259200000)).toBe("3d 0h");
  });
});
