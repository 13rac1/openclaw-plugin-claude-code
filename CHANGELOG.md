# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/13rac1/openclaw-plugin-claude-code/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/13rac1/openclaw-plugin-claude-code/releases/tag/v1.0.0
