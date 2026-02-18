import { describe, it, expect } from "vitest";
import { parseStreamLine, extractTextFromStream } from "./stream-parser.js";

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
