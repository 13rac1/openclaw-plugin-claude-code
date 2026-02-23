import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ErrorType, ResourceMetrics } from "./podman-runner.js";

export interface SessionState {
  sessionKey: string;
  claudeSessionId: string | null;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  activeJobId: string | null;
}

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface JobState {
  jobId: string;
  sessionKey: string;
  containerName: string;
  status: JobStatus;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  errorType: ErrorType | null;
  errorMessage: string | null;
  outputFile: string;
  outputSize: number;
  outputTruncated: boolean;
  metrics: ResourceMetrics | null;
  lastOutputAt: string | null; // ISO timestamp of last output received
}

export interface JobOutputResult {
  content: string;
  size: number;
  totalSize: number;
  hasMore: boolean;
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

  private jobsDir(sessionKey: string): string {
    return path.join(this.sessionDir(sessionKey), "jobs");
  }

  private jobFile(sessionKey: string, jobId: string): string {
    return path.join(this.jobsDir(sessionKey), `${jobId}.json`);
  }

  private jobOutputFile(sessionKey: string, jobId: string): string {
    return path.join(this.jobsDir(sessionKey), `${jobId}.log`);
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
      activeJobId: null,
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

    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.log(`[session-manager] Failed to delete session directory ${sessionKey}:`, err);
    }
  }

  async deleteWorkspace(sessionKey: string): Promise<void> {
    const workspacePath = this.workspaceDir(sessionKey);

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (err) {
      console.log(`[session-manager] Failed to delete workspace directory ${sessionKey}:`, err);
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

  // ============ Job Management ============

  /**
   * Create a new job for a session.
   */
  async createJob(
    sessionKey: string,
    params: { prompt: string; containerName: string }
  ): Promise<JobState> {
    const jobId = randomUUID();
    const jobDir = this.jobsDir(sessionKey);
    await fs.mkdir(jobDir, { recursive: true });

    const outputFile = this.jobOutputFile(sessionKey, jobId);

    const job: JobState = {
      jobId,
      sessionKey,
      containerName: params.containerName,
      status: "pending",
      prompt: params.prompt,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      errorType: null,
      errorMessage: null,
      outputFile,
      outputSize: 0,
      outputTruncated: false,
      metrics: null,
      lastOutputAt: null,
    };

    await fs.writeFile(this.jobFile(sessionKey, jobId), JSON.stringify(job, null, 2));

    // Create empty output file
    await fs.writeFile(outputFile, "");

    return job;
  }

  /**
   * Get a job by ID.
   * Retries on JSON parse errors to handle concurrent write race conditions.
   */
  async getJob(sessionKey: string, jobId: string, retries = 3): Promise<JobState | null> {
    const jobPath = this.jobFile(sessionKey, jobId);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const data = await fs.readFile(jobPath, "utf-8");
        if (!data.trim()) {
          // Empty file - likely being written, retry
          if (attempt < retries - 1) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }
          return null;
        }
        return JSON.parse(data) as JobState;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        if (err instanceof SyntaxError && attempt < retries - 1) {
          // JSON parse error - file may be partially written, retry
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  /**
   * Update a job with partial fields.
   * Uses atomic write (temp file + rename) to prevent read-during-write corruption.
   */
  async updateJob(
    sessionKey: string,
    jobId: string,
    updates: Partial<JobState>
  ): Promise<JobState> {
    const job = await this.getJob(sessionKey, jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const updated = { ...job, ...updates };
    const jobPath = this.jobFile(sessionKey, jobId);
    const tempPath = `${jobPath}.${randomUUID()}.tmp`;

    await fs.writeFile(tempPath, JSON.stringify(updated, null, 2));
    await fs.rename(tempPath, jobPath);
    return updated;
  }

  /**
   * Get the active job for a session.
   */
  async getActiveJob(sessionKey: string): Promise<JobState | null> {
    const session = await this.getSession(sessionKey);
    if (!session?.activeJobId) {
      return null;
    }
    return this.getJob(sessionKey, session.activeJobId);
  }

  /**
   * Set the active job ID for a session.
   */
  async setActiveJob(sessionKey: string, jobId: string | null): Promise<void> {
    const session = await this.getSession(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    session.activeJobId = jobId;
    session.lastActivity = new Date().toISOString();
    await fs.writeFile(this.sessionFile(sessionKey), JSON.stringify(session, null, 2));
  }

  /**
   * List all jobs for a session.
   */
  async listJobs(sessionKey: string): Promise<JobState[]> {
    const jobs: JobState[] = [];
    const jobDir = this.jobsDir(sessionKey);

    try {
      const entries = await fs.readdir(jobDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const jobId = entry.slice(0, -5); // Remove .json
        const job = await this.getJob(sessionKey, jobId);
        if (job) {
          jobs.push(job);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    return jobs;
  }

  /**
   * Read job output with offset and limit support.
   */
  async readJobOutput(
    sessionKey: string,
    jobId: string,
    opts?: { offset?: number; limit?: number }
  ): Promise<JobOutputResult> {
    const job = await this.getJob(sessionKey, jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 65536; // 64KB default

    try {
      const stat = await fs.stat(job.outputFile);
      const totalSize = stat.size;

      if (offset >= totalSize) {
        return { content: "", size: 0, totalSize, hasMore: false };
      }

      const handle = await fs.open(job.outputFile, "r");
      try {
        const buffer = Buffer.alloc(Math.min(limit, totalSize - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);

        return {
          content: buffer.toString("utf-8", 0, bytesRead),
          size: bytesRead,
          totalSize,
          hasMore: offset + bytesRead < totalSize,
        };
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { content: "", size: 0, totalSize: 0, hasMore: false };
      }
      throw err;
    }
  }

  /**
   * Append content to job output file.
   * Note: Does not update job metadata to avoid race conditions during rapid streaming.
   * Output size and last output time are computed on-demand when reading.
   */
  async appendJobOutput(sessionKey: string, jobId: string, content: string): Promise<void> {
    const job = await this.getJob(sessionKey, jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    await fs.appendFile(job.outputFile, content);
  }

  /**
   * Read the last N bytes from job output (tail).
   * Also returns the time since last output was received.
   */
  async readJobOutputTail(
    sessionKey: string,
    jobId: string,
    tailBytes = 500
  ): Promise<{ tail: string; lastOutputSecondsAgo: number | null; totalSize: number }> {
    const job = await this.getJob(sessionKey, jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    try {
      const stat = await fs.stat(job.outputFile);
      const totalSize = stat.size;

      // Use file mtime for accurate last output tracking
      const lastOutputSecondsAgo = totalSize > 0 ? (Date.now() - stat.mtimeMs) / 1000 : null;

      if (totalSize === 0) {
        return { tail: "", lastOutputSecondsAgo, totalSize };
      }

      const offset = Math.max(0, totalSize - tailBytes);
      const handle = await fs.open(job.outputFile, "r");
      try {
        const buffer = Buffer.alloc(Math.min(tailBytes, totalSize));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);

        let tail = buffer.toString("utf-8", 0, bytesRead);
        // If we're not at the start, prefix with "..." to indicate truncation
        if (offset > 0) {
          tail = "..." + tail;
        }

        return { tail, lastOutputSecondsAgo, totalSize };
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { tail: "", lastOutputSecondsAgo: null, totalSize: 0 };
      }
      throw err;
    }
  }
}
