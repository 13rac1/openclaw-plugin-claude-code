/**
 * Parser for Claude Code's stream-json output format.
 * Extracts text content from newline-delimited JSON events.
 */

export interface StreamEvent {
  timestamp: Date;
  type: "text" | "tool_use" | "thinking" | "rate_limit" | "other";
  content: string;
}

export interface RateLimitInfo {
  resetTime: string; // e.g., "8pm (UTC)"
  waitMinutes: number; // minutes until reset
}

export interface AuthErrorInfo {
  errorType: "token_expired" | "authentication_failed";
  message: string;
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

// Type for parsed JSON that might be a result event
interface MaybeResultEvent {
  type?: string;
  is_error?: boolean;
  result?: string;
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

/**
 * Check if a line is a result event indicating a rate limit error.
 * Returns rate limit info if detected, null otherwise.
 */
export function parseRateLimitError(line: string): RateLimitInfo | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const event = parsed as MaybeResultEvent;
    if (event.type !== "result" || !event.is_error || typeof event.result !== "string") {
      return null;
    }

    // Check for rate limit message pattern: "You've hit your limit · resets 8pm (UTC)"
    const rateLimitRegex = /hit your limit.*resets?\s+(\d{1,2}(?:am|pm)?)\s*\(UTC\)/i;
    const match = rateLimitRegex.exec(event.result);
    if (!match) {
      return null;
    }

    const resetTime = match[1] + " UTC";
    const waitMinutes = calculateWaitMinutes(match[1]);

    return { resetTime, waitMinutes };
  } catch {
    return null;
  }
}

/**
 * Check if a line is a result event indicating an authentication error.
 * Returns auth error info if detected, null otherwise.
 */
export function parseAuthError(line: string): AuthErrorInfo | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const event = parsed as MaybeResultEvent;
    if (event.type !== "result" || !event.is_error || typeof event.result !== "string") {
      return null;
    }

    // Check for OAuth token expired
    if (event.result.includes("OAuth token has expired")) {
      return {
        errorType: "token_expired",
        message: "OAuth token has expired. Please re-authenticate Claude Code.",
      };
    }

    // Check for general authentication failure
    if (
      event.result.includes("Failed to authenticate") ||
      event.result.includes("authentication_error")
    ) {
      return {
        errorType: "authentication_failed",
        message: "Authentication failed. Please check your Claude Code credentials.",
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate minutes until the reset time.
 * Assumes reset time is in UTC and format like "8pm" or "14".
 */
function calculateWaitMinutes(resetTimeStr: string): number {
  const now = new Date();
  const nowUtcHours = now.getUTCHours();
  const nowUtcMinutes = now.getUTCMinutes();

  // Parse reset time - could be "8pm", "8am", or "14" (24h)
  let resetHour: number;
  const lowerTime = resetTimeStr.toLowerCase();

  if (lowerTime.includes("pm")) {
    const hourNum = parseInt(lowerTime.replace("pm", ""), 10);
    resetHour = hourNum === 12 ? 12 : hourNum + 12;
  } else if (lowerTime.includes("am")) {
    const hourNum = parseInt(lowerTime.replace("am", ""), 10);
    resetHour = hourNum === 12 ? 0 : hourNum;
  } else {
    resetHour = parseInt(resetTimeStr, 10);
  }

  // Calculate minutes until reset
  let hoursUntil = resetHour - nowUtcHours;
  if (hoursUntil < 0) {
    hoursUntil += 24; // Reset is tomorrow
  }

  let minutesUntil = hoursUntil * 60 - nowUtcMinutes;
  if (minutesUntil < 0) {
    minutesUntil += 24 * 60; // Reset is tomorrow
  }

  return minutesUntil;
}
