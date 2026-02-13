import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager, SessionState, SessionManagerConfig } from "./session-manager";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
      mockFs.readdir.mockResolvedValue([
        { name: "active", isDirectory: () => true },
      ] as any);

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
});
