import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PodmanConfig } from "./podman-runner";
import { PodmanRunner } from "./podman-runner";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function createMockProcess(): ChildProcess & { killed: boolean } {
  const proc = new EventEmitter() as ChildProcess & { killed: boolean };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  // Increase max listeners to avoid warnings in tests
  proc.setMaxListeners(20);
  stdout.setMaxListeners(20);
  stderr.setMaxListeners(20);

  proc.stdout = stdout as NodeJS.ReadableStream;
  proc.stderr = stderr as NodeJS.ReadableStream;
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as NodeJS.WritableStream;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

describe("PodmanRunner", () => {
  const config: PodmanConfig = {
    runtime: "podman",
    image: "openclaw-claude-code:latest",
    startupTimeout: 30,
    idleTimeout: 120,
    memory: "512m",
    cpus: "1.0",
    network: "none",
    maxOutputSize: 0, // Unlimited by default for existing tests
  };

  let runner: PodmanRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runner = new PodmanRunner(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("buildArgs", () => {
    it("builds correct args without resume session", () => {
      const args = (runner as any).buildArgs(
        {
          sessionKey: "test-session",
          prompt: "Hello world",
          claudeDir: "/home/user/.openclaw/sessions/test/.claude",
          workspaceDir: "/home/user/.openclaw/workspaces/test",
          apiKey: "sk-test-key",
        },
        "claude-test-session"
      );

      expect(args).toContain("run");
      expect(args).toContain("--rm");
      expect(args).toContain("--name");
      expect(args).toContain("claude-test-session");
      expect(args).toContain("--network");
      expect(args).toContain("none");
      expect(args).toContain("--cap-drop");
      expect(args).toContain("ALL");
      expect(args).toContain("--memory");
      expect(args).toContain("512m");
      expect(args).toContain("--cpus");
      expect(args).toContain("1.0");
      expect(args).toContain("--pids-limit");
      expect(args).toContain("100");
      expect(args).toContain("--entrypoint");
      expect(args).toContain("/bin/bash");
      expect(args).toContain("-c");

      // Check the bash command includes the prompt
      const bashCmd = args[args.length - 1];
      expect(bashCmd).toContain("claude --print --dangerously-skip-permissions");
      expect(bashCmd).toContain("-p 'Hello world'");
      expect(bashCmd).toContain("< /dev/null");
      expect(bashCmd).not.toContain("--resume");
    });

    it("builds correct args with resume session", () => {
      const args = (runner as any).buildArgs(
        {
          sessionKey: "test-session",
          prompt: "Continue",
          claudeDir: "/home/user/.claude",
          workspaceDir: "/home/user/workspace",
          resumeSessionId: "abc123",
          apiKey: "sk-test-key",
        },
        "claude-test-session"
      );

      const bashCmd = args[args.length - 1];
      expect(bashCmd).toContain("--resume 'abc123'");
    });

    it("escapes single quotes in prompt", () => {
      const args = (runner as any).buildArgs(
        {
          sessionKey: "test-session",
          prompt: "It's a test with 'quotes'",
          claudeDir: "/home/user/.claude",
          workspaceDir: "/home/user/workspace",
          apiKey: "sk-test-key",
        },
        "claude-test-session"
      );

      const bashCmd = args[args.length - 1];
      expect(bashCmd).toContain("It'\\''s a test with '\\''quotes'\\''");
    });

    it("includes :U flag for volume mounts", () => {
      const args = (runner as any).buildArgs(
        {
          sessionKey: "test",
          prompt: "test",
          claudeDir: "/path/to/.claude",
          workspaceDir: "/path/to/workspace",
          apiKey: "sk-test-key",
        },
        "claude-test"
      );

      const volumeArgs = args.filter(
        (arg: string) => arg.includes(":/home/claude/.claude") || arg.includes(":/workspace")
      );
      expect(volumeArgs).toHaveLength(2);
      volumeArgs.forEach((arg: string) => {
        expect(arg).toMatch(/:U$/);
      });
    });
  });

  describe("parseOutput", () => {
    it("parses JSON output with result field", () => {
      const output = '{"result": "Hello!", "session_id": "abc123"}';
      const result = (runner as any).parseOutput(output, 0);

      expect(result).toEqual({
        content: "Hello!",
        sessionId: "abc123",
        exitCode: 0,
      });
    });

    it("parses JSON output with content field", () => {
      const output = '{"content": "Response", "sessionId": "xyz789"}';
      const result = (runner as any).parseOutput(output, 0);

      expect(result).toEqual({
        content: "Response",
        sessionId: "xyz789",
        exitCode: 0,
      });
    });

    it("returns raw output when not JSON", () => {
      const output = "Plain text response";
      const result = (runner as any).parseOutput(output, 0);

      expect(result).toEqual({
        content: "Plain text response",
        sessionId: null,
        exitCode: 0,
      });
    });

    it("handles multiline output with JSON on last line", () => {
      const output = 'Some debug output\nMore output\n{"result": "Final", "session_id": "sess1"}';
      const result = (runner as any).parseOutput(output, 0);

      expect(result).toEqual({
        content: "Final",
        sessionId: "sess1",
        exitCode: 0,
      });
    });

    it("handles invalid JSON gracefully", () => {
      const output = "{invalid json}";
      const result = (runner as any).parseOutput(output, 0);

      expect(result).toEqual({
        content: "{invalid json}",
        sessionId: null,
        exitCode: 0,
      });
    });

    it("preserves exit code", () => {
      const output = "error output";
      const result = (runner as any).parseOutput(output, 1);

      expect(result.exitCode).toBe(1);
    });
  });

  describe("execute", () => {
    it("spawns process without timeout option", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run", "--rm", "test"], "test-container");

      // Emit output synchronously before advancing timers
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output"));
      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith("podman", ["run", "--rm", "test"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.content).toBe("output");
    });

    it("collects stdout", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output synchronously
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("part1"));
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("part2"));
      mockProc.emit("close", 0);

      const result = await executePromise;
      expect(result.content).toBe("part1part2");
    });

    it("rejects on non-zero exit code with error type", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output synchronously to clear startup timeout
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("some output"));
      (mockProc.stderr as EventEmitter).emit("data", Buffer.from("error message"));
      mockProc.emit("close", 1);

      try {
        await executePromise;
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("Container failed (exit 1)");
        expect(err.errorType).toBe("crash");
      }
    });

    it("rejects on spawn error with error type", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit error synchronously
      mockProc.emit("error", new Error("spawn failed"));

      try {
        await executePromise;
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toBe("Failed to spawn podman: spawn failed");
        expect(err.errorType).toBe("spawn_failed");
      }
    });

    it("detects OOM kill (exit code 137)", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output synchronously
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output"));
      mockProc.emit("close", 137);

      try {
        await executePromise;
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("OOM or resource limit");
        expect(err.errorType).toBe("oom");
      }
    });

    it("includes elapsed time in successful result", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output to clear startup timeout
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output"));

      // Advance time before close
      vi.advanceTimersByTime(5000);

      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(result.elapsedSeconds).toBeDefined();
      expect(typeof result.elapsedSeconds).toBe("number");
    });
  });

  describe("startup timeout", () => {
    it("kills process if no output within startup timeout", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Advance past startup timeout (30s) without any output
      vi.advanceTimersByTime(31000);

      // Process should be killed
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");

      // Simulate process closing after being killed
      mockProc.emit("close", null, "SIGTERM");

      try {
        await executePromise;
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("startup timeout");
        expect(err.errorType).toBe("startup_timeout");
      }
    });

    it("clears startup timeout on first output", async () => {
      // Use mockImplementation to return new mock processes for metrics interval calls
      const mainProc = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mainProc;
        }
        // Return fresh mock for metrics interval stats calls
        const metricsProc = createMockProcess();
        setImmediate(() => metricsProc.emit("close", 1)); // Stats fail immediately
        return metricsProc;
      });

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output immediately (before any timer advancement)
      (mainProc.stdout as EventEmitter).emit("data", Buffer.from("output"));

      // Advance past startup timeout - should not kill because we already got output
      vi.advanceTimersByTime(35000);

      // Main process should NOT be killed (got output before timeout)
      expect(mainProc.kill).not.toHaveBeenCalled();

      // Complete normally
      mainProc.emit("close", 0);

      const result = await executePromise;
      expect(result.content).toBe("output");
    });
  });

  describe("idle timeout", () => {
    it("kills process if no output for idle timeout period", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit initial output (clears startup timeout)
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("initial"));

      // Advance past idle timeout (120s) without more output
      // Idle check runs every 5s, so we need to advance past 120s total idle time
      vi.advanceTimersByTime(125000);

      // Process should be killed
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");

      // Simulate process closing after being killed
      mockProc.emit("close", null, "SIGTERM");

      try {
        await executePromise;
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("idle timeout");
        expect(err.errorType).toBe("idle_timeout");
      }
    });

    it("resets idle timer on each output", async () => {
      // Use mockImplementation to return new mock processes for metrics interval calls
      const mainProc = createMockProcess();
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mainProc;
        }
        // Return fresh mock for metrics interval stats calls
        const metricsProc = createMockProcess();
        setImmediate(() => metricsProc.emit("close", 1)); // Stats fail immediately
        return metricsProc;
      });

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output and advance time in sequence
      (mainProc.stdout as EventEmitter).emit("data", Buffer.from("output1"));
      vi.advanceTimersByTime(60000); // 60s idle

      (mainProc.stdout as EventEmitter).emit("data", Buffer.from("output2"));
      vi.advanceTimersByTime(60000); // 60s idle

      (mainProc.stdout as EventEmitter).emit("data", Buffer.from("output3"));
      vi.advanceTimersByTime(60000); // 60s idle

      // Main process should NOT be killed (we kept getting output before 120s idle)
      expect(mainProc.kill).not.toHaveBeenCalled();

      // Complete normally
      mainProc.emit("close", 0);

      const result = await executePromise;
      expect(result.content).toBe("output1output2output3");
    });
  });

  describe("checkImage", () => {
    it("returns true when image exists", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const checkPromise = runner.checkImage();

      // Emit close synchronously
      mockProc.emit("close", 0);

      const result = await checkPromise;
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["image", "exists", "openclaw-claude-code:latest"],
        { stdio: "ignore" }
      );
    });

    it("returns false when image does not exist", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const checkPromise = runner.checkImage();

      mockProc.emit("close", 1);

      const result = await checkPromise;
      expect(result).toBe(false);
    });

    it("returns false on spawn error", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const checkPromise = runner.checkImage();

      mockProc.emit("error", new Error("podman not found"));

      const result = await checkPromise;
      expect(result).toBe(false);
    });
  });

  describe("killContainer", () => {
    it("kills and removes container with sanitized name", async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      const killPromise = runner.killContainer("user@123");

      // First process (kill) completes
      mockProc1.emit("close", 0);
      // Allow the promise chain to continue
      await Promise.resolve();
      // Second process (rm -f) completes
      mockProc2.emit("close", 0);

      await killPromise;

      expect(mockSpawn).toHaveBeenCalledWith("podman", ["kill", "claude-user-123"], {
        stdio: "ignore",
      });
      expect(mockSpawn).toHaveBeenCalledWith("podman", ["rm", "-f", "claude-user-123"], {
        stdio: "ignore",
      });
    });

    it("resolves even on error", async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      const killPromise = runner.killContainer("test");

      // First process (kill) errors
      mockProc1.emit("error", new Error("container not found"));
      // Allow the promise chain to continue
      await Promise.resolve();
      // Second process (rm -f) completes
      mockProc2.emit("close", 0);

      // Should not throw
      await expect(killPromise).resolves.toBeUndefined();
    });
  });

  describe("runClaudeCode", () => {
    it("cleans up stale container before running", async () => {
      // This test needs real timers due to complex async promise chains
      vi.useRealTimers();

      // Need 3 mock processes: kill, rm -f, and the actual run
      const mockKillProc = createMockProcess();
      const mockRmProc = createMockProcess();
      const mockRunProc = createMockProcess();

      mockSpawn
        .mockReturnValueOnce(mockKillProc)
        .mockReturnValueOnce(mockRmProc)
        .mockReturnValueOnce(mockRunProc);

      // Override config with short timeouts for the test
      const testRunner = new PodmanRunner({
        ...config,
        startupTimeout: 1,
        idleTimeout: 1,
        maxOutputSize: 0,
      });

      const runPromise = testRunner.runClaudeCode({
        sessionKey: "test-session",
        prompt: "Hello",
        claudeDir: "/path/.claude",
        workspaceDir: "/path/workspace",
        apiKey: "sk-key",
      });

      // Complete cleanup processes - use setImmediate to let promise chains settle
      mockKillProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));
      mockRmProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));

      // Run process emits output and completes
      (mockRunProc.stdout as EventEmitter).emit(
        "data",
        Buffer.from('{"result": "Hi!", "session_id": "new-sess"}')
      );
      mockRunProc.emit("close", 0);

      const result = await runPromise;

      // Verify cleanup was called
      expect(mockSpawn).toHaveBeenCalledWith("podman", ["kill", "claude-test-session"], {
        stdio: "ignore",
      });
      expect(mockSpawn).toHaveBeenCalledWith("podman", ["rm", "-f", "claude-test-session"], {
        stdio: "ignore",
      });

      expect(result.content).toBe("Hi!");
      expect(result.sessionId).toBe("new-sess");
      expect(result.exitCode).toBe(0);

      // Restore fake timers for subsequent tests
      vi.useFakeTimers();
    });
  });

  describe("verifyContainerRunning", () => {
    it("returns true when container exists", async () => {
      // This test needs real timers due to async promise chains with setTimeout
      vi.useRealTimers();

      const mockProc = createMockProcess();
      // Emit close right after spawn returns
      mockSpawn.mockImplementation(() => {
        setImmediate(() => mockProc.emit("close", 0));
        return mockProc;
      });

      const verifyPromise = runner.verifyContainerRunning("test-container", 1);
      const result = await verifyPromise;

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("podman", ["container", "exists", "test-container"], {
        stdio: "ignore",
      });

      vi.useFakeTimers();
    });

    it("retries and returns false after all retries fail", async () => {
      // This test needs real timers due to async promise chains with setTimeout
      vi.useRealTimers();

      const mockProcs = [createMockProcess(), createMockProcess(), createMockProcess()];

      // Use mockImplementation to emit close right after spawn returns
      let spawnCount = 0;
      mockSpawn.mockImplementation(() => {
        const proc = mockProcs[spawnCount];
        spawnCount++;
        // Schedule close to fire after listeners are set up
        setImmediate(() => proc.emit("close", 1));
        return proc;
      });

      const verifyPromise = runner.verifyContainerRunning("test-container", 3);
      const result = await verifyPromise;

      expect(result).toBe(false);
      expect(spawnCount).toBe(3);

      vi.useFakeTimers();
    });
  });

  describe("parseMemoryString", () => {
    it("parses MiB values", () => {
      expect((runner as any).parseMemoryString("256MiB")).toBe(256);
      expect((runner as any).parseMemoryString("512.5MiB")).toBeCloseTo(512.5);
    });

    it("parses MB values", () => {
      expect((runner as any).parseMemoryString("256MB")).toBe(256);
      expect((runner as any).parseMemoryString("100.5MB")).toBeCloseTo(100.5);
    });

    it("parses GiB values", () => {
      expect((runner as any).parseMemoryString("1GiB")).toBe(1024);
      expect((runner as any).parseMemoryString("2.5GiB")).toBe(2560);
    });

    it("parses KiB values", () => {
      expect((runner as any).parseMemoryString("1024KiB")).toBe(1);
      expect((runner as any).parseMemoryString("2048KiB")).toBe(2);
    });

    it("parses B values", () => {
      expect((runner as any).parseMemoryString("1048576B")).toBeCloseTo(1);
    });

    it("handles 'used / limit' format", () => {
      expect((runner as any).parseMemoryString("256MiB / 512MiB")).toBe(256);
    });

    it("returns undefined for invalid input", () => {
      expect((runner as any).parseMemoryString(undefined)).toBeUndefined();
      expect((runner as any).parseMemoryString("")).toBeUndefined();
      expect((runner as any).parseMemoryString("invalid")).toBeUndefined();
    });
  });

  describe("getContainerStats", () => {
    it("parses podman stats JSON output", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      (mockProc.stdout as EventEmitter).emit(
        "data",
        Buffer.from(
          JSON.stringify({
            MemUsage: "256MiB",
            MemLimit: "512MiB",
            MemPerc: "50.00%",
            CPUPerc: "25.00%",
          })
        )
      );
      mockProc.emit("close", 0);

      const result = await statsPromise;

      expect(result).toEqual({
        memoryUsageMB: 256,
        memoryLimitMB: 512,
        memoryPercent: 50,
        cpuPercent: 25,
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["stats", "--no-stream", "--format", "json", "test-container"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
    });

    it("parses array format stats output", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      (mockProc.stdout as EventEmitter).emit(
        "data",
        Buffer.from(
          JSON.stringify([
            {
              MemUsage: "128MiB",
              MemLimit: "256MiB",
              MemPerc: "50%",
              CPUPerc: "10%",
            },
          ])
        )
      );
      mockProc.emit("close", 0);

      const result = await statsPromise;

      expect(result).toEqual({
        memoryUsageMB: 128,
        memoryLimitMB: 256,
        memoryPercent: 50,
        cpuPercent: 10,
      });
    });

    it("returns undefined on error", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      mockProc.emit("error", new Error("container not found"));

      const result = await statsPromise;
      expect(result).toBeUndefined();
    });

    it("returns undefined on non-zero exit", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      mockProc.emit("close", 1);

      const result = await statsPromise;
      expect(result).toBeUndefined();
    });

    it("returns undefined on invalid JSON", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("not json"));
      mockProc.emit("close", 0);

      const result = await statsPromise;
      expect(result).toBeUndefined();
    });

    it("returns undefined on empty array", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const statsPromise = runner.getContainerStats("test-container");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("[]"));
      mockProc.emit("close", 0);

      const result = await statsPromise;
      expect(result).toBeUndefined();
    });
  });

  describe("output truncation", () => {
    it("truncates output when exceeding maxOutputSize", async () => {
      const limitedRunner = new PodmanRunner({
        ...config,
        maxOutputSize: 100,
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (limitedRunner as any).execute(["run"], "test-container");

      // Emit 150 bytes of output
      const largeOutput = "x".repeat(150);
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(largeOutput));
      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(result.content.length).toBe(100);
      expect(result.outputTruncated).toBe(true);
      expect(result.originalSize).toBe(150);
    });

    it("does not truncate when under limit", async () => {
      const limitedRunner = new PodmanRunner({
        ...config,
        maxOutputSize: 1000,
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (limitedRunner as any).execute(["run"], "test-container");

      const smallOutput = "x".repeat(100);
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(smallOutput));
      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(result.content.length).toBe(100);
      expect(result.outputTruncated).toBeUndefined();
      expect(result.originalSize).toBeUndefined();
    });

    it("does not truncate when maxOutputSize is 0 (unlimited)", async () => {
      const unlimitedRunner = new PodmanRunner({
        ...config,
        maxOutputSize: 0,
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (unlimitedRunner as any).execute(["run"], "test-container");

      const largeOutput = "x".repeat(10000);
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(largeOutput));
      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(result.content.length).toBe(10000);
      expect(result.outputTruncated).toBeUndefined();
    });

    it("tracks total size across multiple chunks", async () => {
      const limitedRunner = new PodmanRunner({
        ...config,
        maxOutputSize: 100,
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (limitedRunner as any).execute(["run"], "test-container");

      // Emit output in chunks
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("x".repeat(40)));
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("y".repeat(40)));
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("z".repeat(40))); // This exceeds limit
      mockProc.emit("close", 0);

      const result = await executePromise;

      expect(result.content.length).toBe(100);
      expect(result.outputTruncated).toBe(true);
      expect(result.originalSize).toBe(120);
    });

    it("truncates stderr when combined output exceeds limit", async () => {
      const limitedRunner = new PodmanRunner({
        ...config,
        maxOutputSize: 100,
      });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (limitedRunner as any).execute(["run"], "test-container");

      // Emit stdout then stderr
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("x".repeat(60)));
      (mockProc.stderr as EventEmitter).emit("data", Buffer.from("e".repeat(60)));
      mockProc.emit("close", 0);

      const result = await executePromise;

      // Total output should be truncated to 100 bytes
      expect(result.outputTruncated).toBe(true);
      expect(result.originalSize).toBe(120);
    });
  });

  describe("startDetached", () => {
    it("starts container in detached mode and returns container info", async () => {
      vi.useRealTimers();

      const mockKillProc = createMockProcess();
      const mockRmProc = createMockProcess();
      const mockRunProc = createMockProcess();

      mockSpawn
        .mockReturnValueOnce(mockKillProc)
        .mockReturnValueOnce(mockRmProc)
        .mockReturnValueOnce(mockRunProc);

      const promise = runner.startDetached({
        sessionKey: "test-session",
        prompt: "Hello world",
        claudeDir: "/path/.claude",
        workspaceDir: "/path/workspace",
        apiKey: "sk-test",
      });

      // Complete cleanup
      mockKillProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));
      mockRmProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));

      // Return container ID
      (mockRunProc.stdout as EventEmitter).emit("data", Buffer.from("abc123def456\n"));
      mockRunProc.emit("close", 0);

      const result = await promise;

      expect(result.containerName).toBe("claude-test-session");
      expect(result.containerId).toBe("abc123def456");

      // Verify detach flag was used
      const runCall = mockSpawn.mock.calls[2];
      expect(runCall[1]).toContain("--detach");

      vi.useFakeTimers();
    });

    it("rejects on spawn error", async () => {
      vi.useRealTimers();

      const mockKillProc = createMockProcess();
      const mockRmProc = createMockProcess();
      const mockRunProc = createMockProcess();

      mockSpawn
        .mockReturnValueOnce(mockKillProc)
        .mockReturnValueOnce(mockRmProc)
        .mockReturnValueOnce(mockRunProc);

      const promise = runner.startDetached({
        sessionKey: "test",
        prompt: "test",
        claudeDir: "/path/.claude",
        workspaceDir: "/path/workspace",
      });

      mockKillProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));
      mockRmProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));

      mockRunProc.emit("error", new Error("spawn failed"));

      await expect(promise).rejects.toThrow("Failed to spawn podman");

      vi.useFakeTimers();
    });

    it("rejects on non-zero exit code", async () => {
      vi.useRealTimers();

      const mockKillProc = createMockProcess();
      const mockRmProc = createMockProcess();
      const mockRunProc = createMockProcess();

      mockSpawn
        .mockReturnValueOnce(mockKillProc)
        .mockReturnValueOnce(mockRmProc)
        .mockReturnValueOnce(mockRunProc);

      const promise = runner.startDetached({
        sessionKey: "test",
        prompt: "test",
        claudeDir: "/path/.claude",
        workspaceDir: "/path/workspace",
      });

      mockKillProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));
      mockRmProc.emit("close", 0);
      await new Promise((r) => setImmediate(r));

      (mockRunProc.stderr as EventEmitter).emit("data", Buffer.from("container error"));
      mockRunProc.emit("close", 1);

      await expect(promise).rejects.toThrow("Failed to start container");

      vi.useFakeTimers();
    });
  });

  describe("getContainerStatus", () => {
    it("returns status for running container", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("test-container");

      const inspectOutput = JSON.stringify([
        {
          State: {
            Running: true,
            ExitCode: 0,
            StartedAt: "2024-01-15T10:00:00.000Z",
            FinishedAt: "0001-01-01T00:00:00Z",
          },
        },
      ]);
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(inspectOutput));
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toEqual({
        running: true,
        exitCode: 0,
        startedAt: "2024-01-15T10:00:00.000Z",
        finishedAt: "0001-01-01T00:00:00Z",
      });
    });

    it("returns status for stopped container", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("test-container");

      const inspectOutput = JSON.stringify([
        {
          State: {
            Running: false,
            ExitCode: 1,
            StartedAt: "2024-01-15T10:00:00.000Z",
            FinishedAt: "2024-01-15T10:05:00.000Z",
          },
        },
      ]);
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(inspectOutput));
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toEqual({
        running: false,
        exitCode: 1,
        startedAt: "2024-01-15T10:00:00.000Z",
        finishedAt: "2024-01-15T10:05:00.000Z",
      });
    });

    it("returns null when container not found", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("nonexistent");

      mockProc.emit("close", 1);

      const result = await promise;
      expect(result).toBeNull();
    });

    it("returns null on spawn error", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("test");

      mockProc.emit("error", new Error("podman not found"));

      const result = await promise;
      expect(result).toBeNull();
    });

    it("returns null on invalid JSON", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("test");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("not json"));
      mockProc.emit("close", 0);

      const result = await promise;
      expect(result).toBeNull();
    });

    it("returns null when State is missing", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerStatus("test");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify([{}])));
      mockProc.emit("close", 0);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe("getContainerLogs", () => {
    it("returns logs from container", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("line1\n"));
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("line2\n"));
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toBe("line1\nline2\n");
      expect(mockSpawn).toHaveBeenCalledWith("podman", ["logs", "test-container"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    it("supports since option", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container", { since: "10s" });

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("recent logs"));
      mockProc.emit("close", 0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["logs", "--since", "10s", "test-container"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("supports tail option", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container", { tail: 100 });

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("last 100 lines"));
      mockProc.emit("close", 0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["logs", "--tail", "100", "test-container"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("combines stdout and stderr", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("stdout\n"));
      (mockProc.stderr as EventEmitter).emit("data", Buffer.from("stderr\n"));
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toBe("stdout\nstderr\n");
    });

    it("returns null on error", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container");

      mockProc.emit("error", new Error("container not found"));

      const result = await promise;
      expect(result).toBeNull();
    });

    it("returns null on non-zero exit", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.getContainerLogs("test-container");

      mockProc.emit("close", 1);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe("listContainersByPrefix", () => {
    it("returns list of containers matching prefix", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("claude-");

      // Podman outputs one JSON object per line, not a JSON array
      const line1 = JSON.stringify({
        Names: ["claude-session1"],
        State: "running",
        CreatedAt: "2024-01-15T10:00:00.000Z",
      });
      const line2 = JSON.stringify({
        Names: ["claude-session2"],
        State: "exited",
        CreatedAt: "2024-01-15T09:00:00.000Z",
      });
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from(`${line1}\n${line2}\n`));
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: "claude-session1",
        running: true,
        createdAt: "2024-01-15T10:00:00.000Z",
      });
      expect(result[1]).toEqual({
        name: "claude-session2",
        running: false,
        createdAt: "2024-01-15T09:00:00.000Z",
      });
    });

    it("returns empty array when no containers match", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("nonexistent-");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("[]"));
      mockProc.emit("close", 0);

      const result = await promise;
      expect(result).toEqual([]);
    });

    it("returns empty array on error", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("claude-");

      mockProc.emit("error", new Error("podman error"));

      const result = await promise;
      expect(result).toEqual([]);
    });

    it("returns empty array on non-zero exit", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("claude-");

      mockProc.emit("close", 1);

      const result = await promise;
      expect(result).toEqual([]);
    });

    it("returns empty array on invalid JSON", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("claude-");

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("not json"));
      mockProc.emit("close", 0);

      const result = await promise;
      expect(result).toEqual([]);
    });

    it("skips containers with invalid data", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = runner.listContainersByPrefix("claude-");

      // Podman outputs one JSON object per line
      const validLine = JSON.stringify({
        Names: ["claude-valid"],
        State: "running",
        CreatedAt: "2024-01-15T10:00:00.000Z",
      });
      const emptyNamesLine = JSON.stringify({
        Names: [],
        State: "running",
        CreatedAt: "2024-01-15T10:00:00.000Z",
      });
      const missingNamesLine = JSON.stringify({
        State: "running",
        CreatedAt: "2024-01-15T10:00:00.000Z",
      });
      (mockProc.stdout as EventEmitter).emit(
        "data",
        Buffer.from(`${validLine}\n${emptyNamesLine}\n${missingNamesLine}\n`)
      );
      mockProc.emit("close", 0);

      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("claude-valid");
    });
  });

  describe("containerNameFromSessionKey", () => {
    it("generates container name from session key", () => {
      expect(runner.containerNameFromSessionKey("my-session")).toBe("claude-my-session");
    });

    it("sanitizes special characters", () => {
      expect(runner.containerNameFromSessionKey("user@example.com")).toBe(
        "claude-user-example-com"
      );
      expect(runner.containerNameFromSessionKey("session_123")).toBe("claude-session-123");
      expect(runner.containerNameFromSessionKey("a.b.c")).toBe("claude-a-b-c");
    });

    it("preserves hyphens and alphanumeric", () => {
      expect(runner.containerNameFromSessionKey("test-123-abc")).toBe("claude-test-123-abc");
    });
  });

  describe("sessionKeyFromContainerName", () => {
    it("extracts session key from container name", () => {
      expect(runner.sessionKeyFromContainerName("claude-my-session")).toBe("my-session");
      expect(runner.sessionKeyFromContainerName("claude-test-123")).toBe("test-123");
    });

    it("returns null for non-claude containers", () => {
      expect(runner.sessionKeyFromContainerName("other-container")).toBeNull();
      expect(runner.sessionKeyFromContainerName("notclaude-session")).toBeNull();
    });

    it("returns empty string for claude- prefix only", () => {
      expect(runner.sessionKeyFromContainerName("claude-")).toBe("");
    });
  });
});
