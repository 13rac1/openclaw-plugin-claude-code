import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PodmanRunner, PodmanConfig, ClaudeCodeResult, ErrorType } from "./podman-runner";
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function createMockProcess(): ChildProcess & { killed: boolean } {
  const proc = new EventEmitter() as ChildProcess & { killed: boolean };
  proc.stdout = new EventEmitter() as NodeJS.ReadableStream;
  proc.stderr = new EventEmitter() as NodeJS.ReadableStream;
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
        (arg: string) =>
          arg.includes(":/home/claude/.claude") || arg.includes(":/workspace")
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
      const output =
        'Some debug output\nMore output\n{"result": "Final", "session_id": "sess1"}';
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

      const executePromise = (runner as any).execute(
        ["run", "--rm", "test"],
        "test-container"
      );

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
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output immediately (before any timer advancement)
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output"));

      // Advance past startup timeout - should not kill because we already got output
      vi.advanceTimersByTime(35000);

      // Process should NOT be killed (got output before timeout)
      expect(mockProc.kill).not.toHaveBeenCalled();

      // Complete normally
      mockProc.emit("close", 0);

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
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executePromise = (runner as any).execute(["run"], "test-container");

      // Emit output and advance time in sequence
      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output1"));
      vi.advanceTimersByTime(60000); // 60s idle

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output2"));
      vi.advanceTimersByTime(60000); // 60s idle

      (mockProc.stdout as EventEmitter).emit("data", Buffer.from("output3"));
      vi.advanceTimersByTime(60000); // 60s idle

      // Process should NOT be killed (we kept getting output before 120s idle)
      expect(mockProc.kill).not.toHaveBeenCalled();

      // Complete normally
      mockProc.emit("close", 0);

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
      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["rm", "-f", "claude-user-123"],
        {
          stdio: "ignore",
        }
      );
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
      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["kill", "claude-test-session"],
        { stdio: "ignore" }
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["rm", "-f", "claude-test-session"],
        { stdio: "ignore" }
      );

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
      expect(mockSpawn).toHaveBeenCalledWith(
        "podman",
        ["container", "exists", "test-container"],
        { stdio: "ignore" }
      );

      vi.useFakeTimers();
    });

    it("retries and returns false after all retries fail", async () => {
      // This test needs real timers due to async promise chains with setTimeout
      vi.useRealTimers();

      const mockProcs = [
        createMockProcess(),
        createMockProcess(),
        createMockProcess(),
      ];

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
});
