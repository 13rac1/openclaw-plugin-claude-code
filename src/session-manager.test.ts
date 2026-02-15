import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionState, SessionManagerConfig } from "./session-manager";
import { SessionManager } from "./session-manager";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises");
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

const mockFs = vi.mocked(fs);

describe("SessionManager", () => {
  const config: SessionManagerConfig = {
    sessionsDir: "/var/openclaw/sessions",
    workspacesDir: "/var/openclaw/workspaces",
    idleTimeout: 3600,
  };

  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
    manager = new SessionManager(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("expands ~ in paths", () => {
      const mgr = new SessionManager({
        sessionsDir: "~/.openclaw/sessions",
        workspacesDir: "~/.openclaw/workspaces",
        idleTimeout: 3600,
      });

      expect(mgr.workspaceDir("test")).toBe("/home/testuser/.openclaw/workspaces/test");
    });

    it("uses absolute paths as-is", () => {
      const mgr = new SessionManager({
        sessionsDir: "/absolute/path/sessions",
        workspacesDir: "/absolute/path/workspaces",
        idleTimeout: 3600,
      });

      expect(mgr.workspaceDir("test")).toBe("/absolute/path/workspaces/test");
    });
  });

  describe("workspaceDir", () => {
    it("returns correct workspace path", () => {
      expect(manager.workspaceDir("my-session")).toBe("/var/openclaw/workspaces/my-session");
    });
  });

  describe("getSession", () => {
    it("returns session when file exists", async () => {
      const sessionData: SessionState = {
        sessionKey: "test-session",
        claudeSessionId: "claude-123",
        createdAt: "2024-01-15T09:00:00.000Z",
        lastActivity: "2024-01-15T09:30:00.000Z",
        messageCount: 5,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(sessionData));

      const result = await manager.getSession("test-session");

      expect(result).toEqual(sessionData);
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test-session/session.json",
        "utf-8"
      );
    });

    it("returns null when file does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await manager.getSession("nonexistent");

      expect(result).toBeNull();
    });

    it("throws on other errors", async () => {
      const error = new Error("Permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.getSession("test")).rejects.toThrow("Permission denied");
    });
  });

  describe("createSession", () => {
    it("creates directories and session file", async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await manager.createSession("new-session");

      expect(mockFs.mkdir).toHaveBeenCalledWith("/var/openclaw/sessions/new-session", {
        recursive: true,
      });
      expect(mockFs.mkdir).toHaveBeenCalledWith("/var/openclaw/sessions/new-session/.claude", {
        recursive: true,
      });
      expect(mockFs.mkdir).toHaveBeenCalledWith("/var/openclaw/workspaces/new-session", {
        recursive: true,
      });

      expect(result).toEqual({
        sessionKey: "new-session",
        claudeSessionId: null,
        createdAt: "2024-01-15T10:00:00.000Z",
        lastActivity: "2024-01-15T10:00:00.000Z",
        messageCount: 0,
        activeJobId: null,
      });

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/new-session/session.json",
        expect.stringContaining('"sessionKey": "new-session"')
      );
    });
  });

  describe("getOrCreateSession", () => {
    it("returns existing session", async () => {
      const existingSession: SessionState = {
        sessionKey: "existing",
        claudeSessionId: "abc",
        createdAt: "2024-01-14T00:00:00.000Z",
        lastActivity: "2024-01-14T12:00:00.000Z",
        messageCount: 10,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingSession));

      const result = await manager.getOrCreateSession("existing");

      expect(result).toEqual(existingSession);
      expect(mockFs.mkdir).not.toHaveBeenCalled();
    });

    it("creates new session when none exists", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await manager.getOrCreateSession("new");

      expect(result.sessionKey).toBe("new");
      expect(result.claudeSessionId).toBeNull();
      expect(mockFs.mkdir).toHaveBeenCalled();
    });
  });

  describe("updateSession", () => {
    it("updates session with new claude session id", async () => {
      const existingSession: SessionState = {
        sessionKey: "test",
        claudeSessionId: null,
        createdAt: "2024-01-15T09:00:00.000Z",
        lastActivity: "2024-01-15T09:00:00.000Z",
        messageCount: 0,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingSession));
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await manager.updateSession("test", "new-claude-id");

      expect(result.claudeSessionId).toBe("new-claude-id");
      expect(result.lastActivity).toBe("2024-01-15T10:00:00.000Z");
      expect(result.messageCount).toBe(1);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test/session.json",
        expect.stringContaining('"claudeSessionId": "new-claude-id"')
      );
    });

    it("increments message count", async () => {
      const existingSession: SessionState = {
        sessionKey: "test",
        claudeSessionId: "existing-id",
        createdAt: "2024-01-15T09:00:00.000Z",
        lastActivity: "2024-01-15T09:00:00.000Z",
        messageCount: 5,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingSession));
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await manager.updateSession("test", "existing-id");

      expect(result.messageCount).toBe(6);
    });

    it("throws when session not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.updateSession("nonexistent", "id")).rejects.toThrow(
        "Session not found: nonexistent"
      );
    });
  });

  describe("deleteSession", () => {
    it("removes session and workspace directories", async () => {
      mockFs.rm.mockResolvedValue(undefined);

      await manager.deleteSession("to-delete");

      expect(mockFs.rm).toHaveBeenCalledWith("/var/openclaw/sessions/to-delete", {
        recursive: true,
        force: true,
      });
      expect(mockFs.rm).toHaveBeenCalledWith("/var/openclaw/workspaces/to-delete", {
        recursive: true,
        force: true,
      });
    });

    it("does not throw on rm errors", async () => {
      mockFs.rm.mockRejectedValue(new Error("directory not found"));

      // Should not throw
      await expect(manager.deleteSession("test")).resolves.toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("returns all valid sessions", async () => {
      mockFs.readdir.mockResolvedValue([
        { name: "session1", isDirectory: () => true },
        { name: "session2", isDirectory: () => true },
        { name: "not-a-dir", isDirectory: () => false },
      ] as any);

      const session1: SessionState = {
        sessionKey: "session1",
        claudeSessionId: "a",
        createdAt: "2024-01-15T00:00:00.000Z",
        lastActivity: "2024-01-15T01:00:00.000Z",
        messageCount: 1,
      };

      const session2: SessionState = {
        sessionKey: "session2",
        claudeSessionId: "b",
        createdAt: "2024-01-15T00:00:00.000Z",
        lastActivity: "2024-01-15T02:00:00.000Z",
        messageCount: 2,
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(session1))
        .mockResolvedValueOnce(JSON.stringify(session2));

      const result = await manager.listSessions();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(session1);
      expect(result).toContainEqual(session2);
    });

    it("returns empty array when sessions dir does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readdir.mockRejectedValue(error);

      const result = await manager.listSessions();

      expect(result).toEqual([]);
    });

    it("throws on other readdir errors", async () => {
      const error = new Error("Permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFs.readdir.mockRejectedValue(error);

      await expect(manager.listSessions()).rejects.toThrow("Permission denied");
    });

    it("skips sessions with invalid JSON", async () => {
      mockFs.readdir.mockResolvedValue([
        { name: "valid", isDirectory: () => true },
        { name: "invalid", isDirectory: () => true },
      ] as any);

      const validSession: SessionState = {
        sessionKey: "valid",
        claudeSessionId: null,
        createdAt: "2024-01-15T00:00:00.000Z",
        lastActivity: "2024-01-15T00:00:00.000Z",
        messageCount: 0,
      };

      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(validSession))
        .mockRejectedValueOnce(error);

      const result = await manager.listSessions();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(validSession);
    });
  });

  describe("cleanupIdleSessions", () => {
    it("deletes sessions older than idle timeout", async () => {
      // Current time: 2024-01-15T10:00:00.000Z
      // Idle timeout: 3600 seconds (1 hour)
      // Cutoff: 2024-01-15T09:00:00.000Z

      mockFs.readdir.mockResolvedValue([
        { name: "old-session", isDirectory: () => true },
        { name: "recent-session", isDirectory: () => true },
      ] as any);

      const oldSession: SessionState = {
        sessionKey: "old-session",
        claudeSessionId: "a",
        createdAt: "2024-01-15T07:00:00.000Z",
        lastActivity: "2024-01-15T08:00:00.000Z", // 2 hours ago, should be deleted
        messageCount: 1,
      };

      const recentSession: SessionState = {
        sessionKey: "recent-session",
        claudeSessionId: "b",
        createdAt: "2024-01-15T09:30:00.000Z",
        lastActivity: "2024-01-15T09:30:00.000Z", // 30 min ago, should be kept
        messageCount: 1,
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(oldSession))
        .mockResolvedValueOnce(JSON.stringify(recentSession));

      mockFs.rm.mockResolvedValue(undefined);

      const deleted = await manager.cleanupIdleSessions();

      expect(deleted).toEqual(["old-session"]);
      expect(mockFs.rm).toHaveBeenCalledWith("/var/openclaw/sessions/old-session", {
        recursive: true,
        force: true,
      });
      expect(mockFs.rm).toHaveBeenCalledWith("/var/openclaw/workspaces/old-session", {
        recursive: true,
        force: true,
      });
      // Should not delete recent session
      expect(mockFs.rm).not.toHaveBeenCalledWith(
        expect.stringContaining("recent-session"),
        expect.anything()
      );
    });

    it("returns empty array when no sessions are idle", async () => {
      mockFs.readdir.mockResolvedValue([{ name: "active", isDirectory: () => true }] as any);

      const activeSession: SessionState = {
        sessionKey: "active",
        claudeSessionId: "a",
        createdAt: "2024-01-15T09:55:00.000Z",
        lastActivity: "2024-01-15T09:55:00.000Z", // 5 min ago
        messageCount: 1,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(activeSession));

      const deleted = await manager.cleanupIdleSessions();

      expect(deleted).toEqual([]);
      expect(mockFs.rm).not.toHaveBeenCalled();
    });
  });

  describe("createJob", () => {
    it("creates job directory and files", async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const job = await manager.createJob("test-session", {
        prompt: "test prompt",
        containerName: "claude-test-session",
      });

      expect(job.jobId).toBeDefined();
      expect(job.sessionKey).toBe("test-session");
      expect(job.containerName).toBe("claude-test-session");
      expect(job.status).toBe("pending");
      expect(job.prompt).toBe("test prompt");
      expect(job.createdAt).toBe("2024-01-15T10:00:00.000Z");

      expect(mockFs.mkdir).toHaveBeenCalledWith("/var/openclaw/sessions/test-session/jobs", {
        recursive: true,
      });
    });
  });

  describe("getJob", () => {
    it("returns job when file exists", async () => {
      const jobData = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: "2024-01-15T10:00:01.000Z",
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/to/output.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(jobData));

      const result = await manager.getJob("test", "job-123");

      expect(result).toEqual(jobData);
      expect(mockFs.readFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test/jobs/job-123.json",
        "utf-8"
      );
    });

    it("returns null when job not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await manager.getJob("test", "nonexistent");

      expect(result).toBeNull();
    });

    it("throws on other errors", async () => {
      const error = new Error("Permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.getJob("test", "job-123")).rejects.toThrow("Permission denied");
    });
  });

  describe("updateJob", () => {
    it("updates job with partial fields", async () => {
      const existingJob = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "pending",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/to/output.log",
        outputSize: 0,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingJob));
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await manager.updateJob("test", "job-123", {
        status: "running",
        startedAt: "2024-01-15T10:00:05.000Z",
      });

      expect(result.status).toBe("running");
      expect(result.startedAt).toBe("2024-01-15T10:00:05.000Z");
      expect(result.prompt).toBe("test"); // Unchanged
    });

    it("throws when job not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.updateJob("test", "nonexistent", { status: "running" })).rejects.toThrow(
        "Job not found: nonexistent"
      );
    });
  });

  describe("getActiveJob", () => {
    it("returns active job when session has one", async () => {
      const session: SessionState = {
        sessionKey: "test",
        claudeSessionId: null,
        createdAt: "2024-01-15T10:00:00.000Z",
        lastActivity: "2024-01-15T10:00:00.000Z",
        messageCount: 0,
        activeJobId: "job-123",
      };

      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: "2024-01-15T10:00:01.000Z",
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/to/output.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(session))
        .mockResolvedValueOnce(JSON.stringify(job));

      const result = await manager.getActiveJob("test");

      expect(result).toEqual(job);
    });

    it("returns null when no active job", async () => {
      const session: SessionState = {
        sessionKey: "test",
        claudeSessionId: null,
        createdAt: "2024-01-15T10:00:00.000Z",
        lastActivity: "2024-01-15T10:00:00.000Z",
        messageCount: 0,
        activeJobId: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(session));

      const result = await manager.getActiveJob("test");

      expect(result).toBeNull();
    });

    it("returns null when session not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await manager.getActiveJob("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("setActiveJob", () => {
    it("sets active job ID on session", async () => {
      const session: SessionState = {
        sessionKey: "test",
        claudeSessionId: null,
        createdAt: "2024-01-15T10:00:00.000Z",
        lastActivity: "2024-01-15T09:00:00.000Z",
        messageCount: 0,
        activeJobId: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(session));
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.setActiveJob("test", "job-456");

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test/session.json",
        expect.stringContaining('"activeJobId": "job-456"')
      );
    });

    it("clears active job when null", async () => {
      const session: SessionState = {
        sessionKey: "test",
        claudeSessionId: null,
        createdAt: "2024-01-15T10:00:00.000Z",
        lastActivity: "2024-01-15T09:00:00.000Z",
        messageCount: 0,
        activeJobId: "old-job",
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(session));
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.setActiveJob("test", null);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test/session.json",
        expect.stringContaining('"activeJobId": null')
      );
    });

    it("throws when session not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.setActiveJob("nonexistent", "job-123")).rejects.toThrow(
        "Session not found: nonexistent"
      );
    });
  });

  describe("listJobs", () => {
    it("returns all jobs for session", async () => {
      mockFs.readdir.mockResolvedValue(["job-1.json", "job-2.json", "job-3.log"] as any);

      const job1 = {
        jobId: "job-1",
        sessionKey: "test",
        containerName: "claude-test",
        status: "completed",
        prompt: "test 1",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: 0,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/job-1.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      const job2 = {
        jobId: "job-2",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test 2",
        createdAt: "2024-01-15T10:01:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/job-2.log",
        outputSize: 50,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(job1))
        .mockResolvedValueOnce(JSON.stringify(job2));

      const result = await manager.listJobs("test");

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(job1);
      expect(result).toContainEqual(job2);
    });

    it("returns empty array when jobs dir does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readdir.mockRejectedValue(error);

      const result = await manager.listJobs("test");

      expect(result).toEqual([]);
    });

    it("skips jobs that fail to read", async () => {
      mockFs.readdir.mockResolvedValue(["job-1.json", "job-2.json"] as any);

      const job1 = {
        jobId: "job-1",
        sessionKey: "test",
        containerName: "claude-test",
        status: "completed",
        prompt: "test 1",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: 0,
        errorType: null,
        errorMessage: null,
        outputFile: "/path/job-1.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(job1)).mockRejectedValueOnce(error);

      const result = await manager.listJobs("test");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(job1);
    });
  });

  describe("readJobOutput", () => {
    it("reads output with default options", async () => {
      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/var/openclaw/sessions/test/jobs/job-123.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      const mockHandle = {
        read: vi.fn().mockResolvedValue({ bytesRead: 26 }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(job));
      mockFs.stat.mockResolvedValue({ size: 26 } as any);
      mockFs.open.mockResolvedValue(mockHandle as any);

      const result = await manager.readJobOutput("test", "job-123");

      expect(result.size).toBe(26);
      expect(result.totalSize).toBe(26);
      expect(result.hasMore).toBe(false);
      expect(mockHandle.close).toHaveBeenCalled();
    });

    it("supports offset and limit", async () => {
      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/var/openclaw/sessions/test/jobs/job-123.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      const mockHandle = {
        read: vi.fn().mockResolvedValue({ bytesRead: 10 }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(job));
      mockFs.stat.mockResolvedValue({ size: 100 } as any);
      mockFs.open.mockResolvedValue(mockHandle as any);

      const result = await manager.readJobOutput("test", "job-123", {
        offset: 50,
        limit: 10,
      });

      expect(result.size).toBe(10);
      expect(result.totalSize).toBe(100);
      expect(result.hasMore).toBe(true);
      expect(mockHandle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 10, 50);
    });

    it("returns empty result when offset exceeds file size", async () => {
      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/var/openclaw/sessions/test/jobs/job-123.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(job));
      mockFs.stat.mockResolvedValue({ size: 50 } as any);

      const result = await manager.readJobOutput("test", "job-123", { offset: 100 });

      expect(result.content).toBe("");
      expect(result.size).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it("throws when job not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.readJobOutput("test", "nonexistent")).rejects.toThrow(
        "Job not found: nonexistent"
      );
    });

    it("returns empty result when output file does not exist", async () => {
      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "pending",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/var/openclaw/sessions/test/jobs/job-123.log",
        outputSize: 0,
        outputTruncated: false,
        metrics: null,
      };

      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";

      mockFs.readFile.mockResolvedValue(JSON.stringify(job));
      mockFs.stat.mockRejectedValue(error);

      const result = await manager.readJobOutput("test", "job-123");

      expect(result.content).toBe("");
      expect(result.size).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("appendJobOutput", () => {
    it("appends content and updates job size", async () => {
      const job = {
        jobId: "job-123",
        sessionKey: "test",
        containerName: "claude-test",
        status: "running",
        prompt: "test",
        createdAt: "2024-01-15T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        errorType: null,
        errorMessage: null,
        outputFile: "/var/openclaw/sessions/test/jobs/job-123.log",
        outputSize: 100,
        outputTruncated: false,
        metrics: null,
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(job));
      mockFs.appendFile.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 150 } as any);
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.appendJobOutput("test", "job-123", "new content");

      expect(mockFs.appendFile).toHaveBeenCalledWith(
        "/var/openclaw/sessions/test/jobs/job-123.log",
        "new content"
      );
    });

    it("throws when job not found", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      await expect(manager.appendJobOutput("test", "nonexistent", "content")).rejects.toThrow(
        "Job not found: nonexistent"
      );
    });
  });
});
