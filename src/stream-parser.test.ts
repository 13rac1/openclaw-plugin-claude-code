import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseStreamLine,
  extractTextFromStream,
  parseRateLimitError,
  parseAuthError,
} from "./stream-parser.js";

describe("parseStreamLine", () => {
  it("parses content_block_delta event with text", () => {
    const line = '{"event":{"type":"content_block_delta","delta":{"text":"Hello"}}}';
    const result = parseStreamLine(line);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("text");
    expect(result?.content).toBe("Hello");
  });

  it("returns null for content_block_stop event", () => {
    const line = '{"event":{"type":"content_block_stop"}}';
    const result = parseStreamLine(line);

    expect(result).toBeNull();
  });

  it("returns null for message_stop event", () => {
    const line = '{"event":{"type":"message_stop"}}';
    const result = parseStreamLine(line);

    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const line = "not valid json";
    const result = parseStreamLine(line);

    expect(result).toBeNull();
  });

  it("returns null for empty text delta", () => {
    const line = '{"event":{"type":"content_block_delta","delta":{}}}';
    const result = parseStreamLine(line);

    expect(result).toBeNull();
  });

  it("returns null for non-object input (parsed as array)", () => {
    const line = "[1, 2, 3]";
    const result = parseStreamLine(line);

    expect(result).toBeNull();
  });

  it("sets timestamp on parsed event", () => {
    const line = '{"event":{"type":"content_block_delta","delta":{"text":"test"}}}';
    const before = new Date();
    const result = parseStreamLine(line);
    const after = new Date();

    expect(result?.timestamp).toBeDefined();
    expect(result?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result?.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("extractTextFromStream", () => {
  it("extracts text from multiple lines", () => {
    const lines = [
      '{"event":{"type":"content_block_delta","delta":{"text":"Hello"}}}',
      '{"event":{"type":"content_block_delta","delta":{"text":" "}}}',
      '{"event":{"type":"content_block_delta","delta":{"text":"world"}}}',
    ];

    const result = extractTextFromStream(lines);
    expect(result).toBe("Hello world");
  });

  it("ignores non-text events", () => {
    const lines = [
      '{"event":{"type":"content_block_delta","delta":{"text":"Hello"}}}',
      '{"event":{"type":"content_block_stop"}}',
      '{"event":{"type":"message_stop"}}',
    ];

    const result = extractTextFromStream(lines);
    expect(result).toBe("Hello");
  });

  it("ignores malformed lines", () => {
    const lines = [
      '{"event":{"type":"content_block_delta","delta":{"text":"Good"}}}',
      "not json",
      '{"event":{"type":"content_block_delta","delta":{"text":" text"}}}',
    ];

    const result = extractTextFromStream(lines);
    expect(result).toBe("Good text");
  });

  it("returns empty string for empty input", () => {
    const result = extractTextFromStream([]);
    expect(result).toBe("");
  });

  it("returns empty string when no text events found", () => {
    const lines = ['{"event":{"type":"content_block_stop"}}', '{"event":{"type":"message_stop"}}'];

    const result = extractTextFromStream(lines);
    expect(result).toBe("");
  });
});

describe("parseRateLimitError", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects rate limit error with pm time format", () => {
    // Set current time to 6pm UTC
    vi.setSystemTime(new Date("2024-01-15T18:00:00.000Z"));

    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit · resets 8pm (UTC)",
    });

    const result = parseRateLimitError(line);

    expect(result).not.toBeNull();
    expect(result?.resetTime).toBe("8pm UTC");
    expect(result?.waitMinutes).toBe(120); // 2 hours = 120 minutes
  });

  it("detects rate limit error with am time format", () => {
    // Set current time to 11pm UTC
    vi.setSystemTime(new Date("2024-01-15T23:00:00.000Z"));

    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your limit · resets 2am (UTC)",
    });

    const result = parseRateLimitError(line);

    expect(result).not.toBeNull();
    expect(result?.resetTime).toBe("2am UTC");
    expect(result?.waitMinutes).toBe(180); // 3 hours = 180 minutes
  });

  it("handles reset time that wraps to next day", () => {
    // Set current time to 10pm UTC
    vi.setSystemTime(new Date("2024-01-15T22:30:00.000Z"));

    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your limit · resets 6am (UTC)",
    });

    const result = parseRateLimitError(line);

    expect(result).not.toBeNull();
    expect(result?.waitMinutes).toBe(450); // 7.5 hours = 450 minutes
  });

  it("returns null for non-rate-limit result", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "Task completed successfully",
    });

    const result = parseRateLimitError(line);
    expect(result).toBeNull();
  });

  it("returns null for error without rate limit message", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "API error occurred",
    });

    const result = parseRateLimitError(line);
    expect(result).toBeNull();
  });

  it("returns null for non-result event type", () => {
    const line = JSON.stringify({
      type: "message",
      content: "You've hit your limit · resets 8pm (UTC)",
    });

    const result = parseRateLimitError(line);
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const result = parseRateLimitError("not valid json");
    expect(result).toBeNull();
  });

  it("returns null for non-object input", () => {
    const result = parseRateLimitError("[1, 2, 3]");
    expect(result).toBeNull();
  });

  it("handles 12pm correctly", () => {
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));

    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your limit · resets 12pm (UTC)",
    });

    const result = parseRateLimitError(line);
    expect(result?.waitMinutes).toBe(120); // 2 hours
  });

  it("handles 12am correctly", () => {
    vi.setSystemTime(new Date("2024-01-15T22:00:00.000Z"));

    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your limit · resets 12am (UTC)",
    });

    const result = parseRateLimitError(line);
    expect(result?.waitMinutes).toBe(120); // 2 hours
  });
});

describe("parseAuthError", () => {
  it("detects OAuth token expired error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result:
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_123"}',
    });

    const result = parseAuthError(line);

    expect(result).not.toBeNull();
    expect(result?.errorType).toBe("token_expired");
    expect(result?.message).toBe("OAuth token has expired. Please re-authenticate Claude Code.");
  });

  it("detects general authentication failure", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Failed to authenticate. Invalid API key.",
    });

    const result = parseAuthError(line);

    expect(result).not.toBeNull();
    expect(result?.errorType).toBe("authentication_failed");
    expect(result?.message).toBe(
      "Authentication failed. Please check your Claude Code credentials."
    );
  });

  it("detects authentication_error type", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result:
        'API Error: {"type":"error","error":{"type":"authentication_error","message":"Invalid credentials"}}',
    });

    const result = parseAuthError(line);

    expect(result).not.toBeNull();
    expect(result?.errorType).toBe("authentication_failed");
  });

  it("returns null for non-auth errors", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Network error: connection refused",
    });

    const result = parseAuthError(line);
    expect(result).toBeNull();
  });

  it("returns null for successful result", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "Task completed successfully",
    });

    const result = parseAuthError(line);
    expect(result).toBeNull();
  });

  it("returns null for non-result event type", () => {
    const line = JSON.stringify({
      type: "message",
      content: "OAuth token has expired",
    });

    const result = parseAuthError(line);
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const result = parseAuthError("not valid json");
    expect(result).toBeNull();
  });

  it("returns null for non-object input", () => {
    const result = parseAuthError("[1, 2, 3]");
    expect(result).toBeNull();
  });
});
