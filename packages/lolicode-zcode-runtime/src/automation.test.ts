import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AutomationOwner } from "./automation.js";
import type { NativeServiceAccess } from "./automation.js";
import type { Shared } from "./services.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(extra: Partial<NativeServiceAccess> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lolicode-automation-"));
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let counter = 0;
  const task = {
    async createTask(input: unknown) {
      return { taskId: `task-${++counter}` };
    },
    async resumeTask() {},
    async setAutomationSessionConfig() {},
    async sendPrompt(input: Record<string, unknown>) {
      sent.push(input);
    },
    onDynamicTaskTerminalOutcome(taskId: string) {
      return (listener: (event: unknown) => void) => {
        const list = listeners.get(taskId) ?? new Set();
        listeners.set(taskId, list);
        list.add(listener);
        return { dispose: () => list.delete(listener) };
      };
    },
  };
  const modelSelection = {
    providerId: "fixture",
    modelId: "no-network",
    options: { reasoningLevel: "none" },
  };
  const services = {
    zcodeTaskService: task,
    modelSelectionService: {
      async getView() {
        return {
          preferredSelection: modelSelection,
          effectiveSelection: modelSelection,
        };
      },
    },
    ...extra,
  } as unknown as NativeServiceAccess;
  const owner = new AutomationOwner({
    configDirectory: directory,
    services,
    pollIntervalMs: 60_000,
  });
  cleanups.push(async () => {
    await owner.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await owner.repo.ensureReady();
  const automation = await owner.service.create({
    title: "Isolated offline task",
    cronExpr: "0 0 1 1 *",
    prompt: "Fixture only; do not invoke a model",
    workspacePath: directory,
    recurring: true,
    modelSelection: modelSelection as Shared.ModelSelection,
  });
  return {
    owner,
    directory,
    automation,
    sent,
    listeners,
    task,
    modelSelection,
  };
}

test("manual ACK stays running and single-flight until the matching real terminal input", async () => {
  const { owner, automation, sent, listeners } = await fixture();
  assert.deepEqual(await owner.runNow(automation.automationId), {
    status: "queued",
  });
  assert.equal(sent.length, 1);
  const [run] = await owner.service.listRuns(automation.automationId);
  assert.equal(run.dispatchStatus, "dispatched");
  assert.equal(run.outcome, "running");
  assert.deepEqual(await owner.runNow(automation.automationId), {
    status: "duplicate",
  });
  for (const listener of listeners.get("task-1")!)
    listener({ inputId: "another-input", outcome: "succeeded" });
  assert.equal(
    (await owner.service.listRuns(automation.automationId))[0].outcome,
    "running",
  );
  for (const listener of [...listeners.get("task-1")!])
    listener({ inputId: run.runId, outcome: "succeeded" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    (await owner.service.listRuns(automation.automationId))[0].outcome,
    "succeeded",
  );
  assert.deepEqual(await owner.runNow(automation.automationId), {
    status: "queued",
  });
});

test("manual runs and schedule edits survive a repository reopen", async () => {
  const { owner, automation, directory } = await fixture();
  await owner.service.update(automation.automationId, {
    title: "Persisted title",
    cronExpr: "30 7 * * 1",
  });
  await owner.runNow(automation.automationId);
  await owner.dispose();
  const reopened = new AutomationOwner({
    configDirectory: directory,
    services: {},
  });
  cleanups.push(() => reopened.dispose());
  assert.equal(
    (await reopened.service.get(automation.automationId))?.title,
    "Persisted title",
  );
  assert.equal(
    (await reopened.service.listRuns(automation.automationId))[0].outcome,
    "stopped",
  );
});

test("failed dispatch records a failure and releases the manual claim for retry", async () => {
  const failure = {
    async getView() {
      throw new Error("fixture model unavailable");
    },
  };
  const { owner, automation, sent } = await fixture({
    modelSelectionService: failure as never,
  });
  await assert.rejects(
    owner.runNow(automation.automationId),
    /fixture model unavailable/,
  );
  assert.equal(sent.length, 0);
  const [run] = await owner.service.listRuns(automation.automationId);
  assert.equal(run.dispatchStatus, "failed_to_dispatch");
  assert.equal(run.outcome, "failed");
  await assert.rejects(
    owner.runNow(automation.automationId),
    /fixture model unavailable/,
  );
  assert.equal(
    (await owner.service.listRuns(automation.automationId)).length,
    2,
  );
});

test("the persistent poller really claims a due cron and dispatches its saved context", async () => {
  const { owner, automation, directory, sent } = await fixture();
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  try {
    database
      .prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?")
      .run(Date.now() - 1_000, automation.automationId);
  } finally {
    database.close();
  }
  await owner.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, automation.prompt);
  assert.equal(sent[0].automationId, automation.automationId);
  const [run] = await owner.service.listRuns(automation.automationId);
  assert.equal(run.trigger, "schedule");
  assert.equal(run.dispatchStatus, "dispatched");
  assert.equal(run.outcome, "running");
});

test("missed one-shot windows are recorded skipped without silently rescheduling a run", async () => {
  const { owner, directory, sent } = await fixture();
  const once = await owner.service.create({
    title: "Missed once",
    cronExpr: "0 0 1 1 *",
    relativeDelayMinutes: 1,
    prompt: "Must not be dispatched",
    workspacePath: directory,
    recurring: false,
  });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  try {
    database
      .prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?")
      .run(Date.now() - 10 * 60_000, once.automationId);
  } finally {
    database.close();
  }
  await owner.flush();
  assert.equal(sent.length, 0);
  const saved = await owner.service.get(once.automationId);
  assert.equal(saved?.lifecycleStatus, "completed");
  assert.equal(saved?.enabled, false);
  assert.equal(
    (await owner.service.listRuns(once.automationId))[0].dispatchStatus,
    "skipped",
  );
});

test("an unavailable remote identity never falls back to the local task runtime", async () => {
  const { owner, directory, sent } = await fixture();
  const remote = await owner.service.create({
    title: "Offline remote",
    cronExpr: "0 0 1 1 *",
    prompt: "No local fallback",
    workspacePath: "/remote/project",
    workspaceIdentity: "remote:ssh:fixture:22:tester:/remote/project",
    recurring: true,
  });
  await assert.rejects(owner.runNow(remote.automationId), /remote workspace/);
  assert.equal(sent.length, 0);
  assert.ok(directory);
});

test("update pause fences due cron claims and resumes each due run exactly once", async () => {
  const { owner, automation, directory, sent } = await fixture();
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  try {
    database
      .prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?")
      .run(Date.now() - 1_000, automation.automationId);
  } finally {
    database.close();
  }
  await owner.pauseDispatch();
  await owner.flush();
  assert.equal(owner.status().paused, true);
  assert.equal(sent.length, 0);
  assert.deepEqual(await owner.service.listRuns(automation.automationId), []);
  await assert.rejects(owner.runNow(automation.automationId), /更新/);
  owner.resumeDispatch();
  await owner.flush();
  await owner.flush();
  assert.equal(sent.length, 1);
  assert.equal(
    (await owner.service.listRuns(automation.automationId)).length,
    1,
  );
});

test("update pause drains late admission while preserving the true running outcome", async () => {
  const { owner, automation, task, listeners } = await fixture();
  let accept!: () => void;
  let entered!: () => void;
  const admission = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  task.sendPrompt = async () => {
    entered();
    await admission;
  };
  const sending = owner.runNow(automation.automationId);
  await started;
  let paused = false;
  const pausing = owner.pauseDispatch().then(() => {
    paused = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(paused, false);
  accept();
  await sending;
  await pausing;
  assert.equal(owner.busy(), true);
  const [run] = await owner.service.listRuns(automation.automationId);
  assert.equal(run.outcome, "running");
  assert.equal(run.dispatchStatus, "dispatched");
  assert.equal(owner.status().paused, true);
  for (const listener of [...listeners.get("task-1")!])
    listener({ inputId: run.runId, outcome: "succeeded" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(owner.busy(), false);
  assert.equal(
    (await owner.service.listRuns(automation.automationId))[0].outcome,
    "succeeded",
  );
});

test("an externally claimed manual run is explicitly rejected and released during update", async () => {
  const { owner, automation, sent } = await fixture();
  await owner.pauseDispatch();
  const claimed = await owner.service.runNow(automation.automationId);
  assert.ok(claimed);
  await assert.rejects(owner.dispatchManual(claimed), /更新/);
  assert.equal(sent.length, 0);
  const [run] = await owner.service.listRuns(automation.automationId);
  assert.equal(run.dispatchStatus, "failed_to_dispatch");
  assert.equal(run.outcome, "failed");
  owner.resumeDispatch();
  assert.deepEqual(await owner.runNow(automation.automationId), {
    status: "queued",
  });
});
