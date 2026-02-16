#!/usr/bin/env npx tsx
/**
 * Test harness for the Claude Code plugin
 * Runs the actual plugin code against a real container
 *
 * Usage:
 *   npx tsx src/test-harness.ts
 */

import { PodmanRunner } from "./podman-runner.js";
import { SessionManager } from "./session-manager.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

async function main(): Promise<void> {
  console.log("=== Claude Code Plugin Test Harness ===\n");

  // Configuration matching plugin defaults
  const config = {
    runtime: "podman",
    image: "openclaw-claude-code:latest",
    startupTimeout: 30,
    idleTimeout: 120,
    memory: "512m",
    cpus: "1.0",
    network: "bridge",
    maxOutputSize: 10 * 1024 * 1024, // 10MB
  };

  const sessionConfig = {
    sessionsDir: `${homedir()}/.cache/claude-plugin-harness/sessions`,
    workspacesDir: `${homedir()}/.cache/claude-plugin-harness/workspaces`,
    idleTimeout: 3600,
  };

  console.log("Config:", JSON.stringify(config, null, 2));
  console.log("Session config:", JSON.stringify(sessionConfig, null, 2));
  console.log("");

  // Initialize components
  const podmanRunner = new PodmanRunner(config);
  const sessionManager = new SessionManager(sessionConfig);

  // Check image exists
  console.log("Checking container image...");
  const imageExists = await podmanRunner.checkImage();
  if (!imageExists) {
    console.error(`ERROR: Image ${config.image} not found`);
    console.error(
      "Build it with: podman build -t openclaw-claude-code:latest -f roles/podman/templates/Dockerfile.claude-code.j2 ."
    );
    process.exit(1);
  }
  console.log("✓ Image exists\n");

  // Get credentials from macOS keychain
  console.log("Getting credentials...");
  let credentials: string | undefined;
  try {
    credentials = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8" }
    ).trim();
    console.log("✓ Got credentials from macOS keychain\n");
  } catch {
    console.log("No keychain credentials, checking for API key...");
    if (process.env.ANTHROPIC_API_KEY) {
      console.log("✓ Using ANTHROPIC_API_KEY\n");
    } else {
      console.error("ERROR: No authentication available");
      console.error("Run 'claude' interactively first or set ANTHROPIC_API_KEY");
      process.exit(1);
    }
  }

  // Create/get session
  const sessionKey = "test-harness-session";
  console.log(`Creating session: ${sessionKey}`);
  const session = await sessionManager.getOrCreateSession(sessionKey);
  console.log("✓ Session created:", session);
  console.log("");

  // Get paths (claudeDir is private, so compute it directly)
  const claudeDir = path.join(sessionConfig.sessionsDir, sessionKey, ".claude");
  const workspaceDir = sessionManager.workspaceDir(sessionKey);
  console.log("Claude dir:", claudeDir);
  console.log("Workspace dir:", workspaceDir);
  console.log("");

  // Copy credentials to session directory (with --userns=keep-id, we can write to the dir)
  if (credentials) {
    const hostCredsPath = path.join(homedir(), ".claude", ".credentials.json");
    const sessionCredsPath = path.join(claudeDir, ".credentials.json");
    console.log(`Copying credentials from ${hostCredsPath} to ${sessionCredsPath}`);
    await fs.copyFile(hostCredsPath, sessionCredsPath);
  }

  // Run Claude Code (async)
  const prompt = "Say 'Hello from test harness!' and nothing else";
  console.log("=== Running Claude Code (async) ===");
  console.log("Prompt:", prompt);
  console.log("");

  const startTime = Date.now();

  try {
    // Start container in detached mode
    const { containerName } = await podmanRunner.startDetached({
      sessionKey,
      prompt,
      claudeDir,
      workspaceDir,
      resumeSessionId: session.claudeSessionId ?? undefined,
      apiKey: credentials ? undefined : process.env.ANTHROPIC_API_KEY,
    });
    console.log("✓ Container started:", containerName);

    // Poll for completion
    let status = await podmanRunner.getContainerStatus(containerName);
    while (status?.running) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
      status = await podmanRunner.getContainerStatus(containerName);
    }
    console.log(" done");

    // Get output
    const output = await podmanRunner.getContainerLogs(containerName);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=== Result ===");
    console.log("Exit code:", status?.exitCode ?? "unknown");
    console.log("Elapsed:", elapsed, "s");
    console.log("Content:");
    console.log("---");
    console.log(output ?? "(no output)");
    console.log("---");

    if (status?.exitCode === 0) {
      console.log("\n✓ SUCCESS");
    } else {
      console.log("\n✗ FAILED (exit code:", status?.exitCode, ")");
      process.exit(1);
    }
  } catch (err: unknown) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=== Error ===");
    const message = err instanceof Error ? err.message : String(err);
    console.log("Message:", message);
    console.log("Elapsed:", elapsed, "s");
    console.log("\n✗ FAILED");
    process.exit(1);
  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    await podmanRunner.killContainer(sessionKey);
    await sessionManager.deleteSession(sessionKey);
    console.log("✓ Session deleted");
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
