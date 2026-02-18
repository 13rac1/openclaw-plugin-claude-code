# OpenClaw Plugin: Claude Code

[![CI](https://github.com/13rac1/openclaw-plugin-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/13rac1/openclaw-plugin-claude-code/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/13rac1/openclaw-plugin-claude-code/graph/badge.svg)](https://codecov.io/gh/13rac1/openclaw-plugin-claude-code)
[![npm version](https://img.shields.io/npm/v/@13rac1/openclaw-plugin-claude-code.svg)](https://www.npmjs.com/package/@13rac1/openclaw-plugin-claude-code)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

**Run Claude Code in secure, isolated containers with your Claude Max subscription.**

An [OpenClaw](https://openclaw.ai) plugin that executes [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions in rootless Podman containers. Let your AI agents delegate complex coding tasks to Claude Code without risking your host system.

## Why Use This Plugin?

### Use Your Claude Max Credits

Have a Claude Max subscription? This plugin lets you use your existing subscription credits for agentic coding tasks instead of paying per-token API costs. Your OAuth credentials are securely passed to containerized Claude Code sessions.

### Contain the Blast Radius

Claude Code with `--dangerously-skip-permissions` can modify any file and run any command. This plugin contains each session in a rootless container with:

- All Linux capabilities dropped
- Configurable network isolation
- Memory and CPU limits
- Optional AppArmor profiles

Bad code, infinite loops, or accidental `rm -rf` stays inside the container. Your host system remains untouched.

### Parallel Workspaces

Run multiple Claude Code sessions simultaneously, each in its own isolated workspace. Sessions maintain state across interactions, enabling complex multi-step workflows without interference.

### Works With Any OpenClaw Agent

Any OpenClaw agent can use the `claude_code_start` tool to offload coding tasks. The orchestrating agent stays lightweight while Claude Code handles the heavy lifting in its own container.

## Features

- **Isolated Execution**: Each Claude Code session runs in its own container with dropped capabilities
- **Session Persistence**: Sessions maintain state across multiple interactions
- **Dual Authentication**: Supports both API key and OAuth/Claude Max credentials
- **Resource Limits**: Configurable memory, CPU, and PID limits
- **AppArmor Support**: Optional AppArmor profile for additional security hardening
- **Automatic Cleanup**: Idle sessions are automatically cleaned up

## Requirements

- [OpenClaw](https://openclaw.ai) >= 2025.1.0
- [Podman](https://podman.io) (recommended) or Docker
- Node.js >= 22

## Installation

### From npm

```bash
openclaw plugins install @13rac1/openclaw-plugin-claude-code
```

### From GitHub Release

Download the release zip from [GitHub Releases](https://github.com/13rac1/openclaw-plugin-claude-code/releases) and extract to your plugins directory:

```bash
# Download latest release
curl -LO https://github.com/13rac1/openclaw-plugin-claude-code/releases/latest/download/openclaw-plugin-claude-code-1.0.4.zip

# Extract to plugins directory
unzip openclaw-plugin-claude-code-1.0.4.zip -d ~/.openclaw/plugins/openclaw-plugin-claude-code
```

### Container Image

The plugin requires a container image with Claude Code CLI installed. Pull the pre-built image:

```bash
podman pull ghcr.io/13rac1/openclaw-claude-code:latest
```

Or build it yourself:

```bash
podman build -t ghcr.io/13rac1/openclaw-claude-code:latest .
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "load": {
      "paths": ["path/to/dist/index.js"]
    },
    "entries": {
      "claude-code": {
        "enabled": true,
        "config": {
          "image": "ghcr.io/13rac1/openclaw-claude-code:latest",
          "runtime": "podman",
          "startupTimeout": 30,
          "idleTimeout": 120,
          "memory": "512m",
          "cpus": "1.0",
          "network": "bridge",
          "sessionsDir": "~/.openclaw/claude-sessions",
          "workspacesDir": "~/.openclaw/workspaces",
          "sessionIdleTimeout": 3600
        }
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | string | `ghcr.io/13rac1/openclaw-claude-code:latest` | Container image for Claude Code |
| `runtime` | string | `podman` | Container runtime (`podman` or `docker`) |
| `startupTimeout` | number | `30` | Seconds to wait for container to produce first output |
| `idleTimeout` | number | `120` | Kill container after this many seconds of no output |
| `memory` | string | `512m` | Memory limit for containers |
| `cpus` | string | `1.0` | CPU limit for containers |
| `network` | string | `bridge` | Network mode (`none`, `bridge`, `host`) |
| `sessionsDir` | string | `~/.openclaw/claude-sessions` | Directory for session metadata |
| `workspacesDir` | string | `~/.openclaw/workspaces` | Directory for session workspaces |
| `sessionIdleTimeout` | number | `3600` | Cleanup idle sessions after this many seconds |
| `apparmorProfile` | string | `""` | AppArmor profile name (empty = disabled) |
| `maxOutputSize` | number | `10485760` | Maximum output size in bytes (10MB default, 0 = unlimited) |
| `notifyWebhookUrl` | string | `http://localhost:18789/hooks/agent` | OpenClaw webhook URL for notifications |
| `hooksToken` | string | `""` | Webhook auth token (must match OpenClaw `hooks.token` to enable notifications) |

## Authentication

The plugin supports two authentication methods:

### 1. OAuth / Claude Max (Recommended)

If you have Claude Max or enterprise OAuth credentials, place your credentials file at:

```
~/.claude/.credentials.json
```

The plugin will automatically copy this file into each container session.

### 2. API Key

Set the `ANTHROPIC_API_KEY` environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Note**: If both are available, OAuth credentials take precedence.

## Job Completion Notifications

The plugin sends webhook notifications when jobs complete. No polling required.

### Setup

Enable webhooks in OpenClaw config (`~/.openclaw/openclaw.json`):
```json
{
  "hooks": {
    "enabled": true,
    "token": "your-secret-token"
  }
}
```

The plugin automatically reads the token from the OpenClaw config file. When a job completes, fails, or is cancelled, the agent receives a message with the job status, duration, and output size.

## Registered Tools

### `claude_code_start`

Start a Claude Code task in the background. Returns immediately with a job ID.

**Parameters:**
- `prompt` (required): The task or prompt to send to Claude Code
- `session_id` (optional): Session ID to continue a previous session

**Returns:** `{ jobId: string, sessionId: string }`

### `claude_code_status`

Check the status of a running or completed job.

**Parameters:**
- `job_id` (required): Job ID returned from `claude_code_start`
- `session_id` (optional): Session ID

**Returns:**
- `status`: Job status (pending, running, completed, failed, cancelled)
- `elapsedSeconds`: Time since job started
- `outputSize`: Total output size in bytes
- `tailOutput`: Last ~500 chars of output (for quick preview)
- `lastOutputSecondsAgo`: Seconds since last output was produced
- `activityState`: "active" (producing output), "processing" (CPU busy), or "idle"
- `metrics`: CPU and memory usage
- `exitCode`: Process exit code (when completed)
- `error`: Error message (if failed)

### `claude_code_output`

Read or tail output from a job.

**Parameters:**
- `job_id` (required): Job ID
- `session_id` (optional): Session ID
- `offset` (optional): Byte offset to start reading from (for tailing)
- `limit` (optional): Maximum bytes to read (default 64KB)

**Returns:** Output content with `hasMore` flag for pagination

### `claude_code_cancel`

Cancel a running job and stop its container.

**Parameters:**
- `job_id` (required): Job ID
- `session_id` (optional): Session ID

### `claude_code_cleanup`

Clean up idle sessions and their jobs.

### `claude_code_sessions`

List all active sessions with age, last activity, message count, and active job info.

## Security

The plugin implements multiple layers of security:

1. **Rootless Containers**: Uses Podman rootless mode by default
2. **Capability Dropping**: All Linux capabilities are dropped (`--cap-drop ALL`)
3. **Resource Limits**: Memory, CPU, and PID limits prevent resource exhaustion
4. **tmpfs with noexec**: `/tmp` is mounted as tmpfs with `noexec,nosuid`
5. **Network Isolation**: Configurable network mode (can be set to `none`)
6. **AppArmor**: Optional AppArmor profile support for MAC enforcement

## Development

### Setup

```bash
git clone https://github.com/13rac1/openclaw-plugin-claude-code.git
cd openclaw-plugin-claude-code
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
# Unit tests (mocked)
npm test

# Integration tests (requires Podman)
npm run test:integration

# All tests
npm run test:all
```

### Local Development

Link the plugin for development:

```bash
openclaw plugins install -l ./path/to/openclaw-plugin-claude-code
```

## Container Image

The included Dockerfile creates a Debian Bookworm-based image with:

- Node.js 22
- Claude Code CLI (npm global)
- Go 1.22.5 + TinyGo 0.32.0
- Python 3 with venv
- Common dev tools: git, ripgrep, jq, curl

### Building Multi-arch Images

```bash
# Single architecture (current)
podman build -t ghcr.io/13rac1/openclaw-claude-code:latest .

# Multi-architecture (arm64 + amd64)
GITHUB_USERNAME=13rac1 ./scripts/build-and-push.sh --multi-arch
```

## Releasing

Releases are automated via GitHub Actions when a version tag is pushed.

### Prerequisites

1. Configure `NPM_TOKEN` secret in GitHub repository settings
2. Ensure you have push access to the repository

### Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Commit the changes:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release v1.x.x"
   ```
4. Create and push a version tag:
   ```bash
   git tag v1.x.x
   git push origin main --tags
   ```

The release workflow will automatically:
- Run tests
- Publish to npm with provenance
- Build and push multi-arch container images to ghcr.io

## Troubleshooting

### Container image not found

```
Error: Container image not found: ghcr.io/13rac1/openclaw-claude-code:latest
```

Pull or build the container image:

```bash
podman pull ghcr.io/13rac1/openclaw-claude-code:latest
```

### No authentication available

```
Error: No authentication available. Set ANTHROPIC_API_KEY or have ~/.claude/.credentials.json
```

Either:
1. Set `ANTHROPIC_API_KEY` environment variable, or
2. Place OAuth credentials at `~/.claude/.credentials.json`

### Startup timeout

```
Error: startup_timeout - No output within 30 seconds
```

The container failed to start or produce output. Check:
- Container image is valid
- Sufficient system resources
- Network connectivity (if `network: bridge`)

Increase `startupTimeout` if needed.

### Idle timeout

```
Error: idle_timeout - No output for 120 seconds
```

Claude Code stopped producing output. This may indicate:
- Task completed but output wasn't captured
- Claude Code is stuck
- Task requires more time (increase `idleTimeout`)

## FAQ

### Why Podman?

The primary reason is rootless. Podman runs containers without root privileges by default, which is essential for a tool that executes arbitrary code from AI agents. Docker can run rootless too, but it requires additional setup and isn't the default mode.

## License

Apache-2.0 - see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
