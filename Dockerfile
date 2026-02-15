# Claude Code Session Container
# Isolated environment for running Claude Code CLI

FROM debian:bookworm-slim

# Install all system packages, languages, and tools in a single layer
# Clean up temp files in the same layer to minimize image size
RUN set -eux; \
    ARCH=$(dpkg --print-architecture); \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        fd-find \
        git \
        gnupg \
        jq \
        less \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        sqlite3 \
        strace \
        unzip; \
    # Install Go
    curl -fsSL "https://go.dev/dl/go1.22.5.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz; \
    # Install TinyGo
    curl -fsSL "https://github.com/tinygo-org/tinygo/releases/download/v0.32.0/tinygo_0.32.0_${ARCH}.deb" -o /tmp/tinygo.deb; \
    dpkg -i /tmp/tinygo.deb; \
    rm /tmp/tinygo.deb; \
    # Install Node.js 22 from NodeSource
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get install -y nodejs; \
    # Install Claude Code CLI
    npm install -g @anthropic-ai/claude-code; \
    # Clean up
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*; \
    npm cache clean --force; \
    # Create non-root user
    useradd -m -u 1000 -s /bin/bash claude

ENV PATH="/usr/local/go/bin:${PATH}"

USER claude
WORKDIR /workspace

ENTRYPOINT ["claude"]
