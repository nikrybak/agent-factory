# Local GitHub Actions runner image (ADR-0022). The official runner image plus the tools the owner's
# workflows expect on GitHub's ubuntu-24.04 image, at the same paths, so workflows stay unchanged.
# Rebuilt by `infra runners build`; versions are build arguments so an update is one flag.
ARG RUNNER_VERSION=2.338.0
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

ARG COMPOSE_VERSION=2.40.3
ARG ANDROID_CMDLINE_TOOLS=13114758
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.1.0

USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev clang lld cmake \
      zip xz-utils zstd wget gnupg ca-certificates locales tzdata \
      python3-venv python3-pip python-is-python3 pipx git-lfs \
      postgresql-client openjdk-17-jdk-headless \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/*

# docker compose v2 plugin (the base image ships the docker CLI and buildx only)
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version

# Android SDK at the hosted image's path, owned by the runner so Gradle may add packages
ENV ANDROID_HOME=/usr/local/lib/android/sdk ANDROID_SDK_ROOT=/usr/local/lib/android/sdk
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
 && curl -fsSL -o /tmp/clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
 && unzip -q /tmp/clt.zip -d ${ANDROID_HOME}/cmdline-tools && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
 && rm /tmp/clt.zip \
 && yes | ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}" > /dev/null \
 && chown -R runner:runner /usr/local/lib/android

# Hosted-image conventions: the tool cache and the agent tools directory
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ImageOS=ubuntu24 ImageVersion=infra-local
RUN mkdir -p /opt/hostedtoolcache && chown runner:runner /opt/hostedtoolcache

COPY --chmod=755 entrypoint.sh /usr/local/bin/infra-runner-entrypoint

USER runner
# Rust through rustup at the hosted image's paths (~/.cargo, ~/.rustup)
ENV CARGO_HOME=/home/runner/.cargo RUSTUP_HOME=/home/runner/.rustup PATH=/home/runner/.cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable -c clippy,rustfmt \
 && cargo --version \
 && mkdir -p /home/runner/.cargo/registry /home/runner/.gradle /home/runner/_work

ENTRYPOINT ["/usr/local/bin/infra-runner-entrypoint"]
