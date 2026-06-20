// ============================================================================
// Schemas for Pi Conduct Extension
// ============================================================================

// --- Implementation Plan (Planner output) ---

export type PlanFileToModify = {
  path: string;
  reason: string;
  plannedChanges: string[];
};

export type PlanFileToCreate = {
  path: string;
  reason: string;
  plannedContentsSummary: string;
};

export type PlanTypeToCreate = {
  name: string;
  kind: "struct" | "enum" | "type" | "interface" | "trait" | "class" | "function" | "other";
  location: string;
  purpose: string;
  fieldsOrSignature?: string;
};

export type PlanTest = {
  path?: string;
  kind: "unit" | "integration" | "snapshot" | "manual" | "other";
  description: string;
};

export interface ImplementationPlan {
  goal: string;
  assumptions: string[];
  risks: string[];
  filesToInspect: string[];
  filesToModify: PlanFileToModify[];
  filesToCreate: PlanFileToCreate[];
  typesToCreate: PlanTypeToCreate[];
  controlFlow: string[];
  errorHandling: string[];
  tests: PlanTest[];
  acceptanceCriteria: string[];
  implementationOrder: string[];
}

// --- Coder Compliance Report ---

export interface CoderCompliance {
  summary: string;
  filesChanged: string[];
  planItemsCompleted: string[];
  planItemsSkipped: Array<{
    item: string;
    reason: string;
  }>;
  reviewerItemsAddressed: Array<{
    item: string;
    status: "addressed" | "partially_addressed" | "not_addressed";
    notes: string;
  }>;
  commandsRun: Array<{
    command: string;
    purpose: string;
  }>;
  knownIssues: string[];
}

// --- Reviewer Output ---

export type ReviewSeverity = "blocking" | "important" | "minor";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  issue: string;
  expectedFix: string;
  rationale: string;
}

export type ReviewStatus = "approved" | "needs_changes" | "blocked";

export interface ReviewResult {
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
  testsToRun: string[];
  riskNotes: string[];
  approvalRationale?: string;
}

// --- Check Result ---

export interface CheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CheckGroup {
  groupName: string;
  results: CheckResult[];
}

// --- Model Role Config ---

export interface ModelConfig {
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

// --- Loop Config ---

export interface LoopConfig {
  maxIterations: number;
  requireCleanGit: boolean;
  requireApproval: boolean;
  requirePassingChecks: boolean;
  continueAfterCheckFailure: boolean;
  minorFindingIterationCutoff: number;
}

// --- Artifact Config ---

export interface ArtifactConfig {
  root: string;
  keepTranscripts: boolean;
  keepDiffs: boolean;
}

// --- Extension Config ---

export interface ConductConfig {
  models: {
    planner: ModelConfig;
    coder: ModelConfig;
    reviewer: ModelConfig;
  };
  loop: LoopConfig;
  commands: {
    format: string[];
    lint: string[];
    test: string[];
  };
  artifacts: ArtifactConfig;
}

// --- Default Config ---

export const DEFAULT_CONFIG: ConductConfig = {
  models: {
    planner: {
      provider: "openai",
      model: "gpt-5.2",
      thinkingLevel: "high",
    },
    coder: {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "off",
    },
    reviewer: {
      provider: "openai",
      model: "gpt-5.2",
      thinkingLevel: "high",
    },
  },
  loop: {
    maxIterations: 5,
    requireCleanGit: true,
    requireApproval: true,
    requirePassingChecks: true,
    continueAfterCheckFailure: true,
    minorFindingIterationCutoff: 3,
  },
  commands: {
    format: [],
    lint: [],
    test: [],
  },
  artifacts: {
    root: ".pi/conduct/runs",
    keepTranscripts: true,
    keepDiffs: true,
  },
};

// --- Run State ---

export interface CheckOutputSummary {
  format: { passed: boolean; summary: string; fullPath: string };
  lint: { passed: boolean; summary: string; fullPath: string };
  test: { passed: boolean; summary: string; fullPath: string };
}

export interface RunState {
  stage:
    | "idle"
    | "initializing"
    | "validatingWorkspace"
    | "planning"
    | "validatingPlan"
    | "implementing"
    | "runningChecks"
    | "reviewing"
    | "fixing"
    | "completed"
    | "failed"
    | "needsUserIntervention";
  iteration: number;
  maxIterations: number;
  planValid: boolean;
  checksPass: boolean;
  reviewStatus: ReviewStatus | null;
  reviewFindingCount: { blocking: number; important: number; minor: number };
  error?: string;
}
