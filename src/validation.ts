// ============================================================================
// Schema validation for structured agent outputs (§2.7, §2.8, §2.12, §20)
//
// "Never let prose be the protocol." Every agent handoff is validated against
// the strict schemas before the supervisor proceeds.
// ============================================================================

import type {
  ImplementationPlan,
  CoderCompliance,
  ReviewResult,
  ReviewFinding,
  ReviewStatus,
} from "./schemas.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// --- ImplementationPlan (§10.2) ---

const PLAN_KINDS = new Set([
  "struct",
  "enum",
  "type",
  "interface",
  "trait",
  "class",
  "function",
  "other",
]);

const TEST_KINDS = new Set(["unit", "integration", "snapshot", "manual", "other"]);

export function validateImplementationPlan(plan: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(plan)) {
    return { valid: false, errors: ["Plan is not an object"] };
  }

  const requireString = (key: string) => {
    if (typeof plan[key] !== "string" || (plan[key] as string).length === 0) {
      errors.push(`Missing or empty required field: ${key}`);
    }
  };
  const requireStringArray = (key: string) => {
    if (!isStringArray(plan[key])) {
      errors.push(`Field ${key} must be a string array`);
    }
  };

  requireString("goal");
  requireStringArray("assumptions");
  requireStringArray("risks");
  requireStringArray("filesToInspect");
  requireStringArray("controlFlow");
  requireStringArray("errorHandling");
  requireStringArray("acceptanceCriteria");
  requireStringArray("implementationOrder");

  // filesToModify
  if (!Array.isArray(plan.filesToModify)) {
    errors.push("Field filesToModify must be an array");
  } else {
    plan.filesToModify.forEach((f, i) => {
      if (!isObject(f) || typeof f.path !== "string" || typeof f.reason !== "string" || !isStringArray(f.plannedChanges)) {
        errors.push(`filesToModify[${i}] must have { path, reason, plannedChanges[] }`);
      }
    });
  }

  // filesToCreate
  if (!Array.isArray(plan.filesToCreate)) {
    errors.push("Field filesToCreate must be an array");
  } else {
    plan.filesToCreate.forEach((f, i) => {
      if (!isObject(f) || typeof f.path !== "string" || typeof f.reason !== "string" || typeof f.plannedContentsSummary !== "string") {
        errors.push(`filesToCreate[${i}] must have { path, reason, plannedContentsSummary }`);
      }
    });
  }

  // typesToCreate
  if (!Array.isArray(plan.typesToCreate)) {
    errors.push("Field typesToCreate must be an array");
  } else {
    plan.typesToCreate.forEach((t, i) => {
      if (!isObject(t) || typeof t.name !== "string" || typeof t.kind !== "string" || !PLAN_KINDS.has(t.kind) || typeof t.location !== "string" || typeof t.purpose !== "string") {
        errors.push(`typesToCreate[${i}] must have { name, kind (enum), location, purpose }`);
      }
    });
  }

  // tests
  if (!Array.isArray(plan.tests)) {
    errors.push("Field tests must be an array");
  } else {
    plan.tests.forEach((t, i) => {
      if (!isObject(t) || typeof t.kind !== "string" || !TEST_KINDS.has(t.kind) || typeof t.description !== "string") {
        errors.push(`tests[${i}] must have { kind (enum), description }`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

// --- CoderCompliance (§11.2) ---

const COMPLIANCE_STATUSES = new Set(["addressed", "partially_addressed", "not_addressed"]);

export function validateCoderCompliance(compliance: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(compliance)) {
    return { valid: false, errors: ["CoderCompliance is not an object"] };
  }

  if (typeof compliance.summary !== "string") {
    errors.push("Missing or invalid field: summary");
  }
  if (!isStringArray(compliance.filesChanged)) {
    errors.push("Field filesChanged must be a string array");
  }
  if (!isStringArray(compliance.planItemsCompleted)) {
    errors.push("Field planItemsCompleted must be a string array");
  }
  if (!Array.isArray(compliance.planItemsSkipped)) {
    errors.push("Field planItemsSkipped must be an array");
  } else {
    compliance.planItemsSkipped.forEach((s, i) => {
      if (!isObject(s) || typeof s.item !== "string" || typeof s.reason !== "string") {
        errors.push(`planItemsSkipped[${i}] must have { item, reason }`);
      }
    });
  }
  if (!Array.isArray(compliance.reviewerItemsAddressed)) {
    errors.push("Field reviewerItemsAddressed must be an array");
  } else {
    compliance.reviewerItemsAddressed.forEach((s, i) => {
      if (!isObject(s) || typeof s.item !== "string" || typeof s.status !== "string" || !COMPLIANCE_STATUSES.has(s.status) || typeof s.notes !== "string") {
        errors.push(`reviewerItemsAddressed[${i}] must have { item, status (enum), notes }`);
      }
    });
  }
  if (!Array.isArray(compliance.commandsRun)) {
    errors.push("Field commandsRun must be an array");
  } else {
    compliance.commandsRun.forEach((c, i) => {
      if (!isObject(c) || typeof c.command !== "string" || typeof c.purpose !== "string") {
        errors.push(`commandsRun[${i}] must have { command, purpose }`);
      }
    });
  }
  if (!isStringArray(compliance.knownIssues)) {
    errors.push("Field knownIssues must be a string array");
  }

  return { valid: errors.length === 0, errors };
}

// --- ReviewResult (§12.2, §12.3) ---

const REVIEW_STATUSES = new Set<ReviewStatus>(["approved", "needs_changes", "blocked"]);
const REVIEW_SEVERITIES = new Set(["blocking", "important", "minor"]);

export function validateReviewResult(review: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(review)) {
    return { valid: false, errors: ["ReviewResult is not an object"] };
  }

  if (typeof review.status !== "string" || !REVIEW_STATUSES.has(review.status as ReviewStatus)) {
    errors.push("Field status must be one of: approved, needs_changes, blocked");
  }
  if (typeof review.summary !== "string") {
    errors.push("Missing or invalid field: summary");
  }
  if (!Array.isArray(review.findings)) {
    errors.push("Field findings must be an array");
  } else {
    review.findings.forEach((f, i) => {
      if (!isObject(f)) {
        errors.push(`findings[${i}] must be an object`);
        return;
      }
      const finding = f as Partial<ReviewFinding>;
      if (!isObject(f) || typeof finding.severity !== "string" || !REVIEW_SEVERITIES.has(finding.severity) || typeof finding.issue !== "string" || typeof finding.expectedFix !== "string" || typeof finding.rationale !== "string") {
        errors.push(`findings[${i}] must have { severity (enum), issue, expectedFix, rationale }`);
      }
      if (finding.file !== undefined && typeof finding.file !== "string") {
        errors.push(`findings[${i}].file must be a string when present`);
      }
    });
  }
  if (!isStringArray(review.testsToRun)) {
    errors.push("Field testsToRun must be a string array");
  }
  if (!isStringArray(review.riskNotes)) {
    errors.push("Field riskNotes must be a string array");
  }
  if (review.approvalRationale !== undefined && typeof review.approvalRationale !== "string") {
    errors.push("Field approvalRationale must be a string when present");
  }

  return { valid: errors.length === 0, errors };
}
