import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyJobCompletion, type JobCompletionEvent } from "./notification.js";

describe("notification", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("notifyJobCompletion", () => {
    const baseEvent: JobCompletionEvent = {
      jobId: "test-job-123",
      sessionKey: "test-session",
      status: "completed",
      elapsedSeconds: 45.5,
      outputSize: 12500,
      exitCode: 0,
      errorType: null,
    };

    const config = {
      webhookUrl: "http://localhost:18789/hooks/agent",
      webhookToken: "test-token-abc",
    };

    it("sends POST request to webhook URL with correct headers", async () => {
      await notifyJobCompletion(config, baseEvent);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:18789/hooks/agent",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-token-abc",
            "Content-Type": "application/json",
          },
        })
      );
    });

    it("includes sessionKey with hook:claude-code: prefix", async () => {
      await notifyJobCompletion(config, baseEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.sessionKey).toBe("hook:claude-code:test-session");
    });

    it("includes wakeMode, deliver, and channel fields", async () => {
      await notifyJobCompletion(config, baseEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.wakeMode).toBe("now");
      expect(body.deliver).toBe(true);
      expect(body.channel).toBe("last");
    });

    it("formats completed job message correctly", async () => {
      await notifyJobCompletion(config, baseEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toContain("Claude Code Job Completed");
      expect(body.message).toContain("test-job-123");
      expect(body.message).toContain("test-session");
      expect(body.message).toContain("✅ completed");
      expect(body.message).toContain("46s"); // 45.5 rounds to 46
      expect(body.message).toContain("12.2 KB");
    });

    it("formats failed job message with error info", async () => {
      const failedEvent: JobCompletionEvent = {
        ...baseEvent,
        status: "failed",
        exitCode: 137,
        errorType: "oom",
      };

      await notifyJobCompletion(config, failedEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toContain("Job Failed");
      expect(body.message).toContain("❌ failed");
      expect(body.message).toContain("oom");
      expect(body.message).toContain("exit code 137");
    });

    it("formats cancelled job message correctly", async () => {
      const cancelledEvent: JobCompletionEvent = {
        ...baseEvent,
        status: "cancelled",
        exitCode: null,
      };

      await notifyJobCompletion(config, cancelledEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toContain("Job Cancelled");
      expect(body.message).toContain("⚪ cancelled");
    });

    it("logs error but does not throw on webhook failure", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });

      await notifyJobCompletion(config, baseEvent);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Notification webhook failed: 500")
      );
      consoleSpy.mockRestore();
    });

    it("formats duration with minutes for longer jobs", async () => {
      const longEvent: JobCompletionEvent = {
        ...baseEvent,
        elapsedSeconds: 150, // 2m 30s
      };

      await notifyJobCompletion(config, longEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toContain("2m 30s");
    });

    it("formats output size in MB for large outputs", async () => {
      const largeOutputEvent: JobCompletionEvent = {
        ...baseEvent,
        outputSize: 5 * 1024 * 1024, // 5MB
      };

      await notifyJobCompletion(config, largeOutputEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toContain("5 MB");
    });
  });
});
