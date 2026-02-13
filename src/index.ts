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
};

/**
 * OpenClaw Plugin API interface
 */
interface PluginApi {
  config: Record<string, unknown>;
  registerTool(config: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
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
  });

  // Register the claude-code tool
  api.registerTool({
    name: "claude_code",
    description:
      "Execute a prompt using Claude Code CLI in an isolated container. " +
      "Use this for complex coding tasks that benefit from Claude Code's " +
      "file editing, shell execution, and project understanding capabilities.",
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

      const sessionKey = (params.session_id as string) || `session-${id}`;

      // Check for authentication (credentials file preferred over API key)
      // This allows using OAuth/Claude Max even when ANTHROPIC_API_KEY is set
      const hostCredsPath = path.join(homedir(), ".claude", ".credentials.json");
      let hasCredsFile = false;

      try {
        await fs.access(hostCredsPath);
        hasCredsFile = true;
      } catch {
        // No credentials file
      }

      // Only use API key if no credentials file exists
      const apiKey = hasCredsFile ? undefined : process.env.ANTHROPIC_API_KEY;
      const authMethod = hasCredsFile ? "oauth" : "api_key";

      if (!apiKey && !hasCredsFile) {
        throw new Error(
          "No authentication available. Set ANTHROPIC_API_KEY or have ~/.claude/.credentials.json"
        );
      }

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

      // Get paths for volume mounts
      const claudeDir = `${config.sessionsDir.replace("~", process.env.HOME || "")}/${sessionKey}/.claude`;
      const workspaceDir = sessionManager.workspaceDir(sessionKey);

      // Copy credentials file to session's .claude directory if it exists
      if (hasCredsFile) {
        const sessionCredsPath = path.join(claudeDir, ".credentials.json");
        try {
          await fs.mkdir(claudeDir, { recursive: true });
          await fs.copyFile(hostCredsPath, sessionCredsPath);
        } catch (err) {
          throw new Error(`Failed to copy credentials file: ${err}`);
        }
      }

      // Execute Claude Code in container
      const result = await podmanRunner.runClaudeCode({
        sessionKey,
        prompt,
        claudeDir,
        workspaceDir,
        resumeSessionId: session.claudeSessionId ?? undefined,
        apiKey: apiKey ?? undefined,
      });

      // Update session with new Claude session ID
      await sessionManager.updateSession(sessionKey, result.sessionId);

      // Include auth method in response for transparency
      const authInfo = `[auth: ${authMethod}]`;
      return {
        content: [{ type: "text", text: `${authInfo}\n\n${result.content}` }],
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
          : `Cleaned up ${deleted.length} idle session(s): ${deleted.join(", ")}`;

      return {
        content: [{ type: "text", text }],
      };
    },
  });
}

// Also export components for testing
export { SessionManager } from "./session-manager.js";
export { PodmanRunner } from "./podman-runner.js";
