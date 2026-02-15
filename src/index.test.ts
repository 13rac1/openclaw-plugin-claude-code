import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { formatDuration } from "./index.js";
import register from "./index.js";
import * as sessionManagerModule from "./session-manager.js";
import * as podmanRunnerModule from "./podman-runner.js";
import * as fs from "node:fs/promises";

// Mock dependencies
vi.mock("./session-manager.js");
vi.mock("./podman-runner.js");
vi.mock("node:fs/promises");

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

describe("register", () => {
  let mockApi: {
    config: Record<string, unknown>;
    registerTool: Mock;
  };
  let mockSessionManager: {
    getOrCreateSession: Mock;
    updateSession: Mock;
    cleanupIdleSessions: Mock;
    listSessions: Mock;
    workspaceDir: Mock;
  };
  let mockPodmanRunner: {
    checkImage: Mock;
    runClaudeCode: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionManager = {
      getOrCreateSession: vi.fn(),
      updateSession: vi.fn(),
      cleanupIdleSessions: vi.fn(),
      listSessions: vi.fn(),
      workspaceDir: vi.fn(),
    };

    mockPodmanRunner = {
      checkImage: vi.fn(),
      runClaudeCode: vi.fn(),
    };

    vi.mocked(sessionManagerModule.SessionManager).mockImplementation(
      () => mockSessionManager as unknown as sessionManagerModule.SessionManager
    );
    vi.mocked(podmanRunnerModule.PodmanRunner).mockImplementation(
      () => mockPodmanRunner as unknown as podmanRunnerModule.PodmanRunner
    );

    mockApi = {
      config: {},
      registerTool: vi.fn(),
    };
  });

  it("registers three tools", () => {
    register(mockApi);

    expect(mockApi.registerTool).toHaveBeenCalledTimes(3);
  });

  it("registers claude_code tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const claudeCodeTool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
    );

    expect(claudeCodeTool).toBeDefined();
    expect(claudeCodeTool?.[0].description).toContain("Claude Code CLI");
  });

  it("registers claude_code_cleanup tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const cleanupTool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cleanup"
    );

    expect(cleanupTool).toBeDefined();
    expect(cleanupTool?.[0].description).toContain("Clean up idle");
  });

  it("registers claude_code_sessions tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const sessionsTool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_sessions"
    );

    expect(sessionsTool).toBeDefined();
    expect(sessionsTool?.[0].description).toContain("List all active");
  });

  describe("claude_code tool execute", () => {
    it("throws error when prompt is missing", async () => {
      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", {})).rejects.toThrow(
        "prompt parameter is required"
      );
    });

    it("throws error when no authentication is available", async () => {
      // Mock no credentials file and no API key
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      const originalEnv = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", { prompt: "hello" })).rejects.toThrow(
        "No authentication available"
      );

      process.env.ANTHROPIC_API_KEY = originalEnv;
    });

    it("throws error when container image is missing", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(false);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", { prompt: "hello" })).rejects.toThrow(
        "Container image not found"
      );
    });

    it("executes successfully with API key auth", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockPodmanRunner.runClaudeCode.mockResolvedValue({
        content: "Hello from Claude",
        sessionId: "claude-123",
      });
      mockSessionManager.updateSession.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", { prompt: "hello" });

      expect(result.content[0].text).toContain("[auth: api_key]");
      expect(result.content[0].text).toContain("Hello from Claude");
    });

    it("executes successfully with credentials file auth", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockPodmanRunner.runClaudeCode.mockResolvedValue({
        content: "Hello from Claude",
        sessionId: "claude-123",
      });
      mockSessionManager.updateSession.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", { prompt: "hello" });

      expect(result.content[0].text).toContain("[auth: oauth]");
    });

    it("includes metrics in response", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockPodmanRunner.runClaudeCode.mockResolvedValue({
        content: "Hello",
        sessionId: "claude-123",
        metrics: {
          memoryUsageMB: 256.5,
          memoryPercent: 50.1,
          cpuPercent: 25.0,
        },
      });
      mockSessionManager.updateSession.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", { prompt: "hello" });

      expect(result.content[0].text).toContain("mem: 256.5MB");
      expect(result.content[0].text).toContain("50.1%");
      expect(result.content[0].text).toContain("cpu: 25.0%");
    });

    it("includes truncation warning", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockPodmanRunner.runClaudeCode.mockResolvedValue({
        content: "Truncated content",
        sessionId: "claude-123",
        outputTruncated: true,
        originalSize: 20 * 1024 * 1024, // 20MB
      });
      mockSessionManager.updateSession.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", { prompt: "hello" });

      expect(result.content[0].text).toContain("WARNING: Output truncated");
      expect(result.content[0].text).toContain("20.00MB");
    });

    it("handles credentials copy failure", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockRejectedValue(new Error("Permission denied"));
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", { prompt: "hello" })).rejects.toThrow(
        "Failed to copy credentials file"
      );
    });
  });

  describe("claude_code_cleanup tool execute", () => {
    it("reports no idle sessions", async () => {
      mockSessionManager.cleanupIdleSessions.mockResolvedValue([]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cleanup"
      )?.[0] as {
        execute: () => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute();

      expect(result.content[0].text).toBe("No idle sessions to clean up.");
    });

    it("reports cleaned up sessions", async () => {
      mockSessionManager.cleanupIdleSessions.mockResolvedValue(["session-1", "session-2"]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cleanup"
      )?.[0] as {
        execute: () => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute();

      expect(result.content[0].text).toContain("Cleaned up 2 idle session(s)");
      expect(result.content[0].text).toContain("session-1, session-2");
    });
  });

  describe("claude_code_sessions tool execute", () => {
    it("reports no active sessions", async () => {
      mockSessionManager.listSessions.mockResolvedValue([]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_sessions"
      )?.[0] as {
        execute: () => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute();

      expect(result.content[0].text).toBe("No active sessions.");
    });

    it("lists active sessions with details", async () => {
      const now = Date.now();
      mockSessionManager.listSessions.mockResolvedValue([
        {
          sessionKey: "test-session",
          createdAt: new Date(now - 3600000).toISOString(), // 1 hour ago
          lastActivity: new Date(now - 60000).toISOString(), // 1 minute ago
          messageCount: 5,
          claudeSessionId: "claude-abc",
        },
      ]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_sessions"
      )?.[0] as {
        execute: () => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute();

      expect(result.content[0].text).toContain("Found 1 session(s)");
      expect(result.content[0].text).toContain("Session: test-session");
      expect(result.content[0].text).toContain("Messages: 5");
      expect(result.content[0].text).toContain("Claude Session: claude-abc");
    });

    it("formats session without claude session ID", async () => {
      const now = Date.now();
      mockSessionManager.listSessions.mockResolvedValue([
        {
          sessionKey: "new-session",
          createdAt: new Date(now - 30000).toISOString(), // 30 seconds ago
          lastActivity: new Date(now - 10000).toISOString(), // 10 seconds ago
          messageCount: 0,
          claudeSessionId: null,
        },
      ]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_sessions"
      )?.[0] as {
        execute: () => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute();

      expect(result.content[0].text).not.toContain("Claude Session:");
    });
  });
});
