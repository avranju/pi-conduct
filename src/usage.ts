import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "./schemas.js";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}
export interface RoleSessionUsage extends UsageTotals {
  role: AgentRole;
  label: string;
  attempt: number;
  sessionId: string;
  sessionFile?: string;
  models: string[];
}
export interface RunUsage {
  version: 1;
  sessions: RoleSessionUsage[];
  totals: UsageTotals;
}
export function totalUsage(sessions: readonly UsageTotals[]): UsageTotals {
  const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  for (const session of sessions) {
    for (const key of Object.keys(total) as Array<keyof UsageTotals>) total[key] += session[key];
  }
  return total;
}

/** Raw persisted messages retain auto-retry errors and compacted history omitted by session.messages. */
export function getSessionMessages(session: AgentSession) {
  return session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
}

/** Persist each finished session, including failed/retried sessions, across workflow resumes. */
export class RunUsageLedger {
  private readonly sessions = new Map<string, RoleSessionUsage>();
  constructor(private readonly root?: string) {
    const file = root && path.join(root, "usage.json");
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as RunUsage;
      if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error("Invalid Conduct usage checkpoint");
      for (const session of saved.sessions) {
        if (!session || typeof session.sessionId !== "string" || typeof session.label !== "string" ||
            !["planner", "coder", "reviewer"].includes(session.role) || !Number.isSafeInteger(session.attempt) || session.attempt < 1 ||
            !Array.isArray(session.models) || session.models.some((model) => typeof model !== "string") ||
            Object.keys(totalUsage([])).some((key) => !Number.isFinite(session[key as keyof UsageTotals]) || session[key as keyof UsageTotals] < 0)) {
          throw new Error("Invalid Conduct session usage");
        }
        this.sessions.set(session.sessionId, session);
      }
    }
  }
  record(role: AgentRole, label: string, attempt: number, session: AgentSession): void {
    const stats = session.getSessionStats();
    const models = [...new Set(getSessionMessages(session).flatMap((message) =>
      message.role === "assistant" ? [`${message.provider}/${message.model}`] : [],
    ))];
    this.sessions.set(stats.sessionId, {
      role, label, attempt, sessionId: stats.sessionId, sessionFile: stats.sessionFile,
      models, ...stats.tokens, cost: stats.cost,
    });
    if (this.root) {
      const file = path.join(this.root, "usage.json");
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    }
  }
  snapshot(): RunUsage {
    const sessions = [...this.sessions.values()].map((value) => structuredClone(value));
    return { version: 1, sessions, totals: totalUsage(sessions) };
  }
}

export function formatUsage(usage: UsageTotals): string {
  return `Tokens: ↑${usage.input} ↓${usage.output} · cache read ${usage.cacheRead}, write ${usage.cacheWrite} · Cost: $${usage.cost.toFixed(4)}`;
}
