import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export interface SessionState {
  sessionKey: string;
  claudeSessionId: string | null;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

export interface SessionManagerConfig {
  sessionsDir: string;
  workspacesDir: string;
  idleTimeout: number;
}

export class SessionManager {
  private config: SessionManagerConfig;

  constructor(config: SessionManagerConfig) {
    this.config = {
      ...config,
      sessionsDir: this.expandPath(config.sessionsDir),
      workspacesDir: this.expandPath(config.workspacesDir),
    };
  }

  private expandPath(p: string): string {
    if (p.startsWith("~")) {
      return path.join(homedir(), p.slice(1));
    }
    return p;
  }

  private sessionDir(sessionKey: string): string {
    return path.join(this.config.sessionsDir, sessionKey);
  }

  private sessionFile(sessionKey: string): string {
    return path.join(this.sessionDir(sessionKey), "session.json");
  }

  private claudeDir(sessionKey: string): string {
    return path.join(this.sessionDir(sessionKey), ".claude");
  }

  workspaceDir(sessionKey: string): string {
    return path.join(this.config.workspacesDir, sessionKey);
  }

  async getSession(sessionKey: string): Promise<SessionState | null> {
    const sessionPath = this.sessionFile(sessionKey);
    try {
      const data = await fs.readFile(sessionPath, "utf-8");
      return JSON.parse(data) as SessionState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async createSession(sessionKey: string): Promise<SessionState> {
    const sessionPath = this.sessionDir(sessionKey);
    const claudePath = this.claudeDir(sessionKey);
    const workspacePath = this.workspaceDir(sessionKey);

    await fs.mkdir(sessionPath, { recursive: true });
    await fs.mkdir(claudePath, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });

    const now = new Date().toISOString();
    const session: SessionState = {
      sessionKey,
      claudeSessionId: null,
      createdAt: now,
      lastActivity: now,
      messageCount: 0,
    };

    await fs.writeFile(this.sessionFile(sessionKey), JSON.stringify(session, null, 2));
    return session;
  }

  async getOrCreateSession(sessionKey: string): Promise<SessionState> {
    const existing = await this.getSession(sessionKey);
    if (existing) {
      return existing;
    }
    return this.createSession(sessionKey);
  }

  async updateSession(sessionKey: string, claudeSessionId: string | null): Promise<SessionState> {
    const session = await this.getSession(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    session.claudeSessionId = claudeSessionId;
    session.lastActivity = new Date().toISOString();
    session.messageCount += 1;

    await fs.writeFile(this.sessionFile(sessionKey), JSON.stringify(session, null, 2));
    return session;
  }

  async deleteSession(sessionKey: string): Promise<void> {
    const sessionPath = this.sessionDir(sessionKey);
    const workspacePath = this.workspaceDir(sessionKey);

    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  }

  async listSessions(): Promise<SessionState[]> {
    const sessions: SessionState[] = [];

    try {
      const entries = await fs.readdir(this.config.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const session = await this.getSession(entry.name);
        if (session) {
          sessions.push(session);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return sessions;
  }

  async cleanupIdleSessions(): Promise<string[]> {
    const sessions = await this.listSessions();
    const cutoff = Date.now() - this.config.idleTimeout * 1000;
    const deleted: string[] = [];

    for (const session of sessions) {
      const lastActivity = new Date(session.lastActivity).getTime();
      if (lastActivity < cutoff) {
        await this.deleteSession(session.sessionKey);
        deleted.push(session.sessionKey);
      }
    }

    return deleted;
  }
}
