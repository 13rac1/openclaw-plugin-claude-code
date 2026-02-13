# Contributing to OpenClaw Plugin: Claude Code

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

### Prerequisites

- Node.js >= 22
- Podman (for integration tests)
- Git

### Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/openclaw-plugin-claude-code.git
   cd openclaw-plugin-claude-code
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Building

```bash
npm run build
```

### Testing

```bash
# Run unit tests (mocked, fast)
npm test

# Run integration tests (requires Podman)
npm run test:integration

# Run all tests
npm run test:all

# Watch mode for development
npm run test:watch
```

### Local Testing with OpenClaw

Link the plugin for development testing:

```bash
openclaw plugins install -l /path/to/openclaw-plugin-claude-code
```

## Code Style

- TypeScript with strict mode
- ES modules (`"type": "module"`)
- Use early returns to reduce nesting
- Add comments for non-obvious logic
- Keep functions focused and testable

## Submitting Changes

### Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes with clear, atomic commits

3. Ensure all tests pass:
   ```bash
   npm run test:all
   ```

4. Update documentation if needed (README.md, CHANGELOG.md)

5. Push to your fork and create a Pull Request

### Commit Messages

Use clear, descriptive commit messages:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test additions/changes
- `refactor:` for code refactoring
- `chore:` for maintenance tasks

Example: `feat: add configurable PID limit for containers`

### Pull Request Guidelines

- Provide a clear description of the changes
- Reference any related issues
- Include test coverage for new functionality
- Update CHANGELOG.md for user-facing changes

## Reporting Issues

### Bug Reports

Include:
- OpenClaw version
- Plugin version
- Podman/Docker version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs/error messages

### Feature Requests

- Describe the use case
- Explain why existing functionality doesn't meet the need
- Propose a solution if you have one

## Security

If you discover a security vulnerability, please do NOT open a public issue. Instead, email the maintainer directly.

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
