/**
 * Parser for Claude Code's stream-json output format.
 * Extracts text content from newline-delimited JSON events.
 */

export interface StreamEvent {
  timestamp: Date;
  type: "text" | "tool_use" | "thinking" | "other";
  content: string;
}

// Type for parsed JSON event structure
interface ClaudeStreamEvent {
  event?: {
    type?: string;
    delta?: {
      text?: string;
    };
  };
}

function isClaudeStreamEvent(value: unknown): value is ClaudeStreamEvent {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a single line of stream-json output.
 * Returns null for non-text events or malformed JSON.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);

    if (!isClaudeStreamEvent(parsed)) {
      return null;
    }

    const event = parsed.event;

    // Extract text from content_block_delta events
    if (event?.type === "content_block_delta" && event.delta?.text) {
      return {
        timestamp: new Date(),
        type: "text",
        content: event.delta.text,
      };
    }

    // Could expand to handle tool_use, thinking, etc.
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract all text content from an array of stream-json lines.
 */
export function extractTextFromStream(lines: string[]): string {
  return lines
    .map(parseStreamLine)
    .filter((e): e is StreamEvent => e !== null && e.type === "text")
    .map((e) => e.content)
    .join("");
}
