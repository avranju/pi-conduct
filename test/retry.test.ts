import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTransientModelError,
  retryDelayFor,
  sleep,
} from "../src/utils.js";
import { withTransientRetry } from "../src/agents.js";
import type { RetryConfig } from "../src/schemas.js";

const baseRetry: RetryConfig = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 5,
  maxDelayMs: 20,
  timeoutMs: 0,
  retryableErrorPatterns: [],
};

interface R { interrupted?: boolean; errors?: string[]; value?: string }

describe("isTransientModelError", () => {
  it("classifies connection refused / 5xx / fetch failed as transient", () => {
    assert.equal(isTransientModelError("fetch failed: ECONNREFUSED 127.0.0.1:8080"), true);
    assert.equal(isTransientModelError("HTTP 503 Service Unavailable"), true);
    assert.equal(isTransientModelError("socket hang up"), true);
    assert.equal(isTransientModelError("llama.cpp server is down: connection reset"), true);
  });

  it("rejects auth / quota / context overflow", () => {
    assert.equal(isTransientModelError("401 Unauthorized"), false);
    assert.equal(isTransientModelError("insufficient_quota"), false);
    assert.equal(isTransientModelError("context length exceeded"), false);
    assert.equal(isTransientModelError("invalid api key"), false);
  });

  it("returns false for unknown / undefined", () => {
    assert.equal(isTransientModelError(undefined), false);
    assert.equal(isTransientModelError("some unrelated message"), false);
  });

  it("honors extra user patterns", () => {
    assert.equal(isTransientModelError("my-custom-llama-crash", ["my-custom-llama-crash"]), true);
    assert.equal(isTransientModelError("my-custom-llama-crash", []), false);
  });
});

describe("retryDelayFor", () => {
  it("doubles and caps", () => {
    const r = { baseDelayMs: 1000, maxDelayMs: 4000 };
    assert.equal(retryDelayFor(1, r), 1000);
    assert.equal(retryDelayFor(2, r), 2000);
    assert.equal(retryDelayFor(3, r), 4000);
    assert.equal(retryDelayFor(4, r), 4000);
    assert.equal(retryDelayFor(5, r), 4000);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(30);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 25, `expected >=25ms, got ${elapsed}`);
  });

  it("resolves immediately when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await sleep(10_000, ac.signal); // should not block
    assert.ok(true);
  });
});

describe("withTransientRetry", () => {
  it("retries transient interrupted results and succeeds", async () => {
    let calls = 0;
    const result = await withTransientRetry<R>(
      "planner",
      async () => {
        calls++;
        if (calls < 3) {
          return { interrupted: true, errors: ["Planner agent error: fetch failed: ECONNREFUSED"] };
        }
        return { value: "ok" };
      },
      baseRetry,
      undefined,
      undefined,
    );
    assert.equal(calls, 3);
    assert.equal(result.value, "ok");
  });

  it("does NOT retry non-transient interrupted results", async () => {
    let calls = 0;
    const result = await withTransientRetry<R>(
      "planner",
      async () => {
        calls++;
        return { interrupted: true, errors: ["Planner agent error: 401 Unauthorized"] };
      },
      baseRetry,
      undefined,
      undefined,
    );
    assert.equal(calls, 1);
    assert.equal(result.interrupted, true);
  });

  it("retries thrown transient errors", async () => {
    let calls = 0;
    const result = await withTransientRetry<R>(
      "coder",
      async () => {
        calls++;
        if (calls < 2) throw new Error("socket hang up");
        return { value: "ok" };
      },
      baseRetry,
      undefined,
      undefined,
    );
    assert.equal(calls, 2);
    assert.equal(result.value, "ok");
  });

  it("rethrows non-transient thrown errors immediately", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry<R>(
        "coder",
        async () => {
          calls++;
          throw new Error("insufficient_quota");
        },
        baseRetry,
        undefined,
        undefined,
      ),
      /insufficient_quota/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after maxRetries with the last interrupted result", async () => {
    let calls = 0;
    const result = await withTransientRetry<R>(
      "reviewer",
      async () => {
        calls++;
        return { interrupted: true, errors: ["Reviewer agent error: 503 Service Unavailable"] };
      },
      baseRetry,
      undefined,
      undefined,
    );
    assert.equal(calls, baseRetry.maxRetries + 1);
    assert.equal(result.interrupted, true);
  });

  it("respects the wall-clock budget", async () => {
    let calls = 0;
    const retry: RetryConfig = {
      ...baseRetry,
      maxRetries: 10,
      baseDelayMs: 40,
      maxDelayMs: 40,
      timeoutMs: 50, // very tight budget
    };
    const start = Date.now();
    const result = await withTransientRetry<R>(
      "coder",
      async () => {
        calls++;
        return { interrupted: true, errors: ["Coder agent error: 503"] };
      },
      retry,
      undefined,
      undefined,
    );
    const elapsed = Date.now() - start;
    // Should stop well before exhausting maxRetries (11 attempts would be 400ms+).
    assert.ok(calls < 11, `expected fewer than 11 calls, got ${calls}`);
    assert.ok(elapsed < 400, `expected <400ms, got ${elapsed}`);
    assert.equal(result.interrupted, true);
  });

  it("aborts stop retrying promptly", async () => {
    const ac = new AbortController();
    let calls = 0;
    const resultP = withTransientRetry<R>(
      "planner",
      async () => {
        calls++;
        if (calls === 1) {
          // abort during the backoff of the first retry
          setTimeout(() => ac.abort(), 5);
        }
        return { interrupted: true, errors: ["Planner agent error: fetch failed"] };
      },
      { ...baseRetry, baseDelayMs: 500, maxDelayMs: 500 },
      ac.signal,
      undefined,
    );
    const result = await resultP;
    assert.equal(result.interrupted, true);
    assert.ok(calls < baseRetry.maxRetries + 1, `expected abort to stop retries, calls=${calls}`);
  });

  it("invokes the progress observer on retry", async () => {
    const events: { role: string; nextAttempt: number; reason: string }[] = [];
    let calls = 0;
    await withTransientRetry<R>(
      "coder",
      async () => {
        calls++;
        if (calls < 2) return { interrupted: true, errors: ["Coder agent error: 503"] };
        return { value: "ok" };
      },
      baseRetry,
      undefined,
      {
        observeAgent: () => () => {},
        onTransientRetry: (info) =>
          events.push({ role: info.role, nextAttempt: info.nextAttempt, reason: info.reason }),
      },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.role, "coder");
    assert.equal(events[0]!.nextAttempt, 2);
    assert.match(events[0]!.reason, /503/);
  });

  it("disabled retry runs the attempt once", async () => {
    let calls = 0;
    const result = await withTransientRetry<R>(
      "planner",
      async () => {
        calls++;
        return { interrupted: true, errors: ["Planner agent error: 503"] };
      },
      { ...baseRetry, enabled: false },
      undefined,
      undefined,
    );
    assert.equal(calls, 1);
    assert.equal(result.interrupted, true);
  });
});
