import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createRoleSession } from "../src/agents.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Pi SDK compatibility", () => {
  it("creates a role session with the canonical model runtime", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conduct-sdk-"));
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conduct-agent-"));
    temporaryDirectories.push(cwd, agentDir);

    const modelRuntime = await ModelRuntime.create({ modelsPath: null });
    const sessionManager = SessionManager.inMemory(cwd);
    const session = await createRoleSession(
      cwd,
      { provider: "openai", model: "gpt-4o", thinkingLevel: "off" },
      ["read"],
      { allowNetwork: false, blockedCommandPatterns: [] },
      { agentDir, modelRuntime, sessionManager },
    );

    try {
      assert.equal(session.model?.provider, "openai");
      assert.equal(session.model?.id, "gpt-4o");
      assert.equal(session.sessionManager, sessionManager);
      assert.equal(session.modelRuntime, modelRuntime);
    } finally {
      session.dispose();
    }
  });
});
