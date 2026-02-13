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

async function main() {
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
    console.error("Build it with: podman build -t openclaw-claude-code:latest -f roles/podman/templates/Dockerfile.claude-code.j2 .");
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

  // Write credentials to session directory if we have them from keychain
  if (credentials) {
    const credsPath = path.join(claudeDir, ".credentials.json");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(credsPath, credentials);
    console.log("✓ Wrote credentials to:", credsPath);
    console.log("");
  }

  // Run Claude Code
  const prompt = "Say 'Hello from test harness!' and nothing else";
  console.log("=== Running Claude Code ===");
  console.log("Prompt:", prompt);
  console.log("");

  const startTime = Date.now();

  try {
    const result = await podmanRunner.runClaudeCode({
      sessionKey,
      prompt,
      claudeDir,
      workspaceDir,
      resumeSessionId: session.claudeSessionId ?? undefined,
      apiKey: credentials ? undefined : process.env.ANTHROPIC_API_KEY,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=== Result ===");
    console.log("Exit code:", result.exitCode);
    console.log("Session ID:", result.sessionId);
    console.log("Elapsed:", elapsed, "s");
    console.log("Content:");
    console.log("---");
    console.log(result.content);
    console.log("---");
    console.log("\n✓ SUCCESS");
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=== Error ===");
    console.log("Message:", err.message);
    console.log("Error type:", err.errorType || "unknown");
    console.log("Elapsed:", elapsed, "s");
    console.log("\n✗ FAILED");
    process.exit(1);
  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    await sessionManager.deleteSession(sessionKey);
    console.log("✓ Session deleted");
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
