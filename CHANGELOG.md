# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Inject host git identity into containers via `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` env vars
- Refuse to start if host git identity (`user.name`, `user.email`) is not configured
- `delete_workspaces` parameter on `claude_code_cleanup` for explicit workspace deletion

### Fixed

- `claude_code_cleanup` no longer destroys workspace data (code, files, git history) — only session metadata is removed by default

## [1.0.11] - 2026-02-20

### Added

- Detect Claude Code authentication errors (expired OAuth tokens) and report to agent
- Detect Claude Code rate limit errors and report wait time to agent
- Real-time streaming output via `streamContainerLogs` (replaces polling)
- Job completion notifications via webhook (no polling required)
- `claude_code_sessions` tool for listing all active sessions

### Fixed

- Mount host `~/.claude` directly so OAuth token refreshes persist across jobs
- Prevent race condition in concurrent job output streaming
- Rootless Podman UID mapping with `--userns=keep-id:uid=1000,gid=1000`

### Changed

- `npm test` now runs formatter and linter checks before tests
- Extracted shared formatting utilities (`formatDuration`, `formatBytes`)
- Improved type safety, error handling, and code clarity

## [1.0.0] - 2026-02-12

### Added

- Initial public release
- `claude_code` tool for executing prompts in isolated containers
- `claude_code_cleanup` tool for cleaning up idle sessions
- Session persistence with automatic state tracking
- Dual authentication support (API key and OAuth/Claude Max)
- Configurable resource limits (memory, CPU, PIDs)
- AppArmor profile support for additional security
- Startup and idle timeout detection
- Multi-arch container image (arm64, amd64)
- Comprehensive test suite (unit and integration)

### Security

- Rootless container execution via Podman
- All Linux capabilities dropped (`--cap-drop ALL`)
- tmpfs with noexec for /tmp
- Configurable network isolation
- Optional AppArmor MAC enforcement

[Unreleased]: https://github.com/13rac1/openclaw-plugin-claude-code/compare/v1.0.11...HEAD
[1.0.11]: https://github.com/13rac1/openclaw-plugin-claude-code/compare/v1.0.0...v1.0.11
[1.0.0]: https://github.com/13rac1/openclaw-plugin-claude-code/releases/tag/v1.0.0
