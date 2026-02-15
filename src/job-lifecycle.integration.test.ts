import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PodmanRunner } from "./podman-runner.js";
import { SessionManager } from "./session-manager.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Integration tests for async job lifecycle.
 *
 * These tests require Podman to be installed and running.
 * Run with: npm run test:integration
 */
describe("Job Lifecycle Integration", () => {
  let podman: PodmanRunner;
  let sessionManager: SessionManager;
  let tempDir: string;

  beforeAll(async () => {
    // Create temp directories for test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    podman = new PodmanRunner({
      runtime: "podman",
      image: "alpine:latest",
      memory: "64m",
      cpus: "0.5",
      pidsLimit: 100,
      network: "none",
      apparmorProfile: "",
      startupTimeout: 10,
      idleTimeout: 30,
      maxOutputSize: 0,
    });

    sessionManager = new SessionManager({
      sessionsDir: path.join(tempDir, "sessions"),
      workspacesDir: path.join(tempDir, "workspaces"),
      idleTimeout: 3600,
    });
  });

  afterAll(async () => {
    // Clean up temp directories
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe("PodmanRunner container name helpers", () => {
    it("generates container name from session key", () => {
      const containerName = podman.containerNameFromSessionKey("my-session");
      expect(containerName).toBe("claude-my-session");
    });

    it("sanitizes special characters in session key", () => {
      const containerName = podman.containerNameFromSessionKey("my_session.test@123");
      expect(containerName).toBe("claude-my-session-test-123");
    });

    it("extracts session key from container name", () => {
      const sessionKey = podman.sessionKeyFromContainerName("claude-my-session");
      expect(sessionKey).toBe("my-session");
    });

    it("returns null for non-claude container names", () => {
      expect(podman.sessionKeyFromContainerName("random-container")).toBeNull();
      expect(podman.sessionKeyFromContainerName("other-prefix-session")).toBeNull();
    });

    it("returns empty string for claude- prefix only", () => {
      // Edge case: "claude-" with nothing after returns empty string
      expect(podman.sessionKeyFromContainerName("claude-")).toBe("");
    });
  });

  describe("SessionManager job tracking", () => {
    it("creates and retrieves jobs", async () => {
      await sessionManager.createSession("job-test");

      const job = await sessionManager.createJob("job-test", {
        prompt: "test prompt",
        containerName: "test-container",
      });

      expect(job.jobId).toBeTruthy();
      expect(job.status).toBe("pending");
      expect(job.prompt).toBe("test prompt");

      const retrieved = await sessionManager.getJob("job-test", job.jobId);
      expect(retrieved).toEqual(job);
    });

    it("updates job status", async () => {
      await sessionManager.createSession("job-update-test");

      const job = await sessionManager.createJob("job-update-test", {
        prompt: "update test",
        containerName: "update-container",
      });

      const updated = await sessionManager.updateJob("job-update-test", job.jobId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      expect(updated.status).toBe("running");
      expect(updated.startedAt).toBeTruthy();
    });

    it("tracks active job", async () => {
      await sessionManager.createSession("active-job-test");

      const job = await sessionManager.createJob("active-job-test", {
        prompt: "active job test",
        containerName: "active-container",
      });

      await sessionManager.setActiveJob("active-job-test", job.jobId);

      const activeJob = await sessionManager.getActiveJob("active-job-test");
      expect(activeJob).not.toBeNull();
      expect(activeJob?.jobId).toBe(job.jobId);
    });

    it("reads and appends job output", async () => {
      await sessionManager.createSession("output-test");

      const job = await sessionManager.createJob("output-test", {
        prompt: "output test",
        containerName: "output-container",
      });

      await sessionManager.appendJobOutput("output-test", job.jobId, "First chunk\n");
      await sessionManager.appendJobOutput("output-test", job.jobId, "Second chunk\n");

      const output = await sessionManager.readJobOutput("output-test", job.jobId);
      expect(output.content).toBe("First chunk\nSecond chunk\n");
      expect(output.totalSize).toBe(25);
      expect(output.hasMore).toBe(false);
    });

    it("supports offset and limit for output reading", async () => {
      await sessionManager.createSession("pagination-test");

      const job = await sessionManager.createJob("pagination-test", {
        prompt: "pagination test",
        containerName: "pagination-container",
      });

      const content = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      await sessionManager.appendJobOutput("pagination-test", job.jobId, content);

      // Read first 10 bytes
      const first = await sessionManager.readJobOutput("pagination-test", job.jobId, {
        offset: 0,
        limit: 10,
      });
      expect(first.content).toBe("ABCDEFGHIJ");
      expect(first.hasMore).toBe(true);

      // Read next 10 bytes
      const second = await sessionManager.readJobOutput("pagination-test", job.jobId, {
        offset: 10,
        limit: 10,
      });
      expect(second.content).toBe("KLMNOPQRST");
      expect(second.hasMore).toBe(true);

      // Read remaining
      const third = await sessionManager.readJobOutput("pagination-test", job.jobId, {
        offset: 20,
        limit: 10,
      });
      expect(third.content).toBe("UVWXYZ");
      expect(third.hasMore).toBe(false);
    });

    it("lists jobs for a session", async () => {
      await sessionManager.createSession("list-jobs-test");

      await sessionManager.createJob("list-jobs-test", {
        prompt: "job 1",
        containerName: "container-1",
      });

      await sessionManager.createJob("list-jobs-test", {
        prompt: "job 2",
        containerName: "container-2",
      });

      const jobs = await sessionManager.listJobs("list-jobs-test");
      expect(jobs.length).toBe(2);

      const prompts = jobs.map((j) => j.prompt);
      expect(prompts).toContain("job 1");
      expect(prompts).toContain("job 2");
    });
  });
});
