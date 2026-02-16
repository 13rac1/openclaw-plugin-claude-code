import { spawn } from "node:child_process";

export interface PodmanConfig {
  runtime: string;
  image: string;
  startupTimeout: number; // Seconds to wait for first output
  idleTimeout: number; // Seconds with no output = hung
  memory: string;
  cpus: string;
  network: string;
  apparmorProfile?: string; // AppArmor profile name (empty = disabled)
  maxOutputSize: number; // Maximum output size in bytes (0 = unlimited)
}

export type ErrorType = "startup_timeout" | "idle_timeout" | "oom" | "crash" | "spawn_failed";

export interface ResourceMetrics {
  memoryUsageMB?: number;
  memoryLimitMB?: number;
  memoryPercent?: number;
  cpuPercent?: number;
}

export interface ClaudeCodeResult {
  content: string;
  sessionId: string | null;
  exitCode: number;
  elapsedSeconds?: number;
  errorType?: ErrorType;
  outputTruncated?: boolean;
  originalSize?: number;
  metrics?: ResourceMetrics;
}

// Type for parsed Claude Code JSON output
interface ClaudeCodeOutput {
  result?: string;
  content?: string;
  message?: string;
  session_id?: string;
  sessionId?: string;
}

// Type for podman stats JSON output
interface PodmanStatsOutput {
  MemUsage?: string;
  mem_usage?: string;
  MemLimit?: string;
  mem_limit?: string;
  MemPerc?: string | number;
  CPUPerc?: string | number;
}

// Type for podman inspect JSON output
interface PodmanInspectState {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
  StartedAt?: string;
  FinishedAt?: string;
}

interface PodmanInspectOutput {
  State?: PodmanInspectState;
  Created?: string;
  Name?: string;
}

// Type for podman ps JSON output
interface PodmanPsOutput {
  Names?: string | string[];
  State?: string;
  Status?: string;
  Created?: string;
  CreatedAt?: string;
}

/** Container status returned by getContainerStatus */
export interface ContainerStatus {
  running: boolean;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Container info returned by listContainersByPrefix */
export interface ContainerInfo {
  name: string;
  running: boolean;
  createdAt: string;
}

/** Result of starting a detached container */
export interface DetachedStartResult {
  containerName: string;
  containerId: string;
}

function isClaudeCodeOutput(value: unknown): value is ClaudeCodeOutput {
  return typeof value === "object" && value !== null;
}

function isPodmanStatsOutput(value: unknown): value is PodmanStatsOutput {
  return typeof value === "object" && value !== null;
}

function isPodmanInspectOutput(value: unknown): value is PodmanInspectOutput {
  return typeof value === "object" && value !== null;
}

function isPodmanPsOutput(value: unknown): value is PodmanPsOutput {
  return typeof value === "object" && value !== null;
}

export class PodmanRunner {
  private config: PodmanConfig;

  constructor(config: PodmanConfig) {
    this.config = config;
  }

  async runClaudeCode(params: {
    sessionKey: string;
    prompt: string;
    claudeDir: string;
    workspaceDir: string;
    resumeSessionId?: string;
    apiKey?: string;
    hostCredsPath?: string;
  }): Promise<ClaudeCodeResult> {
    const containerName = `claude-${params.sessionKey.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // Clean up stale container from previous crash
    await this.killContainer(params.sessionKey);

    const args = this.buildArgs(params, containerName);
    return this.execute(args, containerName);
  }

  private buildArgs(
    params: {
      sessionKey: string;
      prompt: string;
      claudeDir: string;
      workspaceDir: string;
      resumeSessionId?: string;
      apiKey?: string;
      hostCredsPath?: string;
    },
    containerName: string
  ): string[] {
    // Build the claude command to run inside bash
    // Claude doesn't output when run as PID 1, must run through bash
    const resumeFlag = params.resumeSessionId ? `--resume '${params.resumeSessionId}'` : "";
    const escapedPrompt = params.prompt.replace(/'/g, "'\\''");
    const claudeCmd = `claude --print --dangerously-skip-permissions ${resumeFlag} -p '${escapedPrompt}' < /dev/null 2>&1`;

    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      this.config.network,
      "--cap-drop",
      "ALL",
    ];

    // Add AppArmor profile if configured
    if (this.config.apparmorProfile) {
      args.push("--security-opt", `apparmor=${this.config.apparmorProfile}`);
    }

    // Note: no --read-only, claude needs to write temp files
    args.push(
      "--memory",
      this.config.memory,
      "--cpus",
      this.config.cpus,
      "--pids-limit",
      "100",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      // :U flag handles UID mapping for permissions
      "-v",
      `${params.claudeDir}:/home/claude/.claude:U`,
      "-v",
      `${params.workspaceDir}:/workspace:U`
    );

    // Mount host credentials file as read-only overlay (after .claude dir mount)
    if (params.hostCredsPath) {
      args.push("-v", `${params.hostCredsPath}:/home/claude/.claude/.credentials.json:ro`);
    }

    // Only add API key if provided (otherwise uses credentials file)
    if (params.apiKey) {
      args.push("-e", `ANTHROPIC_API_KEY=${params.apiKey}`);
    }

    args.push("-w", "/workspace", "--entrypoint", "/bin/bash", this.config.image, "-c", claudeCmd);

    return args;
  }

  private execute(args: string[], containerName: string): Promise<ClaudeCodeResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const proc = spawn(this.config.runtime, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let killReason: ErrorType | null = null;
      let lastActivity = Date.now();
      let hadOutput = false;
      let totalOutputSize = 0;
      let outputTruncated = false;
      const maxSize = this.config.maxOutputSize;
      let lastMetrics: ResourceMetrics | undefined;

      const cleanup = (): void => {
        clearTimeout(startupTimeoutId);
        clearInterval(idleCheckInterval);
        clearInterval(metricsInterval);
      };

      const killProcess = (reason: ErrorType): void => {
        if (killed) return;
        killed = true;
        killReason = reason;
        cleanup();
        proc.kill("SIGTERM");
        // Give 5s for graceful shutdown, then SIGKILL
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      };

      // Startup timeout - must produce first output within N seconds
      const startupTimeoutId = setTimeout(() => {
        if (!hadOutput) {
          killProcess("startup_timeout");
        }
      }, this.config.startupTimeout * 1000);

      // Idle timeout check - no output for N seconds = hung
      const idleCheckInterval = setInterval(() => {
        if (!hadOutput) return; // Still waiting for startup, don't check idle
        const idleSeconds = (Date.now() - lastActivity) / 1000;
        if (idleSeconds > this.config.idleTimeout) {
          killProcess("idle_timeout");
        }
      }, 5000);

      // Periodically sample container metrics (every 10s)
      const metricsInterval = setInterval(() => {
        if (!hadOutput) return; // Container not started yet
        void this.getContainerStats(containerName).then((metrics) => {
          if (metrics) {
            lastMetrics = metrics;
          }
        });
      }, 10000);

      const onOutput = (): void => {
        if (!hadOutput) {
          hadOutput = true;
          clearTimeout(startupTimeoutId);
        }
        lastActivity = Date.now();
      };

      proc.stdout.on("data", (data: Buffer) => {
        onOutput();
        const dataStr = data.toString();
        if (maxSize > 0 && totalOutputSize + dataStr.length > maxSize) {
          if (!outputTruncated) {
            const remaining = maxSize - totalOutputSize;
            stdout += dataStr.slice(0, remaining);
            outputTruncated = true;
          }
          totalOutputSize += dataStr.length;
        } else {
          stdout += dataStr;
          totalOutputSize += dataStr.length;
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        onOutput();
        const dataStr = data.toString();
        if (maxSize > 0 && totalOutputSize + dataStr.length > maxSize) {
          if (!outputTruncated) {
            const remaining = maxSize - totalOutputSize;
            stderr += dataStr.slice(0, remaining);
            outputTruncated = true;
          }
          totalOutputSize += dataStr.length;
        } else {
          stderr += dataStr;
          totalOutputSize += dataStr.length;
        }
      });

      proc.on("error", (err) => {
        cleanup();
        const elapsed = (Date.now() - startTime) / 1000;
        reject(
          Object.assign(new Error(`Failed to spawn ${this.config.runtime}: ${err.message}`), {
            errorType: "spawn_failed" as ErrorType,
            elapsedSeconds: elapsed,
          })
        );
      });

      proc.on("close", (code, signal) => {
        cleanup();
        const elapsed = (Date.now() - startTime) / 1000;

        if (killed && killReason) {
          const message =
            killReason === "startup_timeout"
              ? `Container startup timeout (no output for ${String(this.config.startupTimeout)}s)`
              : `Container idle timeout (no output for ${String(this.config.idleTimeout)}s) after ${elapsed.toFixed(1)}s total`;
          reject(
            Object.assign(new Error(message), {
              errorType: killReason,
              elapsedSeconds: elapsed,
            })
          );
          return;
        }

        if (signal === "SIGKILL" || code === 137) {
          reject(
            Object.assign(
              new Error(
                `Container killed (OOM or resource limit) after ${elapsed.toFixed(1)}s: ${stderr || stdout}`
              ),
              { errorType: "oom" as ErrorType, elapsedSeconds: elapsed }
            )
          );
          return;
        }

        if (code !== 0) {
          reject(
            Object.assign(
              new Error(
                `Container failed (exit ${String(code)}) after ${elapsed.toFixed(1)}s: ${stderr || stdout}`
              ),
              { errorType: "crash" as ErrorType, elapsedSeconds: elapsed }
            )
          );
          return;
        }

        const result = this.parseOutput(stdout, code);
        result.elapsedSeconds = elapsed;
        if (outputTruncated) {
          result.outputTruncated = true;
          result.originalSize = totalOutputSize;
        }
        if (lastMetrics) {
          result.metrics = lastMetrics;
        }
        resolve(result);
      });
    });
  }

  private parseOutput(output: string, exitCode: number): ClaudeCodeResult {
    // Claude Code --print outputs JSON when available
    // Try to parse as JSON first
    try {
      const lines = output.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith("{") && line.endsWith("}")) {
          const parsed: unknown = JSON.parse(line);
          if (isClaudeCodeOutput(parsed)) {
            return {
              content: parsed.result ?? parsed.content ?? parsed.message ?? output,
              sessionId: parsed.session_id ?? parsed.sessionId ?? null,
              exitCode,
            };
          }
        }
      }
    } catch {
      // Not JSON, use raw output
    }

    return {
      content: output.trim(),
      sessionId: null,
      exitCode,
    };
  }

  async checkImage(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.runtime, ["image", "exists", this.config.image], {
        stdio: "ignore",
      });

      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }

  async killContainer(sessionKey: string): Promise<void> {
    const containerName = `claude-${sessionKey.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // First try to kill, then remove (in case it's stopped but not removed)
    await new Promise<void>((resolve) => {
      const proc = spawn(this.config.runtime, ["kill", containerName], {
        stdio: "ignore",
      });
      proc.on("error", () => resolve());
      proc.on("close", () => resolve());
    });

    await new Promise<void>((resolve) => {
      const proc = spawn(this.config.runtime, ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      proc.on("error", () => resolve());
      proc.on("close", () => resolve());
    });
  }

  async verifyContainerRunning(containerName: string, retries = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const exists = await new Promise<boolean>((resolve) => {
        const proc = spawn(this.config.runtime, ["container", "exists", containerName], {
          stdio: "ignore",
        });
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
      if (exists) return true;
    }
    return false;
  }

  /**
   * Get resource metrics for a running container.
   * Returns undefined if container is not running or stats unavailable.
   */
  getContainerStats(containerName: string): Promise<ResourceMetrics | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.config.runtime,
        ["stats", "--no-stream", "--format", "json", containerName],
        { stdio: ["ignore", "pipe", "ignore"] }
      );

      let stdout = "";
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("error", () => resolve(undefined));
      proc.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (code !== 0) {
          resolve(undefined);
          return;
        }

        try {
          const stats: unknown = JSON.parse(stdout);
          // Podman stats JSON format - may be array or single object
          const statArray = Array.isArray(stats) ? stats : [stats];
          const stat: unknown = statArray[0];

          if (!isPodmanStatsOutput(stat)) {
            resolve(undefined);
            return;
          }

          const memUsage = this.parseMemoryString(stat.MemUsage ?? stat.mem_usage);
          const memLimit = this.parseMemoryString(stat.MemLimit ?? stat.mem_limit);

          resolve({
            memoryUsageMB: memUsage,
            memoryLimitMB: memLimit,
            memoryPercent: stat.MemPerc
              ? parseFloat(String(stat.MemPerc).replace("%", ""))
              : undefined,
            cpuPercent: stat.CPUPerc
              ? parseFloat(String(stat.CPUPerc).replace("%", ""))
              : undefined,
          });
        } catch {
          resolve(undefined);
        }
      });

      // Timeout after 5s
      timeoutId = setTimeout(() => {
        proc.kill();
        resolve(undefined);
      }, 5000);
    });
  }

  /**
   * Parse memory string like "123.4MiB" or "1.2GiB" to MB
   */
  parseMemoryString(memStr: string | undefined): number | undefined {
    if (!memStr) return undefined;

    // Handle "used / limit" format (e.g., "256MiB / 512MiB")
    const parts = memStr.split("/");
    const valueStr = parts[0].trim();

    const match = /^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)/i.exec(valueStr);
    if (!match) return undefined;

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "b":
        return value / (1024 * 1024);
      case "kb":
      case "kib":
        return value / 1024;
      case "mb":
      case "mib":
        return value;
      case "gb":
      case "gib":
        return value * 1024;
      default:
        return undefined;
    }
  }

  /**
   * Start a container in detached mode. Returns immediately with container ID.
   */
  async startDetached(params: {
    sessionKey: string;
    prompt: string;
    claudeDir: string;
    workspaceDir: string;
    resumeSessionId?: string;
    apiKey?: string;
    hostCredsPath?: string;
  }): Promise<DetachedStartResult> {
    const containerName = `claude-${params.sessionKey.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // Clean up stale container from previous run
    await this.killContainer(params.sessionKey);

    // Build the claude command
    const resumeFlag = params.resumeSessionId ? `--resume '${params.resumeSessionId}'` : "";
    const escapedPrompt = params.prompt.replace(/'/g, "'\\''");
    const claudeCmd = `claude --print --dangerously-skip-permissions ${resumeFlag} -p '${escapedPrompt}' < /dev/null 2>&1`;

    const args = [
      "run",
      "--detach",
      "--name",
      containerName,
      "--network",
      this.config.network,
      "--cap-drop",
      "ALL",
    ];

    if (this.config.apparmorProfile) {
      args.push("--security-opt", `apparmor=${this.config.apparmorProfile}`);
    }

    args.push(
      "--memory",
      this.config.memory,
      "--cpus",
      this.config.cpus,
      "--pids-limit",
      "100",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "-v",
      `${params.claudeDir}:/home/claude/.claude:U`,
      "-v",
      `${params.workspaceDir}:/workspace:U`
    );

    // Mount host credentials file as read-only overlay (after .claude dir mount)
    if (params.hostCredsPath) {
      args.push("-v", `${params.hostCredsPath}:/home/claude/.claude/.credentials.json:ro`);
    }

    if (params.apiKey) {
      args.push("-e", `ANTHROPIC_API_KEY=${params.apiKey}`);
    }

    args.push("-w", "/workspace", "--entrypoint", "/bin/bash", this.config.image, "-c", claudeCmd);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.runtime, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn ${this.config.runtime}: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to start container: ${stderr || stdout}`));
          return;
        }
        const containerId = stdout.trim();
        resolve({ containerName, containerId });
      });
    });
  }

  /**
   * Get the status of a container by name.
   */
  async getContainerStatus(containerName: string): Promise<ContainerStatus | null> {
    return new Promise((resolve) => {
      const proc = spawn(this.config.runtime, ["inspect", "--format", "json", containerName], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      let stdout = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const parsed: unknown = JSON.parse(stdout);
          const inspectArray = Array.isArray(parsed) ? parsed : [parsed];
          const inspect: unknown = inspectArray[0];

          if (!isPodmanInspectOutput(inspect) || !inspect.State) {
            resolve(null);
            return;
          }

          const state = inspect.State;
          resolve({
            running: state.Running ?? false,
            exitCode: state.ExitCode ?? null,
            startedAt: state.StartedAt ?? null,
            finishedAt: state.FinishedAt ?? null,
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Get logs from a container.
   */
  async getContainerLogs(
    containerName: string,
    opts?: { since?: string; tail?: number }
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const args = ["logs"];

      if (opts?.since) {
        args.push("--since", opts.since);
      }
      if (opts?.tail !== undefined) {
        args.push("--tail", String(opts.tail));
      }

      args.push(containerName);

      const proc = spawn(this.config.runtime, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      proc.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        resolve(output);
      });
    });
  }

  /**
   * List all containers matching a name prefix.
   */
  async listContainersByPrefix(prefix: string): Promise<ContainerInfo[]> {
    return new Promise((resolve) => {
      const proc = spawn(
        this.config.runtime,
        ["ps", "-a", "--filter", `name=^${prefix}`, "--format", "json"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );

      let stdout = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("error", () => resolve([]));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve([]);
          return;
        }

        try {
          // Podman outputs one JSON object per line
          const lines = stdout.trim().split("\n").filter(Boolean);
          const containers: ContainerInfo[] = [];

          for (const line of lines) {
            const parsed: unknown = JSON.parse(line);
            if (!isPodmanPsOutput(parsed)) continue;

            const name = Array.isArray(parsed.Names) ? parsed.Names[0] : parsed.Names;
            if (!name) continue;

            const running =
              parsed.State === "running" ||
              (typeof parsed.Status === "string" && parsed.Status.startsWith("Up"));

            containers.push({
              name,
              running,
              createdAt: parsed.Created ?? parsed.CreatedAt ?? "",
            });
          }

          resolve(containers);
        } catch {
          resolve([]);
        }
      });
    });
  }

  /**
   * Generate container name from session key.
   */
  containerNameFromSessionKey(sessionKey: string): string {
    return `claude-${sessionKey.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  }

  /**
   * Extract session key from container name.
   */
  sessionKeyFromContainerName(containerName: string): string | null {
    if (!containerName.startsWith("claude-")) {
      return null;
    }
    return containerName.slice(7); // Remove "claude-" prefix
  }
}
