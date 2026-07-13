import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, type ImplementationPlan, type RunState } from "../src/schemas.js";
import { fingerprintWorkspace, getGitHead, type Exec } from "../src/git.js";
import { loadResumeRun } from "../src/resume.js";

const temporaryRepos: string[] = [];

afterEach(() => {
  while (temporaryRepos.length > 0) {
    fs.rmSync(temporaryRepos.pop()!, { recursive: true, force: true });
  }
});

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function execFor(repo: string): Exec {
  return async (command, args) => {
    const result = spawnSync(command, args, { cwd: repo, encoding: "utf-8" });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    } as Awaited<ReturnType<Exec>>;
  };
}

const plan: ImplementationPlan = {
  goal: "Recover an interrupted run",
  assumptions: [],
  risks: [],
  filesToInspect: [],
  filesToModify: [],
  filesToCreate: [],
  typesToCreate: [],
  controlFlow: [],
  errorHandling: [],
  tests: [],
  acceptanceCriteria: [],
  implementationOrder: [],
};

async function createAbandonedRun(
  resumeAction: RunState["resumeAction"] = "coder",
  inFlightCoder = resumeAction === "coder",
) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conduct-resume-"));
  temporaryRepos.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);

  const artifactRoot = path.join(repo, ".pi", "conduct", "runs");
  const runId = "abandoned-run";
  const runDir = path.join(artifactRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "user-prompt.md"), "Recover this run");
  fs.writeFileSync(path.join(runDir, "config.resolved.json"), JSON.stringify(DEFAULT_CONFIG));
  if (resumeAction !== "planning") {
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan));
  }

  const exec = execFor(repo);
  const state: RunState = {
    version: 1,
    status: "running",
    stage: resumeAction === "planning" ? "planning" : "implementing",
    resumeAction,
    iteration: resumeAction === "planning" ? 0 : 1,
    maxIterations: 3,
    attempt: 1,
    planValid: resumeAction !== "planning",
    checksPass: false,
    reviewStatus: null,
    reviewFindingCount: { blocking: 0, important: 0, minor: 0 },
    repoRoot: repo,
    baseHead: await getGitHead(exec),
    workspaceFingerprint: await fingerprintWorkspace(exec, [runDir]),
    inFlightRole: inFlightCoder ? "coder" : undefined,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state));
  return { repo, artifactRoot, runId, runDir, exec, state };
}

describe("loadResumeRun abandoned workflows", () => {
  it("recovers partial coder changes left by a crashed parent process", async () => {
    const fixture = await createAbandonedRun();
    fs.writeFileSync(path.join(fixture.repo, "work.txt"), "partial coder edit\n");

    const loaded = await loadResumeRun(
      fixture.artifactRoot,
      fixture.runId,
      fixture.repo,
      fixture.exec,
    );

    assert.equal(loaded.resume.state.status, "interrupted");
    assert.equal(loaded.resume.state.interruptionKind, "unexpected");
    assert.match(loaded.resume.state.error!, /partial changes/);
    assert.equal(loaded.resume.plan?.goal, plan.goal);
    assert.equal(
      loaded.resume.state.workspaceFingerprint,
      await fingerprintWorkspace(fixture.exec, [fixture.runDir]),
    );
  });

  it("rejects changed workspaces when an abandoned non-writing stage was active", async () => {
    const fixture = await createAbandonedRun("planning");
    fs.writeFileSync(path.join(fixture.repo, "work.txt"), "unexpected edit\n");

    await assert.rejects(
      loadResumeRun(fixture.artifactRoot, fixture.runId, fixture.repo, fixture.exec),
      /working tree has changed/,
    );
  });

  it("rejects changed workspaces at a pending coder checkpoint", async () => {
    const fixture = await createAbandonedRun("coder", false);
    fs.writeFileSync(path.join(fixture.repo, "work.txt"), "unexpected edit\n");

    await assert.rejects(
      loadResumeRun(fixture.artifactRoot, fixture.runId, fixture.repo, fixture.exec),
      /working tree has changed/,
    );
  });

  it("force-resume rebases a changed workspace without relaxing the HEAD check", async () => {
    const fixture = await createAbandonedRun("planning");
    fs.writeFileSync(path.join(fixture.repo, "work.txt"), "intentional external edit\n");

    const loaded = await loadResumeRun(
      fixture.artifactRoot,
      fixture.runId,
      fixture.repo,
      fixture.exec,
      { forceWorkspace: true },
    );

    assert.equal(loaded.resume.state.status, "interrupted");
    assert.match(loaded.resume.state.error!, /force-resume/);
    assert.equal(
      loaded.resume.state.workspaceFingerprint,
      await fingerprintWorkspace(fixture.exec, [fixture.runDir]),
    );
  });

  it("rejects a HEAD change even when the abandoned coder left partial changes", async () => {
    const fixture = await createAbandonedRun();
    fs.writeFileSync(path.join(fixture.repo, "work.txt"), "partial coder edit\n");
    git(fixture.repo, ["add", "work.txt"]);
    git(fixture.repo, ["commit", "-qm", "external commit"]);

    await assert.rejects(
      loadResumeRun(fixture.artifactRoot, fixture.runId, fixture.repo, fixture.exec),
      /repository HEAD changed/,
    );
  });
});
