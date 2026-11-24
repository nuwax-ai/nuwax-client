#!/bin/bash
# g++ wrapper for the Linux native build image.
#
# gcc 8.3 (Debian 10 buster) rejects `-std=c++20` / `-std=gnu++20`: it spelled
# the same dialect `-std=c++2a` / `-std=gnu++2a`. better-sqlite3 13's binding.gyp
# hard-codes `-std=c++20`, so the build dies on an "unrecognized command line
# option" before compiling a line.
#
# Only the dialect flag is rewritten; every other argument passes through.
# This is enough for Node-API modules (they include napi.h, not V8 headers).
# gcc 8 has no <compare>, so anything that includes V8 headers still cannot be
# built this way — the gate catches that rather than hiding it.
args=()
for arg in "$@"; do
  case "$arg" in
    -std=c++20) args+=(-std=c++2a) ;;
    -std=gnu++20) args+=(-std=gnu++2a) ;;
    *) args+=("$arg") ;;
  esac
done
exec /usr/bin/g++ "${args[@]}"
