import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "./session-manager";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for SessionManager.
 * These tests use real filesystem operations in a temp directory.
 */

describe("SessionManager (integration)", () => {
  let testDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = path.join(
      tmpdir(),
      `session-manager-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });

    manager = new SessionManager({
      sessionsDir: path.join(testDir, "sessions"),
      workspacesDir: path.join(testDir, "workspaces"),
      idleTimeout: 1, // 1 second for faster tests
    });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("session lifecycle", () => {
    it("creates session with correct directory structure", async () => {
      const session = await manager.createSession("test-session-1");

      expect(session.sessionKey).toBe("test-session-1");
      expect(session.claudeSessionId).toBeNull();
      expect(session.messageCount).toBe(0);

      // Verify directories were created
      const sessionDir = path.join(testDir, "sessions", "test-session-1");
      const claudeDir = path.join(sessionDir, ".claude");
      const workspaceDir = path.join(testDir, "workspaces", "test-session-1");

      const sessionStat = await fs.stat(sessionDir);
      const claudeStat = await fs.stat(claudeDir);
      const workspaceStat = await fs.stat(workspaceDir);

      expect(sessionStat.isDirectory()).toBe(true);
      expect(claudeStat.isDirectory()).toBe(true);
      expect(workspaceStat.isDirectory()).toBe(true);

      // Verify session.json was created
      const sessionFile = path.join(sessionDir, "session.json");
      const content = await fs.readFile(sessionFile, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.sessionKey).toBe("test-session-1");
    });

    it("retrieves existing session", async () => {
      await manager.createSession("existing-session");

      const retrieved = await manager.getSession("existing-session");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionKey).toBe("existing-session");
    });

    it("returns null for non-existent session", async () => {
      const retrieved = await manager.getSession("does-not-exist");

      expect(retrieved).toBeNull();
    });

    it("getOrCreateSession returns existing session", async () => {
      const created = await manager.createSession("get-or-create");
      const retrieved = await manager.getOrCreateSession("get-or-create");

      expect(retrieved.sessionKey).toBe(created.sessionKey);
      expect(retrieved.createdAt).toBe(created.createdAt);
    });

    it("getOrCreateSession creates new session if not exists", async () => {
      const session = await manager.getOrCreateSession("new-session");

      expect(session.sessionKey).toBe("new-session");

      // Verify it was actually created
      const retrieved = await manager.getSession("new-session");
      expect(retrieved).not.toBeNull();
    });
  });

  describe("session updates", () => {
    it("updates claude session ID", async () => {
      await manager.createSession("update-test");

      const updated = await manager.updateSession("update-test", "claude-abc123");

      expect(updated.claudeSessionId).toBe("claude-abc123");
      expect(updated.messageCount).toBe(1);

      // Verify persisted
      const retrieved = await manager.getSession("update-test");
      expect(retrieved?.claudeSessionId).toBe("claude-abc123");
    });

    it("increments message count on each update", async () => {
      await manager.createSession("count-test");

      await manager.updateSession("count-test", "id1");
      await manager.updateSession("count-test", "id2");
      const final = await manager.updateSession("count-test", "id3");

      expect(final.messageCount).toBe(3);
    });

    it("updates lastActivity timestamp", async () => {
      const created = await manager.createSession("activity-test");
      const originalActivity = created.lastActivity;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await manager.updateSession("activity-test", "new-id");

      expect(updated.lastActivity).not.toBe(originalActivity);
      expect(new Date(updated.lastActivity).getTime()).toBeGreaterThan(
        new Date(originalActivity).getTime()
      );
    });

    it("throws when updating non-existent session", async () => {
      await expect(manager.updateSession("ghost-session", "id")).rejects.toThrow(
        "Session not found: ghost-session"
      );
    });
  });

  describe("session deletion", () => {
    it("deletes session and workspace directories", async () => {
      await manager.createSession("to-delete");

      const sessionDir = path.join(testDir, "sessions", "to-delete");
      const workspaceDir = path.join(testDir, "workspaces", "to-delete");

      // Verify they exist
      await fs.stat(sessionDir);
      await fs.stat(workspaceDir);

      await manager.deleteSession("to-delete");

      // Verify they're gone
      await expect(fs.stat(sessionDir)).rejects.toThrow();
      await expect(fs.stat(workspaceDir)).rejects.toThrow();
    });

    it("does not throw for non-existent session", async () => {
      await expect(manager.deleteSession("never-existed")).resolves.toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("lists all sessions", async () => {
      await manager.createSession("session-a");
      await manager.createSession("session-b");
      await manager.createSession("session-c");

      const sessions = await manager.listSessions();

      expect(sessions).toHaveLength(3);
      const keys = sessions.map((s) => s.sessionKey).sort();
      expect(keys).toEqual(["session-a", "session-b", "session-c"]);
    });

    it("returns empty array when no sessions", async () => {
      const sessions = await manager.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe("cleanupIdleSessions", () => {
    it("deletes sessions older than idle timeout", async () => {
      // Create a session
      await manager.createSession("old-session");

      // Wait for idle timeout (1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const deleted = await manager.cleanupIdleSessions();

      expect(deleted).toContain("old-session");

      // Verify session is gone
      const remaining = await manager.listSessions();
      expect(remaining).toHaveLength(0);
    });

    it("keeps active sessions", async () => {
      await manager.createSession("active-session");

      // Update immediately to refresh lastActivity
      await manager.updateSession("active-session", "id");

      // Run cleanup immediately (session should still be active)
      const deleted = await manager.cleanupIdleSessions();

      expect(deleted).not.toContain("active-session");

      // Verify session still exists
      const session = await manager.getSession("active-session");
      expect(session).not.toBeNull();
    });
  });

  describe("workspaceDir", () => {
    it("returns correct workspace path", () => {
      const workspace = manager.workspaceDir("my-session");

      expect(workspace).toBe(path.join(testDir, "workspaces", "my-session"));
    });
  });

  describe("path expansion", () => {
    it("expands ~ to home directory", () => {
      const homeManager = new SessionManager({
        sessionsDir: "~/.test-sessions",
        workspacesDir: "~/.test-workspaces",
        idleTimeout: 3600,
      });

      const workspace = homeManager.workspaceDir("test");
      expect(workspace).toContain(process.env.HOME ?? "/home");
      expect(workspace).not.toContain("~");
    });
  });
});
