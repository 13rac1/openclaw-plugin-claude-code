import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PodmanConfig } from "./podman-runner";
import { PodmanRunner } from "./podman-runner";
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Integration tests for PodmanRunner.
 * These tests require podman to be installed and running.
 * They are skipped if podman is not available.
 */

const config: PodmanConfig = {
  runtime: "podman",
  image: "docker.io/library/alpine:latest",
  timeout: 30,
  memory: "128m",
  cpus: "0.5",
  network: "none",
};

function isPodmanAvailable(): boolean {
  try {
    execSync("podman --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const podmanAvailable = isPodmanAvailable();

describe.skipIf(!podmanAvailable)("PodmanRunner (integration)", () => {
  let runner: PodmanRunner;

  beforeAll(async () => {
    runner = new PodmanRunner(config);

    // Pull the test image if not present
    try {
      execSync(`podman pull ${config.image}`, { stdio: "ignore" });
    } catch {
      // Image might already exist or pull failed - checkImage will handle it
    }
  });

  describe("checkImage", () => {
    it("returns true for existing image", async () => {
      const exists = await runner.checkImage();
      expect(exists).toBe(true);
    });

    it("returns false for non-existent image", async () => {
      const nonExistentRunner = new PodmanRunner({
        ...config,
        image: "this-image-does-not-exist:never",
      });
      const exists = await nonExistentRunner.checkImage();
      expect(exists).toBe(false);
    });
  });

  describe("killContainer", () => {
    it("resolves successfully even for non-existent container", async () => {
      // Should not throw
      await expect(runner.killContainer("non-existent-session-12345")).resolves.toBeUndefined();
    });
  });
});

describe.skipIf(!podmanAvailable)("PodmanRunner container execution (integration)", () => {
  const testImage = "docker.io/library/alpine:latest";
  let containerName: string;

  beforeAll(() => {
    containerName = `test-integration-${Date.now()}`;
  });

  afterAll(async () => {
    // Clean up any leftover containers
    try {
      execSync(`podman rm -f ${containerName}`, { stdio: "ignore" });
    } catch {
      // Container might not exist
    }
  });

  it("can run a simple command in a container", async () => {
    const result = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      const proc = require("node:child_process").spawn("podman", [
        "run",
        "--rm",
        "--name",
        containerName,
        testImage,
        "echo",
        "hello from container",
      ]);

      let stdout = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        resolve({ stdout: stdout.trim(), exitCode: code });
      });
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from container");
  });

  it("respects memory limits", async () => {
    // Run a container with memory limit and verify it starts
    const result = await new Promise<number>((resolve, reject) => {
      const proc = require("node:child_process").spawn("podman", [
        "run",
        "--rm",
        "--memory",
        "64m",
        testImage,
        "cat",
        "/sys/fs/cgroup/memory.max",
      ]);

      let stdout = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("error", reject);
      proc.on("close", () => {
        // Memory limit should be approximately 64MB (67108864 bytes)
        const limit = parseInt(stdout.trim(), 10);
        resolve(limit);
      });
    });

    // 64MB = 67108864 bytes, allow some variance
    expect(result).toBeGreaterThan(60000000);
    expect(result).toBeLessThan(70000000);
  });

  it("enforces network isolation", async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const proc = require("node:child_process").spawn("podman", [
        "run",
        "--rm",
        "--network",
        "none",
        testImage,
        "ping",
        "-c",
        "1",
        "-W",
        "1",
        "8.8.8.8",
      ]);

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        resolve(code);
      });
    });

    // Ping should fail with network=none
    expect(result).not.toBe(0);
  });
});

/**
 * Test that credentials file overlay mount works correctly.
 * This specifically tests the bug where resumed sessions lose credentials.
 */
describe.skipIf(!podmanAvailable)("Credentials overlay mount (integration)", () => {
  const testImage = "docker.io/library/alpine:latest";
  let tempDir: string;
  let credsFile: string;
  let sessionDir: string;

  beforeEach(async () => {
    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "creds-test-"));
    credsFile = path.join(tempDir, "credentials.json");
    sessionDir = path.join(tempDir, "session-claude");

    // Create a fake credentials file
    await fs.writeFile(credsFile, JSON.stringify({ token: "test-oauth-token-12345" }));

    // Create session .claude directory
    await fs.mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("credentials file is accessible with overlay mount", async () => {
    // Run container with directory mount + file overlay mount (like the plugin does)
    const result = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      const proc = spawn("podman", [
        "run",
        "--rm",
        "-v",
        `${sessionDir}:/home/test/.config:U`,
        "-v",
        `${credsFile}:/home/test/.config/credentials.json:ro`,
        testImage,
        "cat",
        "/home/test/.config/credentials.json",
      ]);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        if (code !== 0) {
          console.error("First run stderr:", stderr);
        }
        resolve({ stdout: stdout.trim(), exitCode: code });
      });
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-oauth-token-12345");
  });

  it("credentials remain accessible after session directory is modified", async () => {
    // First run - this will change ownership of sessionDir due to :U flag
    const firstRun = await new Promise<{ exitCode: number }>((resolve, reject) => {
      const proc = spawn("podman", [
        "run",
        "--rm",
        "-v",
        `${sessionDir}:/home/test/.config:U`,
        "-v",
        `${credsFile}:/home/test/.config/credentials.json:ro`,
        testImage,
        "sh",
        "-c",
        // Write something to the config dir (like Claude Code would do)
        "echo 'session data' > /home/test/.config/session.txt && cat /home/test/.config/credentials.json",
      ]);

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        resolve({ exitCode: code });
      });
    });

    expect(firstRun.exitCode).toBe(0);

    // Second run - simulates resumed session
    const secondRun = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      const proc = spawn("podman", [
        "run",
        "--rm",
        "-v",
        `${sessionDir}:/home/test/.config:U`,
        "-v",
        `${credsFile}:/home/test/.config/credentials.json:ro`,
        testImage,
        "cat",
        "/home/test/.config/credentials.json",
      ]);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        if (code !== 0) {
          console.error("Second run stderr:", stderr);
        }
        resolve({ stdout: stdout.trim(), exitCode: code });
      });
    });

    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.stdout).toContain("test-oauth-token-12345");
  });

  it("credentials accessible even when session creates same filename", async () => {
    // First run - create a credentials.json file in the session dir
    const firstRun = await new Promise<{ exitCode: number }>((resolve, reject) => {
      const proc = spawn("podman", [
        "run",
        "--rm",
        "-v",
        `${sessionDir}:/home/test/.config:U`,
        // Note: no credentials overlay on first run
        testImage,
        "sh",
        "-c",
        // Create a fake credentials file in the session dir
        'echo \'{"token": "wrong-token"}\' > /home/test/.config/credentials.json',
      ]);

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        resolve({ exitCode: code });
      });
    });

    expect(firstRun.exitCode).toBe(0);

    // Note: The first run created a credentials.json in the session dir.
    // This might not be visible to host due to :U ownership change.
    // We're testing that the overlay mount takes precedence in the container.

    // Second run - with overlay mount, should see the HOST credentials
    const secondRun = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      const proc = spawn("podman", [
        "run",
        "--rm",
        "-v",
        `${sessionDir}:/home/test/.config:U`,
        "-v",
        `${credsFile}:/home/test/.config/credentials.json:ro`,
        testImage,
        "cat",
        "/home/test/.config/credentials.json",
      ]);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code: number) => {
        if (code !== 0) {
          console.error("With overlay stderr:", stderr);
        }
        resolve({ stdout: stdout.trim(), exitCode: code });
      });
    });

    expect(secondRun.exitCode).toBe(0);
    // The overlay mount should take precedence over the session's file
    expect(secondRun.stdout).toContain("test-oauth-token-12345");
    expect(secondRun.stdout).not.toContain("wrong-token");
  });
});
