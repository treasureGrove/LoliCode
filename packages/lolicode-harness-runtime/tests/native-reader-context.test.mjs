import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(childProcess.execFile);
const projectionKeys = [
  "todos", "userQuestions", "tokenUsage", "contextPressure", "title", "goal", "plan",
  "modelSelection", "workingDirectory", "contextBreakdown", "inbox", "permissions",
  "subagentCatalog", "subagentTiming", "subagent", "sessionListMetadata", "imageLimits",
  "sessionStats", "turnOutline", "agentTeam", "conversationContinuation",
].sort();

async function temporaryDirectory(t, prefix) {
  const parent = path.resolve(os.tmpdir());
  const temporary = await mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    assert.equal(path.dirname(temporary), parent);
    assert.ok(path.basename(temporary).startsWith(prefix));
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return temporary;
}

async function seed(sessions, cwd, id, compression, teamMode) {
  const [{ Context }, session, projections, persistence, llm] = await Promise.all([
    import("@deepseek-ai/cordis"), import("@deepseek-ai/dsh-session"),
    import("@deepseek-ai/dsh-session-projection"), import("@deepseek-ai/dsh-session-persistence-jsonl"),
    import("@deepseek-ai/dsh-llm"),
  ]);
  const ctx = new Context();
  try {
    for (const [plugin, config] of [[session], [projections], [persistence, { root: sessions, compression }]]) {
      await ctx.plugin(plugin.default ?? plugin, config).await();
    }
    const journal = ctx.sessions.create(id, { meta: { cwd } });
    const selection = { provider: "fixture-only", model: "unavailable", reasoningEffort: "high" };
    journal.append("permission/preset", { preset: "danger-full-access" });
    journal.append("sandbox/mode", { mode: "danger-full-access" });
    journal.append("approval/policy", { policy: "never" });
    journal.append("session/end-seed", {});
    journal.append("plan/mode", { active: true });
    journal.append("model/selection", selection);
    journal.append("goal/change", {
      kind: "goal/change", version: 1, operation: "create", roundsStarted: 0,
      createdAt: 1700000000000, updatedAt: 1700000000000,
      goal: { id: "fixture-goal", revision: 1, objective: "Preserve every official projection", phase: "active", maxGoalRounds: 8 },
    });
    journal.append("session/title", { title: "Native reader fixture", messageSeqs: [], source: { kind: "user" } });
    journal.append("working-directory/change", { cwd: path.join(cwd, "recorded-workspace") });
    journal.append("turn/start", { turn: 1 });
    journal.append("user/message", llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "History fixture" }] }), { surfaceOp: "append" });
    journal.append("todo/write", { todos: [{ content: "Keep non-default state", status: "in_progress" }] });
    journal.append("step/start", { turn: 1, step: 1 });
    journal.append("request/header", { turn: 1, step: 1, reason: "initial", header: { config: selection } });
    journal.append("request/context", { provider: selection.provider, model: selection.model, contextWindow: 8192 });
    const stream = new llm.AssistantStreamAccumulator();
    stream.push({ time: Date.now(), chunk: { type: "text-delta", index: 0, text: "Preserved answer" } });
    const usage = { inputTokens: 17, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 2 };
    stream.push({ time: Date.now(), chunk: { type: "usage", usage } });
    journal.append("assistant/message", {
      turn: 1, step: 1, usage, stream: stream.snapshot(),
      message: llm.createAssistantMessage({ source: selection, content: [{ type: "text", text: "Preserved answer" }] }),
    }, { surfaceOp: "append" });
    journal.append("step/end", { turn: 1, step: 1 });
    journal.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    if (teamMode !== undefined) {
      // Persist the official rc.2 Team event vocabulary. Cold reads must
      // reconstruct the task board, not merely supply an empty default view.
      journal.append("team/mode", { enabled: true });
      const first = {
        id: "task-1", revision: 1, subject: "Read the stored history",
        description: "Preserve the upstream task projection", status: "pending",
        blockedBy: [], writeScopes: [],
      };
      journal.append("team/task", { version: 2, teamId: id, task: first });
      journal.append("team/task", { version: 2, teamId: id, task: { ...first, revision: 2, status: "completed" } });
      journal.append("team/task", { version: 2, teamId: id, task: {
        id: "task-2", revision: 1, subject: "Review the stored task board",
        description: "Derive readiness from the completed prerequisite", status: "pending",
        blockedBy: ["task-1"], writeScopes: ["src/reader.ts"],
      } });
      if (!teamMode) journal.append("team/mode", { enabled: false });
    }
    const handle = await ctx.sessionPersistence.create(journal.header);
    try { await handle.append(journal.snapshotEvents()); await handle.flush(); } finally { await handle.close(); }
  } finally {
    await ctx.fiber.dispose();
  }
}

async function guardedComparison(temporary) {
  // This runs in a dedicated process: any accidental shell/model/network
  // activation must fail, even when the parent environment has credentials.
  const forbidden = () => { throw new Error("Native history attempted process or network activation"); };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = forbidden;
  net.Socket.prototype.connect = forbidden;
  net.Server.prototype.listen = forbidden;
  globalThis.fetch = forbidden;
  syncBuiltinESMExports();
  const sessions = path.join(temporary, "sessions");
  const fullHome = path.join(temporary, "full");
  const leanHome = path.join(temporary, "lean");
  await mkdir(fullHome);
  await mkdir(leanHome);
  process.env.DSH_HOME = fullHome;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  process.chdir(fullHome);
  const fixtures = [
    ["compressed-fixture", undefined],
    ["team-enabled-fixture", true],
    ["team-disabled-fixture", false],
  ];
  for (const [id, teamMode] of fixtures) await seed(sessions, fullHome, id, "zstd", teamMode);
  const patch = path.join(fullHome, "read-only.json");
  await writeFile(patch, JSON.stringify([
    { id: "sdk-app-startup", disabled: true }, { id: "sdk-jsonrpc-server", disabled: true },
    { id: "session-persistence-jsonl", config: { root: sessions } },
    { id: "session-telemetry-otel", disabled: true }, { id: "plugin-manager", disabled: true },
  ]));
  const [{ runProfile }, { createLaunchEnvironmentSnapshot }, { readNativeSession }, { createNativeReaderContext }] = await Promise.all([
    import("@deepseek-ai/dsh/lib/profile-boot.js"), import("@deepseek-ai/dsh-launch-environment"),
    import("../host-session-native.mjs"), import("../host-native-reader-context.mjs"),
  ]);
  let full;
  let lean;
  try {
    full = await runProfile({ profile: "sdk", patchFiles: [patch], args: [], environment: createLaunchEnvironmentSnapshot([{ source: "process", values: process.env }]) });
    const before = new Map();
    for (const entry of await readdir(sessions, { recursive: true })) {
      const file = path.join(sessions, entry);
      if ((await stat(file)).isFile()) before.set(entry, { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs });
    }
    process.env.DSH_HOME = leanHome;
    process.chdir(leanHome);
    lean = await createNativeReaderContext(leanHome, sessions);
    assert.equal(lean.agents.list().length, 0);
    assert.equal(lean.get("webServer"), undefined);
    assert.equal(lean.get("pluginManager"), undefined);
    for (const [id, teamMode] of fixtures) {
      const expected = await readNativeSession(full.ctx, id, { maxMessages: 200 });
      const actual = await readNativeSession(lean, id, { maxMessages: 200 });
      assert.deepEqual(actual, expected);
      assert.deepEqual(Object.keys(actual.projections.values).sort(), projectionKeys);
      const values = actual.projections.values;
      assert.equal(values.goal.goal.objective, "Preserve every official projection");
      assert.equal(values.plan.active, true);
      assert.equal(values.permissions.currentValue, "danger-full-access");
      assert.equal(values.todos[0].status, "in_progress");
      assert.equal(values.modelSelection.next.model, "unavailable");
      assert.equal(values.tokenUsage.outputTokens, 9);
      assert.equal(values.contextPressure.contextWindow, 8192);
      assert.ok(values.contextBreakdown.messageTokens > 0);
      assert.equal(values.agentTeam.enabled, teamMode === true);
      assert.equal(values.agentTeam.failure, undefined);
      if (teamMode === undefined) {
        assert.deepEqual(values.agentTeam.tasks, []);
      } else {
        assert.equal(values.agentTeam.tasks.length, 2);
        assert.equal(values.agentTeam.tasks[0].revision, 2);
        assert.equal(values.agentTeam.tasks[0].status, "completed");
        assert.equal(values.agentTeam.tasks[1].subject, "Review the stored task board");
        assert.deepEqual(values.agentTeam.tasks[1].blockedBy, ["task-1"]);
        assert.deepEqual(values.agentTeam.tasks[1].writeScopes, ["src/reader.ts"]);
        assert.equal(values.agentTeam.tasks[1].ready, true);
      }
      assert.equal(lean.sessions.get(id), undefined);
    }
    assert.equal(lean.agents.list().length, 0);
    assert.equal(full.ctx.agents.list().length, 0);
    const after = [];
    for (const entry of await readdir(sessions, { recursive: true })) {
      const file = path.join(sessions, entry);
      if (!(await stat(file)).isFile()) continue;
      after.push(entry);
      assert.deepEqual(await readFile(file), before.get(entry)?.bytes);
      assert.equal((await stat(file)).mtimeMs, before.get(entry)?.mtime);
    }
    assert.deepEqual(after.sort(), [...before.keys()].sort());
  } finally {
    if (lean) await lean.fiber.dispose();
    if (full) await full.shutdown.shutdown(0);
  }
}

if (process.argv[2] === "guarded-comparison") {
  await guardedComparison(process.argv[3]);
} else {
  test("lean reader preserves full SDK Gateway state and saved Team modes without activation", { timeout: 60_000 }, async (t) => {
    const temporary = await temporaryDirectory(t, "lolicode-native-context-test-");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)));
    const output = await execFile(process.execPath, [fileURLToPath(import.meta.url), "guarded-comparison", temporary], { env, cwd: root, windowsHide: true, timeout: 50_000 });
    assert.equal(output.stdout, "");
  });

  test("cold reader cleans its disposable HOME after missing or malformed histories", { timeout: 30_000 }, async (t) => {
    const temporary = await temporaryDirectory(t, "lolicode-native-cleanup-test-");
    const sessions = path.join(temporary, "sessions");
    const env = { TEMP: temporary, TMP: temporary, TMPDIR: temporary };
    for (const [id, code] of [["missing-fixture", 2], ["broken-fixture", 1]]) {
      if (id === "broken-fixture") {
        await seed(sessions, temporary, id, "zstd");
        const journal = (await readdir(sessions, { recursive: true })).find(entry => entry.endsWith(".jsonl.zstd"));
        assert.ok(journal);
        await writeFile(path.join(sessions, journal), "malformed fixture journal\n");
      }
      await assert.rejects(execFile(process.execPath, [path.join(root, "host-session-native.mjs"), sessions, id], { env, windowsHide: true, timeout: 20_000 }), error => {
        assert.equal(error.code, code);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /LOLICODE_SESSION_LOG_(?:MISSING|UNREADABLE)/);
        return true;
      });
      assert.deepEqual((await readdir(temporary)).filter(entry => entry.startsWith("lolicode-native-read-")), []);
    }
    const journal = (await readdir(sessions, { recursive: true })).find(entry => entry.endsWith(".jsonl.zstd"));
    assert.equal(await readFile(path.join(sessions, journal), "utf8"), "malformed fixture journal\n");
  });
}
