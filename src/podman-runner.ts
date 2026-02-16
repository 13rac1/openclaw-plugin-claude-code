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
   * Credentials should be copied to claudeDir before calling this method.
   */
  async startDetached(params: {
    sessionKey: string;
    prompt: string;
    claudeDir: string;
    workspaceDir: string;
    resumeSessionId?: string;
    apiKey?: string;
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
      "--userns=keep-id",
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
      `${params.claudeDir}:/home/claude/.claude:rw`,
      "-v",
      `${params.workspaceDir}:/workspace:rw`
    );

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
