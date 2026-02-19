import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import register from "./claude-code.js";
import * as sessionManagerModule from "./session-manager.js";
import * as podmanRunnerModule from "./podman-runner.js";
import * as fs from "node:fs/promises";

// Mock dependencies
vi.mock("./session-manager.js");
vi.mock("./podman-runner.js");
vi.mock("node:fs/promises");

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
    getActiveJob: Mock;
    createJob: Mock;
    updateJob: Mock;
    setActiveJob: Mock;
    getJob: Mock;
    readJobOutput: Mock;
    readJobOutputTail: Mock;
    appendJobOutput: Mock;
  };
  let mockPodmanRunner: {
    checkImage: Mock;
    startDetached: Mock;
    containerNameFromSessionKey: Mock;
    getContainerStatus: Mock;
    getContainerLogs: Mock;
    getContainerStats: Mock;
    killContainer: Mock;
    listContainersByPrefix: Mock;
    sessionKeyFromContainerName: Mock;
    waitForContainer: Mock;
    streamContainerLogs: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionManager = {
      getOrCreateSession: vi.fn(),
      updateSession: vi.fn(),
      cleanupIdleSessions: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      workspaceDir: vi.fn(),
      getActiveJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn(),
      updateJob: vi.fn(),
      setActiveJob: vi.fn(),
      getJob: vi.fn(),
      readJobOutput: vi.fn(),
      readJobOutputTail: vi.fn(),
      appendJobOutput: vi.fn(),
    };

    mockPodmanRunner = {
      checkImage: vi.fn(),
      startDetached: vi.fn(),
      containerNameFromSessionKey: vi.fn((key: string) => `claude-${key}`),
      getContainerStatus: vi.fn(),
      getContainerLogs: vi.fn(),
      getContainerStats: vi.fn(),
      killContainer: vi.fn(),
      listContainersByPrefix: vi.fn().mockResolvedValue([]),
      sessionKeyFromContainerName: vi.fn(),
      waitForContainer: vi.fn().mockResolvedValue(0),
      streamContainerLogs: vi.fn().mockResolvedValue(0), // Returns exit code 0 after streaming
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

  it("registers six tools", () => {
    register(mockApi);

    expect(mockApi.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers claude_code_start tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const tool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
    );

    expect(tool).toBeDefined();
    expect(tool?.[0].description).toContain("background");
  });

  it("registers claude_code_status tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const tool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_status"
    );

    expect(tool).toBeDefined();
    expect(tool?.[0].description).toContain("status");
  });

  it("registers claude_code_output tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const tool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_output"
    );

    expect(tool).toBeDefined();
    expect(tool?.[0].description).toContain("output");
  });

  it("registers claude_code_cancel tool", () => {
    register(mockApi);

    const calls = mockApi.registerTool.mock.calls;
    const tool = calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cancel"
    );

    expect(tool).toBeDefined();
    expect(tool?.[0].description).toContain("Cancel");
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

  describe("claude_code_start tool execute", () => {
    it("throws error when prompt is missing", async () => {
      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", {})).rejects.toThrow(
        "prompt parameter is required"
      );
    });

    it("throws error when no authentication is available", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      const originalEnv = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
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
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", { prompt: "hello" })).rejects.toThrow(
        "Container image not found"
      );
    });

    it("throws error when session has active job", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "test-session",
        claudeSessionId: null,
      });
      mockSessionManager.getActiveJob.mockResolvedValue({
        jobId: "existing-job",
        status: "running",
      });

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", { prompt: "hello" })).rejects.toThrow(
        "already has an active job"
      );
    });

    it("starts job successfully with API key auth", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      process.env.ANTHROPIC_API_KEY = "test-key";
      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "session-test-id",
        claudeSessionId: null,
      });
      mockSessionManager.getActiveJob.mockResolvedValue(null);
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockSessionManager.createJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "session-test-id",
        status: "pending",
      });
      mockPodmanRunner.startDetached.mockResolvedValue({
        containerName: "claude-session-test-id",
        containerId: "abc123",
      });
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", { prompt: "hello" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.jobId).toBe("job-123");
      expect(parsed.status).toBe("running");
      expect(mockPodmanRunner.startDetached).toHaveBeenCalled();
    });

    it("copies OAuth credentials to session directory when credentials file exists", async () => {
      // Mock credentials file exists
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);
      delete process.env.ANTHROPIC_API_KEY;

      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "oauth-test",
        claudeSessionId: null,
      });
      mockSessionManager.getActiveJob.mockResolvedValue(null);
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockSessionManager.createJob.mockResolvedValue({
        jobId: "oauth-job",
        sessionKey: "oauth-test",
        status: "pending",
      });
      mockPodmanRunner.startDetached.mockResolvedValue({
        containerName: "claude-oauth-test",
        containerId: "def456",
      });
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      await toolConfig.execute("test-id", { prompt: "hello" });

      // Verify credentials were copied to session directory
      expect(fs.copyFile).toHaveBeenCalledWith(
        expect.stringContaining(".claude/.credentials.json"),
        expect.stringContaining("session-test-id/.claude/.credentials.json")
      );
      // Verify apiKey was NOT passed (since we're using OAuth)
      expect(mockPodmanRunner.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: undefined,
        })
      );
    });

    it("copies OAuth credentials on both first and resumed session jobs", async () => {
      // Mock credentials file exists
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.copyFile).mockResolvedValue(undefined);
      delete process.env.ANTHROPIC_API_KEY;

      mockPodmanRunner.checkImage.mockResolvedValue(true);
      mockSessionManager.workspaceDir.mockReturnValue("/tmp/workspace");
      mockPodmanRunner.startDetached.mockResolvedValue({
        containerName: "claude-resume-test",
        containerId: "ghi789",
      });
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue({});

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_start"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      // First job - new session
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "resume-test",
        claudeSessionId: null,
      });
      mockSessionManager.getActiveJob.mockResolvedValue(null);
      mockSessionManager.createJob.mockResolvedValue({
        jobId: "job-1",
        sessionKey: "resume-test",
        status: "pending",
      });

      await toolConfig.execute("first-job", { prompt: "first task", session_id: "resume-test" });

      // Verify credentials were copied
      expect(fs.copyFile).toHaveBeenCalledWith(
        expect.stringContaining(".claude/.credentials.json"),
        expect.stringContaining("resume-test/.claude/.credentials.json")
      );

      // Clear for second job
      vi.mocked(fs.copyFile).mockClear();
      vi.mocked(mockPodmanRunner.startDetached).mockClear();

      // Second job - resumed session (now has claudeSessionId)
      mockSessionManager.getOrCreateSession.mockResolvedValue({
        sessionKey: "resume-test",
        claudeSessionId: "claude-session-abc123", // Has session from first job
      });
      mockSessionManager.getActiveJob.mockResolvedValue(null); // Previous job completed
      mockSessionManager.createJob.mockResolvedValue({
        jobId: "job-2",
        sessionKey: "resume-test",
        status: "pending",
      });

      await toolConfig.execute("second-job", { prompt: "second task", session_id: "resume-test" });

      // Verify credentials are STILL copied on resumed session
      expect(fs.copyFile).toHaveBeenCalledWith(
        expect.stringContaining(".claude/.credentials.json"),
        expect.stringContaining("resume-test/.claude/.credentials.json")
      );
      expect(mockPodmanRunner.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "claude-session-abc123", // Should have session ID this time
        })
      );
    });
  });

  describe("claude_code_status tool execute", () => {
    it("throws error when job_id is missing", async () => {
      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_status"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", {})).rejects.toThrow(
        "job_id parameter is required"
      );
    });

    it("throws error when job not found", async () => {
      mockSessionManager.getJob.mockResolvedValue(null);
      mockSessionManager.listSessions.mockResolvedValue([]);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_status"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(
        toolConfig.execute("test-id", { job_id: "nonexistent", session_id: "test" })
      ).rejects.toThrow("Job not found");
    });

    it("returns status for completed job", async () => {
      mockSessionManager.getJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "test-session",
        status: "completed",
        containerName: "claude-test-session",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 0,
        errorMessage: null,
        metrics: { memoryUsageMB: 256, cpuPercent: 10 },
      });
      mockSessionManager.readJobOutputTail.mockResolvedValue({
        tail: "job output here",
        lastModifiedSecondsAgo: 5,
        totalSize: 1024,
      });

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_status"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", {
        job_id: "job-123",
        session_id: "test-session",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.status).toBe("completed");
      expect(parsed.exitCode).toBe(0);
      expect(parsed.outputSize).toBe(1024);
    });
  });

  describe("claude_code_output tool execute", () => {
    it("throws error when job_id is missing", async () => {
      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_output"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", {})).rejects.toThrow(
        "job_id parameter is required"
      );
    });

    it("returns output with header", async () => {
      mockSessionManager.getJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "test-session",
        status: "completed",
        containerName: "claude-test-session",
      });
      mockSessionManager.readJobOutput.mockResolvedValue({
        content: "Hello from Claude",
        size: 17,
        totalSize: 17,
        hasMore: false,
      });

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_output"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", {
        job_id: "job-123",
        session_id: "test-session",
      });

      expect(result.content[0].text).toContain("[job: job-123]");
      expect(result.content[0].text).toContain("[status: completed]");
      expect(result.content[0].text).toContain("Hello from Claude");
    });
  });

  describe("claude_code_cancel tool execute", () => {
    it("throws error when job_id is missing", async () => {
      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cancel"
      )?.[0] as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

      await expect(toolConfig.execute("test-id", {})).rejects.toThrow(
        "job_id parameter is required"
      );
    });

    it("cancels running job", async () => {
      mockSessionManager.getJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "test-session",
        status: "running",
        containerName: "claude-test-session",
      });
      mockPodmanRunner.killContainer.mockResolvedValue(undefined);
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue(undefined);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cancel"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", {
        job_id: "job-123",
        session_id: "test-session",
      });

      expect(result.content[0].text).toContain("cancelled");
      expect(mockPodmanRunner.killContainer).toHaveBeenCalled();
    });

    it("returns message when job already completed", async () => {
      mockSessionManager.getJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "test-session",
        status: "completed",
        containerName: "claude-test-session",
      });

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cancel"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      const result = await toolConfig.execute("test-id", {
        job_id: "job-123",
        session_id: "test-session",
      });

      expect(result.content[0].text).toContain("already completed");
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
          createdAt: new Date(now - 3600000).toISOString(),
          lastActivity: new Date(now - 60000).toISOString(),
          messageCount: 5,
          claudeSessionId: "claude-abc",
          activeJobId: null,
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
  });

  describe("orphan recovery on startup", () => {
    it("recovers finished container and updates job status", async () => {
      // Setup: container finished while plugin was down
      mockPodmanRunner.listContainersByPrefix.mockResolvedValue([
        { name: "claude-test-session", running: false, createdAt: "2024-01-15T10:00:00.000Z" },
      ]);
      mockPodmanRunner.sessionKeyFromContainerName.mockReturnValue("test-session");
      mockSessionManager.getActiveJob.mockResolvedValue({
        jobId: "job-123",
        sessionKey: "test-session",
        status: "running",
        containerName: "claude-test-session",
      });
      mockPodmanRunner.getContainerStatus.mockResolvedValue({
        running: false,
        exitCode: 0,
        startedAt: "2024-01-15T10:00:00.000Z",
        finishedAt: "2024-01-15T10:05:00.000Z",
      });
      // Return valid stream-json format that will be parsed
      const jsonLogs = [
        '{"event":{"type":"content_block_delta","delta":{"text":"Job "}}}',
        '{"event":{"type":"content_block_delta","delta":{"text":"output "}}}',
        '{"event":{"type":"content_block_delta","delta":{"text":"logs"}}}',
      ].join("\n");
      mockPodmanRunner.getContainerLogs.mockResolvedValue(jsonLogs);
      mockSessionManager.appendJobOutput.mockResolvedValue(undefined);
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue(undefined);
      mockPodmanRunner.killContainer.mockResolvedValue(undefined);

      // Trigger registration which calls recoverOrphanedJobs
      register(mockApi);

      // Allow async recovery to complete
      await new Promise((r) => setImmediate(r));

      // Extracted text from JSON stream
      expect(mockSessionManager.appendJobOutput).toHaveBeenCalledWith(
        "test-session",
        "job-123",
        "Job output logs"
      );
      expect(mockSessionManager.updateJob).toHaveBeenCalledWith("test-session", "job-123", {
        status: "completed",
        completedAt: "2024-01-15T10:05:00.000Z",
        exitCode: 0,
        errorType: null,
      });
      expect(mockSessionManager.setActiveJob).toHaveBeenCalledWith("test-session", null);
    });

    it("kills orphaned container with no matching job", async () => {
      mockPodmanRunner.listContainersByPrefix.mockResolvedValue([
        { name: "claude-orphan-session", running: true, createdAt: "2024-01-15T10:00:00.000Z" },
      ]);
      mockPodmanRunner.sessionKeyFromContainerName.mockReturnValue("orphan-session");
      mockSessionManager.getActiveJob.mockResolvedValue(null);
      mockPodmanRunner.killContainer.mockResolvedValue(undefined);

      register(mockApi);
      await new Promise((r) => setImmediate(r));

      expect(mockPodmanRunner.killContainer).toHaveBeenCalledWith("orphan-session");
    });

    it("handles recovery errors gracefully", async () => {
      mockPodmanRunner.listContainersByPrefix.mockRejectedValue(new Error("Podman error"));

      // Should not throw
      register(mockApi);
      await new Promise((r) => setImmediate(r));

      // Recovery failed silently, but tools are still registered
      expect(mockApi.registerTool).toHaveBeenCalled();
    });

    it("skips container with null session key", async () => {
      mockPodmanRunner.listContainersByPrefix.mockResolvedValue([
        { name: "invalid-container", running: true, createdAt: "2024-01-15T10:00:00.000Z" },
      ]);
      mockPodmanRunner.sessionKeyFromContainerName.mockReturnValue(null);

      register(mockApi);
      await new Promise((r) => setImmediate(r));

      // Should not try to get active job or kill container
      expect(mockSessionManager.getActiveJob).not.toHaveBeenCalled();
      expect(mockPodmanRunner.killContainer).not.toHaveBeenCalled();
    });

    it("leaves running container alone when job matches", async () => {
      mockPodmanRunner.listContainersByPrefix.mockResolvedValue([
        { name: "claude-running-session", running: true, createdAt: "2024-01-15T10:00:00.000Z" },
      ]);
      mockPodmanRunner.sessionKeyFromContainerName.mockReturnValue("running-session");
      mockSessionManager.getActiveJob.mockResolvedValue({
        jobId: "job-456",
        sessionKey: "running-session",
        status: "running",
        containerName: "claude-running-session",
      });

      register(mockApi);
      await new Promise((r) => setImmediate(r));

      // Should not update job or kill container - it's still running
      expect(mockSessionManager.updateJob).not.toHaveBeenCalled();
      expect(mockPodmanRunner.killContainer).not.toHaveBeenCalled();
    });

    it("handles OOM exit code", async () => {
      mockPodmanRunner.listContainersByPrefix.mockResolvedValue([
        { name: "claude-oom-session", running: false, createdAt: "2024-01-15T10:00:00.000Z" },
      ]);
      mockPodmanRunner.sessionKeyFromContainerName.mockReturnValue("oom-session");
      mockSessionManager.getActiveJob.mockResolvedValue({
        jobId: "job-oom",
        sessionKey: "oom-session",
        status: "running",
        containerName: "claude-oom-session",
      });
      mockPodmanRunner.getContainerStatus.mockResolvedValue({
        running: false,
        exitCode: 137,
        startedAt: "2024-01-15T10:00:00.000Z",
        finishedAt: "2024-01-15T10:02:00.000Z",
      });
      mockPodmanRunner.getContainerLogs.mockResolvedValue(null);
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue(undefined);
      mockPodmanRunner.killContainer.mockResolvedValue(undefined);

      register(mockApi);
      await new Promise((r) => setImmediate(r));

      expect(mockSessionManager.updateJob).toHaveBeenCalledWith("oom-session", "job-oom", {
        status: "failed",
        completedAt: "2024-01-15T10:02:00.000Z",
        exitCode: 137,
        errorType: "oom",
      });
    });
  });

  describe("claude_code_cancel finds job across sessions", () => {
    it("searches all sessions when session_id not provided", async () => {
      // listSessions returns sessions to search
      mockSessionManager.listSessions.mockResolvedValue([
        { sessionKey: "session-1" },
        { sessionKey: "session-2" },
      ]);
      // When no session_id provided, job starts as null, then searches sessions
      // getJob returns null for session-1, then the job for session-2
      mockSessionManager.getJob
        .mockResolvedValueOnce(null) // session-1
        .mockResolvedValueOnce({
          // session-2
          jobId: "job-found",
          sessionKey: "session-2",
          status: "running",
          containerName: "claude-session-2",
        });
      mockPodmanRunner.killContainer.mockResolvedValue(undefined);
      mockSessionManager.updateJob.mockResolvedValue({});
      mockSessionManager.setActiveJob.mockResolvedValue(undefined);

      register(mockApi);

      const toolConfig = mockApi.registerTool.mock.calls.find(
        (call: unknown[]) => (call[0] as { name: string }).name === "claude_code_cancel"
      )?.[0] as {
        execute: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<{ content: { type: string; text: string }[] }>;
      };

      // Note: NOT passing session_id to trigger search across sessions
      const result = await toolConfig.execute("test-id", { job_id: "job-found" });

      expect(result.content[0].text).toContain("cancelled");
      expect(mockPodmanRunner.killContainer).toHaveBeenCalledWith("session-2");
    });
  });
});
