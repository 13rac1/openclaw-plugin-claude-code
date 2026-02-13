import { spawn, ChildProcess } from "node:child_process";

export interface PodmanConfig {
  runtime: string;
  image: string;
  startupTimeout: number; // Seconds to wait for first output
  idleTimeout: number; // Seconds with no output = hung
  memory: string;
  cpus: string;
  network: string;
  apparmorProfile?: string; // AppArmor profile name (empty = disabled)
}

export type ErrorType =
  | "startup_timeout"
  | "idle_timeout"
  | "oom"
  | "crash"
  | "spawn_failed";

export interface ClaudeCodeResult {
  content: string;
  sessionId: string | null;
  exitCode: number;
  elapsedSeconds?: number;
  errorType?: ErrorType;
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
    },
    containerName: string
  ): string[] {
    // Build the claude command to run inside bash
    // Claude doesn't output when run as PID 1, must run through bash
    const resumeFlag = params.resumeSessionId
      ? `--resume '${params.resumeSessionId}'`
      : "";
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

    // Only add API key if provided (otherwise uses credentials file)
    if (params.apiKey) {
      args.push("-e", `ANTHROPIC_API_KEY=${params.apiKey}`);
    }

    args.push(
      "-w",
      "/workspace",
      "--entrypoint",
      "/bin/bash",
      this.config.image,
      "-c",
      claudeCmd
    );

    return args;
  }

  private execute(
    args: string[],
    containerName: string
  ): Promise<ClaudeCodeResult> {
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

      const cleanup = () => {
        clearTimeout(startupTimeoutId);
        clearInterval(idleCheckInterval);
      };

      const killProcess = (reason: ErrorType) => {
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

      const onOutput = () => {
        if (!hadOutput) {
          hadOutput = true;
          clearTimeout(startupTimeoutId);
        }
        lastActivity = Date.now();
      };

      proc.stdout.on("data", (data: Buffer) => {
        onOutput();
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        onOutput();
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        cleanup();
        const elapsed = (Date.now() - startTime) / 1000;
        reject(
          Object.assign(
            new Error(
              `Failed to spawn ${this.config.runtime}: ${err.message}`
            ),
            { errorType: "spawn_failed" as ErrorType, elapsedSeconds: elapsed }
          )
        );
      });

      proc.on("close", (code, signal) => {
        cleanup();
        const elapsed = (Date.now() - startTime) / 1000;

        if (killed && killReason) {
          const message =
            killReason === "startup_timeout"
              ? `Container startup timeout (no output for ${this.config.startupTimeout}s)`
              : `Container idle timeout (no output for ${this.config.idleTimeout}s) after ${elapsed.toFixed(1)}s total`;
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
                `Container failed (exit ${code}) after ${elapsed.toFixed(1)}s: ${stderr || stdout}`
              ),
              { errorType: "crash" as ErrorType, elapsedSeconds: elapsed }
            )
          );
          return;
        }

        const result = this.parseOutput(stdout, code ?? 0);
        result.elapsedSeconds = elapsed;
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
          const parsed = JSON.parse(line);
          return {
            content: parsed.result || parsed.content || parsed.message || output,
            sessionId: parsed.session_id || parsed.sessionId || null,
            exitCode,
          };
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
      const proc = spawn(
        this.config.runtime,
        ["image", "exists", this.config.image],
        {
          stdio: "ignore",
        }
      );

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

  async verifyContainerRunning(
    containerName: string,
    retries = 3
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const exists = await new Promise<boolean>((resolve) => {
        const proc = spawn(
          this.config.runtime,
          ["container", "exists", containerName],
          {
            stdio: "ignore",
          }
        );
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
      if (exists) return true;
    }
    return false;
  }
}
