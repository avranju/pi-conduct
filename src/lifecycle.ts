export interface ActiveWorkflow {
  controller: AbortController;
  completion: Promise<void>;
  addCleanup(cleanup: () => void): void;
  finish(): void;
}

/** Reserve synchronously before the command's first await, including preflight work. */
export class WorkflowOwner {
  private active?: ActiveWorkflow;
  private closing = false;
  get isActive(): boolean { return this.active !== undefined; }

  begin(): ActiveWorkflow {
    if (this.closing) throw new Error("Conduct is shutting down");
    if (this.active) throw new Error("A Conduct workflow is already active");
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    let resolve!: () => void;
    const completion = new Promise<void>((done) => { resolve = done; });
    let finished = false;
    const run: ActiveWorkflow = {
      controller, completion,
      addCleanup: (cleanup) => {
        if (finished) cleanup();
        else cleanups.push(cleanup);
      },
      finish: () => {
        if (finished) return;
        finished = true;
        for (const cleanup of cleanups.reverse()) {
          try { cleanup(); } catch { /* Run cleanup must release every resource. */ }
        }
        if (this.active === run) this.active = undefined;
        resolve();
      },
    };
    this.active = run;
    return run;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const run = this.active;
    if (!run) return;
    run.controller.abort();
    // The command owns checkpoints and locks: wait until its finally has actually released them.
    await run.completion;
  }
}
