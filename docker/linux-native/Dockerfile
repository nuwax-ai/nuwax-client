# syntax=docker/dockerfile:1.7
# Linux native build image for the glibc 2.28 floor (UOS 20 Pro 1050).
#
# Why this image exists: the release runners are Ubuntu 24.04 (glibc 2.39), and
# native artifacts compiled there carry GLIBC_2.34..2.39 symbols that do not
# load on a 2.28 system. This image provides Debian 10 buster (glibc 2.28) with
# everything needed to compile better-sqlite3, the capture ffmpeg and the
# cua-driver helper. Packaging stays on the runner; only compilation runs here.
#
# Versions and checksums: docker/linux-native/versions.env (single source).
# One digest pins the multi-arch manifest list, so both architectures share it.
#
# Build (from the repository root):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     $(sed -n 's/^\([A-Z_]*\)=/\1=/p' docker/linux-native/versions.env \
#         | grep -v '^#' | sed 's/^/--build-arg /') \
#     -f docker/linux-native/Dockerfile docker/linux-native

ARG DEBIAN_BASE_IMAGE
FROM ${DEBIAN_BASE_IMAGE}

ARG TARGETARCH
ARG NODE_VERSION
ARG NODE_SHA256_X64
ARG NODE_SHA256_ARM64
ARG PYTHON_VERSION
ARG PYTHON_BUILD
ARG PYTHON_SHA256_X64
ARG PYTHON_SHA256_ARM64
ARG GIT_VERSION
ARG GIT_SHA256
ARG NASM_VERSION
ARG NASM_SHA256
ARG RUSTUP_VERSION
ARG RUSTUP_SHA256_X64
ARG RUSTUP_SHA256_ARM64
ARG RUST_TOOLCHAIN
ARG RUST_COMPONENTS

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH=/opt/toolchain/bin:/opt/node/bin:/opt/cargo/bin:/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo

# buster is end of life: its packages live on archive.debian.org, and the
# default sources file points at a host that no longer carries them.
RUN sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g; s|security.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang yasm \
      libdbus-1-dev libxkbcommon-dev libx11-dev libxi-dev libxtst-dev libxext-dev \
      ca-certificates xz-utils file binutils sudo \
      libssl-dev libz-dev libcurl4-openssl-dev libexpat1-dev gettext \
 && rm -rf /var/lib/apt/lists/*

# --- curl from buster-backports ------------------------------------------------
# buster's own curl is 7.64; the repository's download helpers pass
# --retry-all-errors, which curl only understands from 7.71. The backported
# 7.74 is built against the same glibc 2.28. The backports source is enabled
# only for this install and removed again, so nothing else in the image drifts
# onto a backported package by accident.
RUN echo 'deb http://archive.debian.org/debian buster-backports main' > /etc/apt/sources.list.d/backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t buster-backports curl \
 && rm -f /etc/apt/sources.list.d/backports.list \
 && rm -rf /var/lib/apt/lists/* \
 && curl --version | head -n 1 \
 && curl --retry-all-errors --help > /dev/null

# Select the checksum and triple that match the target architecture.
# Each project spells the architecture its own way: Docker says amd64, Node's
# tarballs say x64, Rust and python-build-standalone use full triples.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) node_sha="$NODE_SHA256_X64";    python_sha="$PYTHON_SHA256_X64";    rustup_sha="$RUSTUP_SHA256_X64";    triple=x86_64-unknown-linux-gnu;    node_arch=x64 ;; \
      arm64) node_sha="$NODE_SHA256_ARM64";  python_sha="$PYTHON_SHA256_ARM64";  rustup_sha="$RUSTUP_SHA256_ARM64";  triple=aarch64-unknown-linux-gnu;  node_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    printf '%s\n' "$node_sha"   > /tmp/node.sha256; \
    printf '%s\n' "$python_sha" > /tmp/python.sha256; \
    printf '%s\n' "$rustup_sha" > /tmp/rustup.sha256; \
    printf '%s\n' "$triple"     > /tmp/triple; \
    printf '%s\n' "$node_arch"  > /tmp/node_arch

# --- Node: drives node-gyp and the repository's build scripts -----------------
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$(cat /tmp/node_arch).tar.xz" -o /tmp/node.tar.xz \
 && echo "$(cat /tmp/node.sha256)  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && node --version

# --- Python: node-gyp 13 needs >= 3.8; buster ships 3.7 -----------------------
# python-build-standalone ships official CPython builds; compiling CPython from
# source in the image would add several minutes for no benefit.
RUN curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-$(cat /tmp/triple)-install_only.tar.gz" -o /tmp/python.tar.gz \
 && echo "$(cat /tmp/python.sha256)  /tmp/python.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/python && tar -xzf /tmp/python.tar.gz -C /opt/python --strip-components=1 \
 && /opt/python/bin/python3 --version

# --- git: build-helper.sh needs partial clone and sparse-checkout -------------
# buster's own git 2.20.1 rejects `fetch --filter=blob:none` and has no
# `sparse-checkout`, so the helper build dies at its clone step.
RUN curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" -o /tmp/git.tar.xz \
 && echo "$GIT_SHA256  /tmp/git.tar.xz" | sha256sum -c - \
 && mkdir -p /tmp/git-src && tar -xJf /tmp/git.tar.xz -C /tmp/git-src --strip-components=1 \
 && ( cd /tmp/git-src && ./configure --prefix=/opt/toolchain >/dev/null && make -s -j"$(nproc)" >/dev/null && make install >/dev/null ) \
 && /opt/toolchain/bin/git --version

# --- nasm: FFmpeg 8's x86 assembly needs newer than buster's 2.14 ----------------
# Only x64 assembles it, but the image is the same for both architectures so
# that one recipe produces one tag.
RUN curl -fsSL "https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz" -o /tmp/nasm.tar.xz \
 && echo "$NASM_SHA256  /tmp/nasm.tar.xz" | sha256sum -c - \
 && mkdir -p /tmp/nasm-src && tar -xJf /tmp/nasm.tar.xz -C /tmp/nasm-src --strip-components=1 \
 && ( cd /tmp/nasm-src && ./configure --prefix=/opt/toolchain >/dev/null && make -s -j"$(nproc)" >/dev/null && make install >/dev/null ) \
 && nasm -v

# --- g++ shim: gcc 8.3 does not know -std=c++20 -------------------------------
COPY gxx-shim.sh /opt/toolchain/bin/g++
RUN chmod 0755 /opt/toolchain/bin/g++

# --- Rust: same toolchain the release workflow pins ---------------------------
RUN curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/$(cat /tmp/triple)/rustup-init" -o /tmp/rustup-init \
 && echo "$(cat /tmp/rustup.sha256)  /tmp/rustup-init" | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --default-toolchain "${RUST_TOOLCHAIN}" --profile minimal \
 && rustup component add ${RUST_COMPONENTS} \
 && rustup default "${RUST_TOOLCHAIN}" \
 && rustc --version && cargo --version

# node-gyp reads PYTHON to find its interpreter: gyp needs >= 3.8 and buster's
# own python3 is 3.7, so the standalone 3.12 must win.
ENV PYTHON=/opt/python/bin/python3.12

# The glibc floor this image guarantees. Scripts read it instead of hard-coding.
ENV NUWAX_LINUX_GLIBC_FLOOR=2.28

RUN rm -rf /tmp/node.tar.xz /tmp/python.tar.gz /tmp/git.tar.xz /tmp/git-src /tmp/nasm.tar.xz /tmp/nasm-src /tmp/rustup-init /tmp/*.sha256 /tmp/triple /tmp/node_arch

WORKDIR /work
