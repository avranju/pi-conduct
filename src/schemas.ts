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

/** Runtime JSON Schema supplied to the planner for its structured handoff. */
export const IMPLEMENTATION_PLAN_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ImplementationPlan",
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "assumptions",
    "risks",
    "filesToInspect",
    "filesToModify",
    "filesToCreate",
    "typesToCreate",
    "controlFlow",
    "errorHandling",
    "tests",
    "acceptanceCriteria",
    "implementationOrder",
  ],
  properties: {
    goal: { type: "string", minLength: 1 },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    filesToInspect: { type: "array", items: { type: "string" } },
    filesToModify: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason", "plannedChanges"],
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          plannedChanges: { type: "array", items: { type: "string" } },
        },
      },
    },
    filesToCreate: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason", "plannedContentsSummary"],
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
          plannedContentsSummary: { type: "string" },
        },
      },
    },
    typesToCreate: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "location", "purpose"],
        properties: {
          name: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "struct",
              "enum",
              "type",
              "interface",
              "trait",
              "class",
              "function",
              "other",
            ],
          },
          location: { type: "string" },
          purpose: { type: "string" },
          fieldsOrSignature: { type: "string" },
        },
      },
    },
    controlFlow: { type: "array", items: { type: "string" } },
    errorHandling: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "description"],
        properties: {
          path: { type: "string" },
          kind: {
            type: "string",
            enum: ["unit", "integration", "snapshot", "manual", "other"],
          },
          description: { type: "string" },
        },
      },
    },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    implementationOrder: { type: "array", items: { type: "string" } },
  },
} as const;

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

/** Runtime JSON Schema supplied to the coder for its structured handoff. */
export const CODER_COMPLIANCE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "CoderCompliance",
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "filesChanged",
    "planItemsCompleted",
    "planItemsSkipped",
    "reviewerItemsAddressed",
    "commandsRun",
    "knownIssues",
  ],
  properties: {
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    planItemsCompleted: { type: "array", items: { type: "string" } },
    planItemsSkipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "reason"],
        properties: {
          item: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    reviewerItemsAddressed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "status", "notes"],
        properties: {
          item: { type: "string" },
          status: {
            type: "string",
            enum: ["addressed", "partially_addressed", "not_addressed"],
          },
          notes: { type: "string" },
        },
      },
    },
    commandsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "purpose"],
        properties: {
          command: { type: "string" },
          purpose: { type: "string" },
        },
      },
    },
    knownIssues: { type: "array", items: { type: "string" } },
  },
} as const;

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

/** Runtime JSON Schema supplied to the reviewer for its structured handoff. */
export const REVIEW_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ReviewResult",
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "findings", "testsToRun", "riskNotes"],
  properties: {
    status: {
      type: "string",
      enum: ["approved", "needs_changes", "blocked"],
    },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "issue", "expectedFix", "rationale"],
        properties: {
          severity: {
            type: "string",
            enum: ["blocking", "important", "minor"],
          },
          file: { type: "string" },
          issue: { type: "string" },
          expectedFix: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    testsToRun: { type: "array", items: { type: "string" } },
    riskNotes: { type: "array", items: { type: "string" } },
    approvalRationale: { type: "string" },
  },
} as const;

// --- Check Result ---

export interface CheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Path to the full persisted artifact for this result, when available. */
  artifactPath?: string;
}

export interface CheckGroup {
  groupName: string;
  results: CheckResult[];
}

// --- Model Role Config ---

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
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

// --- Safety Config ---

export interface SafetyConfig {
  /**
   * When false, block obvious network and package-install commands issued by
   * agent bash tools (curl, wget, npm/pnpm/cargo/pip/go install, etc.).
   * Default: false.
   */
  allowNetwork: boolean;
  /**
   * Additional regex patterns to block in agent bash commands, on top of the
   * built-in dangerous-command patterns.
   */
  blockedCommandPatterns: string[];
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
  safety: SafetyConfig;
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
    requirePassingChecks: false,
    continueAfterCheckFailure: true,
    minorFindingIterationCutoff: 3,
  },
  safety: {
    allowNetwork: false,
    blockedCommandPatterns: [],
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

// --- Run State Machine (§6) ---

export type RunStage =
  | "idle"
  | "planning"
  | "validatingPlan"
  | "implementing"
  | "runningChecks"
  | "reviewing"
  | "fixing"
  | "completed"
  | "failed"
  | "needsUserIntervention";

export interface RunState {
  stage: RunStage;
  iteration: number;
  maxIterations: number;
  planValid: boolean;
  checksPass: boolean;
  reviewStatus: ReviewStatus | null;
  reviewFindingCount: { blocking: number; important: number; minor: number };
  error?: string;
  updatedAt: string;
}

export function emptyRunState(maxIterations: number): RunState {
  return {
    stage: "idle",
    iteration: 0,
    maxIterations,
    planValid: false,
    checksPass: false,
    reviewStatus: null,
    reviewFindingCount: { blocking: 0, important: 0, minor: 0 },
    updatedAt: new Date().toISOString(),
  };
}
