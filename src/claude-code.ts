import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { SessionManager, type JobState } from "./session-manager.js";
import { PodmanRunner, type ErrorType } from "./podman-runner.js";
import { notifyJobCompletion, type JobCompletionEvent } from "./notification.js";
import {
  parseStreamLine,
  extractTextFromStream,
  parseRateLimitError,
  type RateLimitInfo,
} from "./stream-parser.js";
import { formatDuration } from "./format.js";

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
  notifyWebhookUrl: string; // OpenClaw webhook URL (default: http://localhost:18789/hooks/agent)
  hooksToken: string; // Webhook authentication token (from OpenClaw hooks.token)
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
  notifyWebhookUrl: "http://localhost:18789/hooks/agent",
  hooksToken: "", // Must be set to enable notifications
};

// Activity detection thresholds
const ACTIVE_OUTPUT_THRESHOLD_SECONDS = 10; // Output within 10s = actively producing
const PROCESSING_CPU_THRESHOLD_PERCENT = 20; // CPU > 20% = processing

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
      console.log(`[claude-code] Found credentials file: ${hostCredsPath}`);
    } catch (err) {
      // No credentials file
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.log(`[claude-code] No credentials file at ${hostCredsPath}: ${errMsg}`);
    }

    const apiKey = hasCredsFile ? undefined : process.env.ANTHROPIC_API_KEY;

    if (!apiKey && !hasCredsFile) {
      throw new Error(
        `No authentication available. Set ANTHROPIC_API_KEY or create ${hostCredsPath}`
      );
    }

    console.log(
      `[claude-code] Auth: hasCredsFile=${String(hasCredsFile)}, hasApiKey=${String(!!apiKey)}`
    );
    return { apiKey, hasCredsFile };
  }

  // Get path to host credentials file
  function getHostCredsPath(): string {
    return path.join(homedir(), ".claude", ".credentials.json");
  }

  // Find a job by ID, searching all sessions if session_id not provided
  async function findJob(
    jobId: string,
    sessionId?: string
  ): Promise<{ job: JobState; sessionKey: string }> {
    let sessionKey = sessionId;
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

    return { job, sessionKey };
  }

  // Get webhook token - try plugin config first, then read OpenClaw config file
  function getWebhookToken(): string | undefined {
    if (config.hooksToken) {
      return config.hooksToken;
    }

    // Try to read from OpenClaw config file
    try {
      const configPath = path.join(homedir(), ".openclaw", "openclaw.json");
      const configData = readFileSync(configPath, "utf-8");
      const openclawConfig = JSON.parse(configData) as {
        hooks?: { token?: string };
      };
      return openclawConfig.hooks?.token;
    } catch {
      return undefined;
    }
  }

  // Send job completion notification if webhook token is available
  async function sendCompletionNotification(event: JobCompletionEvent): Promise<void> {
    const webhookToken = getWebhookToken();
    if (!webhookToken) {
      console.log("[claude-code] Notification skipped: no hooks.token in openclawConfig");
      return;
    }

    try {
      await notifyJobCompletion(
        {
          webhookUrl: config.notifyWebhookUrl,
          webhookToken,
        },
        event
      );
      console.log(
        `[claude-code] Posted job ${event.jobId} completion to ${config.notifyWebhookUrl}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.log(`[claude-code] Notification failed: ${errMsg}`);
    }
  }

  // Background watcher for job completion with real-time streaming
  function watchJobCompletion(sessionKey: string, jobId: string, containerName: string): void {
    // Fire and forget - runs in background
    void (async () => {
      try {
        console.log(`[claude-code] Streaming job ${jobId} output`);

        let lineBuffer = "";
        let rateLimitInfo: RateLimitInfo | null = null;

        // Stream logs in real-time, parsing JSON events as they arrive
        const exitCode = await podmanRunner.streamContainerLogs(containerName, (chunk) => {
          // Accumulate lines and parse stream-json events
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            // Check for rate limit error in result events
            const rateLimit = parseRateLimitError(line);
            if (rateLimit) {
              rateLimitInfo = rateLimit;
              console.log(
                `[claude-code] Rate limit detected: resets in ${String(rateLimit.waitMinutes)} minutes`
              );
            }

            const event = parseStreamLine(line);
            if (event?.type === "text") {
              // Append extracted text to output file (fire and forget)
              void sessionManager.appendJobOutput(sessionKey, jobId, event.content);
            }
          }
        });

        // Process any remaining buffered content
        if (lineBuffer.trim()) {
          // Check for rate limit in final line
          const rateLimit = parseRateLimitError(lineBuffer);
          if (rateLimit) {
            rateLimitInfo = rateLimit;
          }

          const event = parseStreamLine(lineBuffer);
          if (event?.type === "text") {
            await sessionManager.appendJobOutput(sessionKey, jobId, event.content);
          }
        }

        console.log(
          `[claude-code] Container ${containerName} exited with code ${String(exitCode)}`
        );

        // Get job to calculate elapsed time
        const job = await sessionManager.getJob(sessionKey, jobId);
        if (job?.status !== "running") {
          // Job already handled (cancelled, etc.)
          return;
        }

        // Determine status and error type
        let status: "completed" | "failed" = exitCode === 0 ? "completed" : "failed";
        let errorType: ErrorType | null = null;
        let errorMessage: string | null = null;

        if (rateLimitInfo) {
          // Rate limit is a failure even with exit code 0
          status = "failed";
          errorType = "rate_limit";
          errorMessage = `Claude Code rate limit hit. Wait ${String(rateLimitInfo.waitMinutes)} minutes (resets at ${rateLimitInfo.resetTime}).`;
        } else if (exitCode === 137) {
          errorType = "oom";
        } else if (exitCode !== 0) {
          errorType = "crash";
        }

        // Update job state
        const updatedJob = await sessionManager.updateJob(sessionKey, jobId, {
          status,
          completedAt: new Date().toISOString(),
          exitCode,
          errorType,
          errorMessage,
        });

        // Clear active job
        await sessionManager.setActiveJob(sessionKey, null);

        // Calculate elapsed time
        const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
        const elapsedSeconds = (Date.now() - startedAt) / 1000;

        // Send notification
        await sendCompletionNotification({
          jobId,
          sessionKey,
          status,
          elapsedSeconds,
          outputSize: updatedJob.outputSize,
          exitCode,
          errorType,
        });

        console.log(`[claude-code] Job ${jobId} completed with status: ${status}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown error";
        console.log(`[claude-code] Job watcher error for ${jobId}: ${errMsg}`);
      }
    })();
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

      // Copy credentials to session directory (with --userns=keep-id, we can write to the dir)
      if (hasCredsFile) {
        const hostCredsPath = getHostCredsPath();
        const sessionCredsPath = path.join(claudeDir, ".credentials.json");
        console.log(
          `[claude-code] Copying credentials from ${hostCredsPath} to ${sessionCredsPath}`
        );
        await fs.copyFile(hostCredsPath, sessionCredsPath);
      }

      console.log(`[claude-code] Volume mounts: claudeDir=${claudeDir}`);

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
        });

        // Update job status to running
        await sessionManager.updateJob(sessionKey, job.jobId, {
          status: "running",
          startedAt: new Date().toISOString(),
        });

        // Set as active job
        await sessionManager.setActiveJob(sessionKey, job.jobId);

        // Start background watcher for job completion
        watchJobCompletion(sessionKey, job.jobId, containerName);

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
      "Check the status of a Claude Code job. Returns status, elapsed time, output size, metrics, " +
      "plus tailOutput (last ~500 chars), lastOutputSecondsAgo, and activityState (active/processing/idle).",
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
      const found = await findJob(jobId, params.session_id as string | undefined);
      let job = found.job;
      const sessionKey = found.sessionKey;

      // If job is running, check container status
      if (job.status === "running") {
        const containerStatus = await podmanRunner.getContainerStatus(job.containerName);

        if (containerStatus && !containerStatus.running) {
          // Container finished - parse JSON logs and extract text
          const logs = await podmanRunner.getContainerLogs(job.containerName);
          if (logs) {
            const lines = logs.split("\n").filter((l) => l.trim());
            const text = extractTextFromStream(lines);
            if (text) {
              await sessionManager.appendJobOutput(sessionKey, jobId, text);
            }
          }

          const status = containerStatus.exitCode === 0 ? "completed" : "failed";
          const completedAt = containerStatus.finishedAt ?? new Date().toISOString();
          job = await sessionManager.updateJob(sessionKey, jobId, {
            status,
            completedAt,
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
          // Still running - streaming watcher handles output capture
          // Just get metrics for status reporting
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

      // Get output tail and last modified time
      const tailResult = await sessionManager.readJobOutputTail(sessionKey, jobId, 500);

      // Determine activity state based on output recency and resource usage
      let activityState: "active" | "processing" | "idle" = "idle";
      if (job.status === "running") {
        const lastOutputAgo = tailResult.lastOutputSecondsAgo ?? Infinity;
        const cpuPercent = job.metrics?.cpuPercent ?? 0;

        if (lastOutputAgo < ACTIVE_OUTPUT_THRESHOLD_SECONDS) {
          activityState = "active"; // Actively producing output
        } else if (cpuPercent > PROCESSING_CPU_THRESHOLD_PERCENT) {
          activityState = "processing"; // Working but no output yet
        } else {
          activityState = "idle"; // May be stuck or waiting
        }
      }

      const response = {
        jobId: job.jobId,
        sessionKey,
        status: job.status,
        elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
        outputSize: tailResult.totalSize,
        lastOutputSecondsAgo:
          tailResult.lastOutputSecondsAgo !== null
            ? Math.round(tailResult.lastOutputSecondsAgo)
            : null,
        activityState,
        tailOutput: tailResult.tail,
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
      const { job, sessionKey } = await findJob(jobId, params.session_id as string | undefined);

      // Note: Output is captured in real-time by the streaming watcher
      // No need to fetch logs here - just read from the output file

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
      const { job, sessionKey } = await findJob(jobId, params.session_id as string | undefined);

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
      const completedAt = new Date().toISOString();
      const updatedJob = await sessionManager.updateJob(sessionKey, jobId, {
        status: "cancelled",
        completedAt,
      });

      // Send cancellation notification
      const startTime = job.startedAt
        ? new Date(job.startedAt).getTime()
        : new Date(job.createdAt).getTime();
      const elapsedSeconds = (new Date(completedAt).getTime() - startTime) / 1000;
      await sendCompletionNotification({
        jobId,
        sessionKey,
        status: "cancelled",
        elapsedSeconds,
        outputSize: updatedJob.outputSize,
        exitCode: null,
        errorType: null,
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
          // Container finished while plugin was down - parse JSON logs and update job
          // Note: No notification sent for recovered jobs (user wasn't actively waiting)
          const status = await podmanRunner.getContainerStatus(container.name);
          const logs = await podmanRunner.getContainerLogs(container.name);

          if (logs) {
            // Parse JSON stream output and extract text
            const lines = logs.split("\n").filter((l) => l.trim());
            const text = extractTextFromStream(lines);
            if (text) {
              await sessionManager.appendJobOutput(sessionKey, activeJob.jobId, text);
            }
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
        // If still running, leave it alone - status checks will handle it
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
