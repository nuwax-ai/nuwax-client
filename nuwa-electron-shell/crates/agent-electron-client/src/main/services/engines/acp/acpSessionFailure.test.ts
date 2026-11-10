import { describe, expect, it } from "vitest";
import {
  readSessionFailureMeta,
  requestsNewSession,
  shouldFailTurn,
} from "./acpSessionFailure";

describe("readSessionFailureMeta", () => {
  it("reads the codex session failure namespace", () => {
    const signal = readSessionFailureMeta({
      quota: { token_count: null },
      codex: {
        sessionFailure: {
          category: "limit",
          actions: ["new_session"],
          message: "nuwax-harness ran out of room in the model's context window.",
        },
      },
    });

    expect(signal).toEqual({
      category: "limit",
      actions: ["new_session"],
      message: "nuwax-harness ran out of room in the model's context window.",
    });
    expect(signal && requestsNewSession(signal)).toBe(true);
  });

  it("ignores metadata without the codex failure", () => {
    expect(readSessionFailureMeta({ quota: { token_count: null } })).toBeNull();
    expect(readSessionFailureMeta(undefined)).toBeNull();
    expect(readSessionFailureMeta({ codex: { threadStatus: { type: "idle" } } })).toBeNull();
  });

  it("fails the turn for both exhausted context and oversized input", () => {
    const exhausted = readSessionFailureMeta({
      codex: {
        sessionFailure: { kind: "context_exhausted", category: "limit", actions: ["retry"] },
      },
    });
    const tooLarge = readSessionFailureMeta({
      codex: {
        sessionFailure: { kind: "input_too_large", category: "request", actions: [] },
      },
    });
    const advisory = readSessionFailureMeta({
      codex: { sessionFailure: { kind: "rate_limited", category: "limit", actions: ["retry"] } },
    });

    expect(exhausted && shouldFailTurn(exhausted)).toBe(true);
    expect(tooLarge && shouldFailTurn(tooLarge)).toBe(true);
    expect(advisory && shouldFailTurn(advisory)).toBe(false);
    // Neither failure asks the client to abandon the conversation.
    expect(exhausted && requestsNewSession(exhausted)).toBe(false);
    expect(tooLarge && requestsNewSession(tooLarge)).toBe(false);
  });

  it("keeps unknown shapes usable but never asks for a new session", () => {
    const signal = readSessionFailureMeta({
      codex: { sessionFailure: { category: 42, actions: [null, "retry"] } },
    });

    expect(signal).toEqual({ category: "unknown", actions: ["retry"] });
    expect(signal && requestsNewSession(signal)).toBe(false);
  });
});
