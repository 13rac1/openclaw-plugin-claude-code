import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PodmanConfig } from "./podman-runner";
import { PodmanRunner } from "./podman-runner";
import { execSync } from "node:child_process";

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
