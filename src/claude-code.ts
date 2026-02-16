import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { SessionManager } from "./session-manager.js";
import { PodmanRunner } from "./podman-runner.js";

/**
 * Plugin configuration interface
 */
export interface ClaudeCodePluginConfig {
  image: string;
  runtime: string;
  startupTimeout: number; // Seconds to wait for container first output
  idleTimeout: number; // Seconds of no output before killing container
  memory: string;
  cpus: string;
  network: string;
  sessionsDir: string;
  workspacesDir: string;
  sessionIdleTimeout: number; // Seconds before cleaning up inactive sessions
  apparmorProfile?: string; // AppArmor profile name (empty = disabled)
  maxOutputSize: number; // Maximum output size in bytes (0 = unlimited)
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: ClaudeCodePluginConfig = {
  image: "ghcr.io/13rac1/openclaw-claude-code:latest",
  runtime: "podman",
  startupTimeout: 30, // Container must produce output within 30s
  idleTimeout: 120, // Container silent for 120s = hung
  memory: "512m",
  cpus: "1.0",
  network: "bridge", // Needs network for Anthropic API access
  sessionsDir: "~/.openclaw/claude-sessions",
  workspacesDir: "~/.openclaw/workspaces",
  sessionIdleTimeout: 3600, // Clean up sessions after 1hr idle
  apparmorProfile: "", // Disabled by default
  maxOutputSize: 10 * 1024 * 1024, // 10MB default
};

/** Tool response content item */
interface ContentItem {
  type: string;
  text: string;
}

/**
 * OpenClaw Plugin API interface
 */
interface PluginApi {
  config: Record<string, unknown>;
  registerTool(config: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: ContentItem[] }>;
  }): void;
}

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${String(days)}d ${String(hours % 24)}h`;
  }
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes % 60)}m`;
  }
  if (minutes > 0) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }
  return `${String(seconds)}s`;
}

/**
 * Claude Code Plugin for OpenClaw
 *
 * Registers tools that execute prompts in isolated Podman containers
 * running Claude Code CLI.
 */
export default function register(api: PluginApi): void {
  const pluginConfig = api.config as Partial<ClaudeCodePluginConfig>;
  const config: ClaudeCodePluginConfig = {
    ...DEFAULT_CONFIG,
    ...pluginConfig,
  };

  const sessionManager = new SessionManager({
    sessionsDir: config.sessionsDir,
    workspacesDir: config.workspacesDir,
    idleTimeout: config.sessionIdleTimeout,
  });

  const podmanRunner = new PodmanRunner({
    runtime: config.runtime,
    image: config.image,
    startupTimeout: config.startupTimeout,
    idleTimeout: config.idleTimeout,
    memory: config.memory,
    cpus: config.cpus,
    network: config.network,
    apparmorProfile: config.apparmorProfile,
    maxOutputSize: config.maxOutputSize,
  });

  // Helper to check authentication
  async function getAuth(): Promise<{ apiKey?: string; hasCredsFile: boolean }> {
    const hostCredsPath = path.join(homedir(), ".claude", ".credentials.json");
    let hasCredsFile = false;

    try {
      await fs.access(hostCredsPath);
      hasCredsFile = true;
      console.error(`[claude-code] Found credentials file: ${hostCredsPath}`);
    } catch (err) {
      // No credentials file
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.error(`[claude-code] No credentials file at ${hostCredsPath}: ${errMsg}`);
    }

    const apiKey = hasCredsFile ? undefined : process.env.ANTHROPIC_API_KEY;

    if (!apiKey && !hasCredsFile) {
      throw new Error(
        `No authentication available. Set ANTHROPIC_API_KEY or create ${hostCredsPath}`
      );
    }

    console.error(
      `[claude-code] Auth: hasCredsFile=${String(hasCredsFile)}, hasApiKey=${String(!!apiKey)}`
    );
    return { apiKey, hasCredsFile };
  }

  // Get path to host credentials file
  function getHostCredsPath(): string {
    return path.join(homedir(), ".claude", ".credentials.json");
  }

  // Register claude_code_start tool
  api.registerTool({
    name: "claude_code_start",
    description:
      "Start a Claude Code task in the background. Returns a job ID immediately. " +
      "Use claude_code_status to check progress and claude_code_output to read results.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt or task to send to Claude Code" }),
      session_id: Type.Optional(
        Type.String({ description: "Optional session ID to continue a previous session" })
      ),
    }),
    async execute(id, params) {
      const prompt = params.prompt as string;
      if (!prompt) {
        throw new Error("prompt parameter is required");
      }

      const sessionKey = (params.session_id as string | undefined) ?? `session-${id}`;

      // Check authentication
      const { apiKey, hasCredsFile } = await getAuth();

      // Verify container image exists
      const imageExists = await podmanRunner.checkImage();
      if (!imageExists) {
        throw new Error(
          `Container image not found: ${config.image}. ` +
            `Build it with: podman build -t ${config.image} .`
        );
      }

      // Get or create session
      const session = await sessionManager.getOrCreateSession(sessionKey);

      // Check for existing active job
      const activeJob = await sessionManager.getActiveJob(sessionKey);
      if (activeJob && (activeJob.status === "pending" || activeJob.status === "running")) {
        throw new Error(
          `Session already has an active job: ${activeJob.jobId} (status: ${activeJob.status})`
        );
      }

      // Get paths for volume mounts
      const claudeDir = `${config.sessionsDir.replace("~", process.env.HOME ?? "")}/${sessionKey}/.claude`;
      const workspaceDir = sessionManager.workspaceDir(sessionKey);
      const hostCredsPath = hasCredsFile ? getHostCredsPath() : undefined;

      console.error(
        `[claude-code] Volume mounts: claudeDir=${claudeDir}, hostCredsPath=${hostCredsPath ?? "none"}`
      );

      // Create job record
      const containerName = podmanRunner.containerNameFromSessionKey(sessionKey);
      const job = await sessionManager.createJob(sessionKey, { prompt, containerName });

      try {
        // Start container in detached mode
        await podmanRunner.startDetached({
          sessionKey,
          prompt,
          claudeDir,
          workspaceDir,
          resumeSessionId: session.claudeSessionId ?? undefined,
          apiKey,
          hostCredsPath,
        });

        // Update job status to running
        await sessionManager.updateJob(sessionKey, job.jobId, {
          status: "running",
          startedAt: new Date().toISOString(),
        });

        // Set as active job
        await sessionManager.setActiveJob(sessionKey, job.jobId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  jobId: job.jobId,
                  sessionKey,
                  status: "running",
                  message: "Job started. Use claude_code_status to check progress.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        // Update job as failed
        const message = err instanceof Error ? err.message : String(err);
        await sessionManager.updateJob(sessionKey, job.jobId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errorMessage: message,
        });
        throw err;
      }
    },
  });

  // Register claude_code_status tool
  api.registerTool({
    name: "claude_code_status",
    description:
      "Check the status of a Claude Code job. Returns status, elapsed time, output size, and metrics.",
    parameters: Type.Object({
      job_id: Type.String({ description: "The job ID to check" }),
      session_id: Type.Optional(
        Type.String({ description: "Session ID (if job was started with one)" })
      ),
    }),
    async execute(id, params) {
      const jobId = params.job_id as string;
      if (!jobId) {
        throw new Error("job_id parameter is required");
      }

      // Find the job - try provided session_id first, then search all sessions
      let sessionKey = params.session_id as string | undefined;
      let job = sessionKey ? await sessionManager.getJob(sessionKey, jobId) : null;

      if (!job) {
        // Search all sessions for the job
        const sessions = await sessionManager.listSessions();
        for (const session of sessions) {
          job = await sessionManager.getJob(session.sessionKey, jobId);
          if (job) {
            sessionKey = session.sessionKey;
            break;
          }
        }
      }

      if (!job || !sessionKey) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // If job is running, check container status
      if (job.status === "running") {
        const containerStatus = await podmanRunner.getContainerStatus(job.containerName);

        if (containerStatus && !containerStatus.running) {
          // Container finished - update job
          const logs = await podmanRunner.getContainerLogs(job.containerName);
          if (logs) {
            await sessionManager.appendJobOutput(sessionKey, jobId, logs);
          }

          const status = containerStatus.exitCode === 0 ? "completed" : "failed";
          job = await sessionManager.updateJob(sessionKey, jobId, {
            status,
            completedAt: containerStatus.finishedAt ?? new Date().toISOString(),
            exitCode: containerStatus.exitCode,
            errorType:
              containerStatus.exitCode === 137
                ? "oom"
                : containerStatus.exitCode !== 0
                  ? "crash"
                  : null,
          });

          // Clear active job
          await sessionManager.setActiveJob(sessionKey, null);

          // Clean up container
          await podmanRunner.killContainer(sessionKey);
        } else if (containerStatus) {
          // Still running - get latest logs and metrics
          const logs = await podmanRunner.getContainerLogs(job.containerName);
          if (logs) {
            await sessionManager.appendJobOutput(sessionKey, jobId, logs);
          }

          const metrics = await podmanRunner.getContainerStats(job.containerName);
          if (metrics) {
            await sessionManager.updateJob(sessionKey, jobId, { metrics });
            job.metrics = metrics;
          }
        }
      }

      // Calculate elapsed time
      const startTime = job.startedAt
        ? new Date(job.startedAt).getTime()
        : new Date(job.createdAt).getTime();
      const endTime = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
      const elapsedSeconds = (endTime - startTime) / 1000;

      // Get current output size
      const outputResult = await sessionManager.readJobOutput(sessionKey, jobId, {
        offset: 0,
        limit: 0,
      });

      const response = {
        jobId: job.jobId,
        sessionKey,
        status: job.status,
        elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
        outputSize: outputResult.totalSize,
        exitCode: job.exitCode,
        error: job.errorMessage,
        metrics: job.metrics,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  });

  // Register claude_code_output tool
  api.registerTool({
    name: "claude_code_output",
    description:
      "Read output from a Claude Code job. Supports reading partial output while job is running.",
    parameters: Type.Object({
      job_id: Type.String({ description: "The job ID" }),
      session_id: Type.Optional(Type.String({ description: "Session ID" })),
      offset: Type.Optional(
        Type.Number({ description: "Byte offset to start reading from (default: 0)" })
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum bytes to read (default: 64KB)" })),
    }),
    async execute(id, params) {
      const jobId = params.job_id as string;
      if (!jobId) {
        throw new Error("job_id parameter is required");
      }

      // Find the job
      let sessionKey = params.session_id as string | undefined;
      let job = sessionKey ? await sessionManager.getJob(sessionKey, jobId) : null;

      if (!job) {
        const sessions = await sessionManager.listSessions();
        for (const session of sessions) {
          job = await sessionManager.getJob(session.sessionKey, jobId);
          if (job) {
            sessionKey = session.sessionKey;
            break;
          }
        }
      }

      if (!job || !sessionKey) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // If running, capture latest logs first
      if (job.status === "running") {
        const logs = await podmanRunner.getContainerLogs(job.containerName);
        if (logs) {
          await sessionManager.appendJobOutput(sessionKey, jobId, logs);
        }
      }

      const offset = (params.offset as number | undefined) ?? 0;
      const limit = (params.limit as number | undefined) ?? 65536;

      const result = await sessionManager.readJobOutput(sessionKey, jobId, { offset, limit });

      const header = `[job: ${jobId}] [status: ${job.status}] [bytes ${String(offset)}-${String(offset + result.size)} of ${String(result.totalSize)}]${result.hasMore ? " [more available]" : ""}`;

      return {
        content: [{ type: "text", text: `${header}\n\n${result.content}` }],
      };
    },
  });

  // Register claude_code_cancel tool
  api.registerTool({
    name: "claude_code_cancel",
    description: "Cancel a running Claude Code job.",
    parameters: Type.Object({
      job_id: Type.String({ description: "The job ID to cancel" }),
      session_id: Type.Optional(Type.String({ description: "Session ID" })),
    }),
    async execute(id, params) {
      const jobId = params.job_id as string;
      if (!jobId) {
        throw new Error("job_id parameter is required");
      }

      // Find the job
      let sessionKey = params.session_id as string | undefined;
      let job = sessionKey ? await sessionManager.getJob(sessionKey, jobId) : null;

      if (!job) {
        const sessions = await sessionManager.listSessions();
        for (const session of sessions) {
          job = await sessionManager.getJob(session.sessionKey, jobId);
          if (job) {
            sessionKey = session.sessionKey;
            break;
          }
        }
      }

      if (!job || !sessionKey) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== "running" && job.status !== "pending") {
        return {
          content: [
            { type: "text", text: `Job ${jobId} is already ${job.status}, cannot cancel.` },
          ],
        };
      }

      // Kill the container
      await podmanRunner.killContainer(sessionKey);

      // Update job status
      await sessionManager.updateJob(sessionKey, jobId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
      });

      // Clear active job
      await sessionManager.setActiveJob(sessionKey, null);

      return {
        content: [{ type: "text", text: `Job ${jobId} cancelled.` }],
      };
    },
  });

  // Register the cleanup tool
  api.registerTool({
    name: "claude_code_cleanup",
    description:
      "Clean up idle Claude Code sessions. " +
      "Removes sessions that have been inactive longer than the configured timeout.",
    parameters: Type.Object({}),
    async execute() {
      const deleted = await sessionManager.cleanupIdleSessions();

      const text =
        deleted.length === 0
          ? "No idle sessions to clean up."
          : `Cleaned up ${String(deleted.length)} idle session(s): ${deleted.join(", ")}`;

      return {
        content: [{ type: "text", text }],
      };
    },
  });

  // Register the sessions listing tool
  api.registerTool({
    name: "claude_code_sessions",
    description:
      "List all active Claude Code sessions with their age, message count, and active jobs. " +
      "Useful for understanding which sessions exist before resuming or cleaning up.",
    parameters: Type.Object({}),
    async execute() {
      const sessions = await sessionManager.listSessions();

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No active sessions." }],
        };
      }

      const now = Date.now();
      const lines = await Promise.all(
        sessions.map(async (session) => {
          const ageMs = now - new Date(session.createdAt).getTime();
          const ageFormatted = formatDuration(ageMs);
          const lastActiveMs = now - new Date(session.lastActivity).getTime();
          const lastActiveFormatted = formatDuration(lastActiveMs);

          const parts = [
            `Session: ${session.sessionKey}`,
            `  Age: ${ageFormatted}`,
            `  Last Active: ${lastActiveFormatted} ago`,
            `  Messages: ${String(session.messageCount)}`,
          ];

          if (session.activeJobId) {
            const activeJob = await sessionManager.getJob(session.sessionKey, session.activeJobId);
            if (activeJob) {
              parts.push(`  Active Job: ${activeJob.jobId} (${activeJob.status})`);
            }
          }

          if (session.claudeSessionId) {
            parts.push(`  Claude Session: ${session.claudeSessionId}`);
          }

          return parts.join("\n");
        })
      );

      const text = `Found ${String(sessions.length)} session(s):\n\n${lines.join("\n\n")}`;

      return {
        content: [{ type: "text", text }],
      };
    },
  });

  // Recovery: find orphaned containers on startup and reconcile with job state
  void recoverOrphanedJobs(sessionManager, podmanRunner);
}

/**
 * Recover orphaned containers on startup.
 * Reconciles running containers with job state.
 */
async function recoverOrphanedJobs(
  sessionManager: SessionManager,
  podmanRunner: PodmanRunner
): Promise<void> {
  try {
    const containers = await podmanRunner.listContainersByPrefix("claude-");

    for (const container of containers) {
      const sessionKey = podmanRunner.sessionKeyFromContainerName(container.name);
      if (!sessionKey) continue;

      const activeJob = await sessionManager.getActiveJob(sessionKey);

      if (activeJob?.containerName === container.name) {
        // Job exists for this container
        if (!container.running) {
          // Container finished while plugin was down - update job
          const status = await podmanRunner.getContainerStatus(container.name);
          const logs = await podmanRunner.getContainerLogs(container.name);

          if (logs) {
            await sessionManager.appendJobOutput(sessionKey, activeJob.jobId, logs);
          }

          await sessionManager.updateJob(sessionKey, activeJob.jobId, {
            status: status?.exitCode === 0 ? "completed" : "failed",
            completedAt: status?.finishedAt ?? new Date().toISOString(),
            exitCode: status?.exitCode ?? null,
            errorType: status?.exitCode === 137 ? "oom" : status?.exitCode !== 0 ? "crash" : null,
          });

          await sessionManager.setActiveJob(sessionKey, null);
          await podmanRunner.killContainer(sessionKey);
        }
        // If still running, leave it alone - normal polling will handle it
      } else {
        // Orphaned container with no matching job - kill it
        await podmanRunner.killContainer(sessionKey);
      }
    }
  } catch {
    // Ignore recovery errors on startup
  }
}

// Also export components for testing
export { SessionManager } from "./session-manager.js";
export { PodmanRunner } from "./podman-runner.js";
