/** Offline production-worker permission smoke. Every executable command and
 * file is confined to mkdtemp-owned Git projects. No real account/API key. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const caseOption = process.argv.indexOf("--case");
const caseFilter = caseOption >= 0 ? process.argv[caseOption + 1] : undefined;
if (caseOption >= 0 && !caseFilter)
  throw new Error("--case requires a case ID");
const approvalPlan =
  "## Owned native approval\n\nOnly inspect this temporary project.\nNo user files or external services.\n";
const runtime = path.resolve("src-tauri/resources/zcode-runtime");
const directory = await mkdtemp(
  path.join(tmpdir(), "lolicode-native-permissions-"),
);
const privateRoot = path.join(directory, "private");
await mkdir(privateRoot);
const preload = path.join(directory, "offline-network.mjs");
await writeFile(
  preload,
  `
import http from "node:http"; import https from "node:https"; import { syncBuiltinESMExports } from "node:module";
const local = value => { try { const url = typeof value === "string" || value instanceof URL ? new URL(value) : value; return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname || url.host); } catch { return false; } };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!local(url)) throw new Error("External network disabled for offline smoke");
  return originalFetch(input, options);
};
for (const module of [http, https]) { const original = module.request; module.request = function(input, ...args) { if (!local(input)) throw new Error("External network disabled for offline smoke"); return original.call(this, input, ...args); }; }
syncBuiltinESMExports();
`,
);

const token = randomBytes(40).toString("hex");
const cases = new Map();
let modelRequests = 0;
let activeCase;
let worker;
let rpc;
let stderr = "";
const proof = {
  sourceRevision: "aac4755666d09fdcd70272fcf063c077a639015f",
  temporaryGitProjectsOnly: true,
  externalNetworkBlocked: true,
  controlPlane:
    "production worker local-only transport; no fake official response",
  paidCalls: 0,
  cases: [],
  cleanup: false,
};

function completion(response, input, delta, reason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: "offline-permission", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "offline-permission", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
  );
}

const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    modelRequests++;
    const current = cases.get(activeCase);
    if (!current) throw new Error("No active offline case");
    if (!input.tools?.length) {
      current.titleCalls = (current.titleCalls ?? 0) + 1;
      completion(
        response,
        input,
        { role: "assistant", content: "Offline permission fixture" },
        "stop",
      );
      return;
    }
    current.modelCalls++;
    if (!current.issued) {
      const tools =
        input.tools?.map((tool) => tool.function?.name).filter(Boolean) ?? [];
      const expected =
        current.kind === "plan_approval"
          ? "ExitPlanMode"
          : current.kind === "question"
            ? "AskUserQuestion"
            : current.kind === "write"
              ? "Write"
              : "Bash";
      const name = tools.find(
        (item) => item.toLowerCase() === expected.toLowerCase(),
      );
      if (!name)
        throw new Error(
          `Native ${expected} tool is unavailable; cannot prove the intended permission path`,
        );
      current.toolName = name;
      current.issued = true;
      const args =
        current.kind === "plan_approval"
          ? { plan: approvalPlan }
          : current.kind === "question"
            ? {
                questions: [
                  {
                    question: "Which offline fixture choices do you prefer?",
                    header: "Fixture",
                    multiSelect: current.multiple,
                    options: [
                      { label: "First", description: "First offline choice" },
                      { label: "Second", description: "Second offline choice" },
                    ],
                  },
                  {
                    question: "Which single offline fixture should continue?",
                    header: "Continue",
                    multiSelect: false,
                    options: [
                      { label: "Third", description: "Third offline choice" },
                      { label: "Fourth", description: "Fourth offline choice" },
                    ],
                  },
                ],
              }
            : current.kind === "write"
              ? {
                  file_path: current.writtenFile,
                  content:
                    current.mode === "plan"
                      ? "This must never be written in Plan mode."
                      : "Native FullAccess wrote this isolated fixture.\n",
                }
              : {
                  command: current.command,
                  description: "Run the isolated permission fixture",
                };
      completion(
        response,
        input,
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `fixture_${current.id}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    } else {
      current.toolResults =
        input.messages
          ?.filter((message) => message.role === "tool")
          .map((message) => message.content) ?? [];
      completion(
        response,
        input,
        { role: "assistant", content: `PERMISSION_FIXTURE_DONE_${current.id}` },
        "stop",
      );
    }
  } catch (error) {
    if (!response.headersSent)
      response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: error.message, type: "offline_fixture" },
      }),
    );
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const env = {};
for (const key of [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "SystemDrive",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "PATHEXT",
])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  HOME: directory,
  USERPROFILE: directory,
  APPDATA: path.join(directory, "appdata"),
  LOCALAPPDATA: path.join(directory, "localappdata"),
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand",
  NO_PROXY: "127.0.0.1,localhost",
  DO_NOT_TRACK: "1",
});
let failure;
try {
  worker = spawn(
    path.join(runtime, "node.exe"),
    [path.join(runtime, "worker.cjs")],
    { env, cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  worker.stderr.on("data", (bytes) => {
    stderr += bytes.toString().slice(0, 1500);
  });
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`Worker startup timeout: ${stderr}`)),
      45_000,
    );
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker exited ${code}: ${stderr}`));
    });
    worker.stdout.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const event = JSON.parse(buffer.slice(0, index));
        if (event.event === "ready") {
          clearTimeout(timer);
          resolve(event);
        }
      } catch {}
    });
    worker.stdin.write(JSON.stringify({ token, privateRoot }) + "\n");
  });
  rpc = async (method, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.result;
  };
  const catalog = {
    revision: 1,
    models: [
      {
        id: "fixture/permissions",
        providerId: "fixture",
        modelId: "permissions",
        name: "Offline permissions fixture",
        channelName: "Isolated local fake model",
      },
    ],
    defaultModel: "fixture/permissions",
    excludedSources: [],
  };
  const definitions = [
    {
      id: "guarded-read",
      permissionMode: "auto",
      mode: "build",
      kind: "bash",
      command: "git --version",
      expectPermission: false,
    },
    {
      id: "guarded-danger-denied",
      permissionMode: "auto",
      mode: "build",
      kind: "bash",
      command: "git clean -fd -- permission-fixture.txt",
      expectPermission: true,
      decision: "reject",
    },
    {
      id: "plan-write",
      permissionMode: "auto",
      mode: "plan",
      kind: "write",
      expectPermission: false,
    },
    {
      id: "full-access-clean",
      permissionMode: "full_access",
      mode: "build",
      kind: "bash",
      command: "git clean -fd -- permission-fixture.txt",
      expectPermission: false,
    },
    {
      id: "full-access-write",
      permissionMode: "full_access",
      mode: "build",
      kind: "write",
      expectPermission: false,
    },
    {
      id: "native-question-multi",
      permissionMode: "auto",
      mode: "build",
      kind: "question",
      multiple: true,
      expectPermission: false,
    },
    {
      id: "native-plan-approval",
      permissionMode: "auto",
      mode: "plan",
      kind: "plan_approval",
      expectPermission: false,
    },
  ];
  const selected = definitions.filter(
    (definition) => !caseFilter || definition.id === caseFilter,
  );
  assert.ok(selected.length, "Unknown permission smoke case");
  for (const definition of selected) {
    const project = await mkdtemp(path.join(directory, `${definition.id}-`));
    // Only our own temporary repository is ever passed to git clean.
    assert.ok(project.startsWith(`${directory}${path.sep}`));
    execFileSync("git", ["init", "--quiet", project], {
      env,
      windowsHide: true,
    });
    const fixtureFile = path.join(project, "permission-fixture.txt");
    await writeFile(
      fixtureFile,
      "Preserve unless this exact fixture grants full access.",
    );
    const current = {
      ...definition,
      project,
      fixtureFile,
      writtenFile: path.join(
        project,
        definition.mode === "plan"
          ? "plan-must-not-exist.txt"
          : "written-by-full-access.txt",
      ),
      issued: false,
      modelCalls: 0,
      permissionSeen: false,
      alwaysRejected: false,
      questionSeen: false,
    };
    cases.set(current.id, current);
    activeCase = current.id;
    await rpc("openProject", {
      path: project,
      catalog,
      gateway: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        bearerToken: "offline-local-fixture-lease",
      },
    });
    const session = await rpc("createSession", {
      modelId: catalog.defaultModel,
      mode: current.mode,
      permissionMode: current.permissionMode,
    });
    await rpc("sendMessage", {
      sessionId: session.id,
      requestId: randomUUID(),
      text: `Run fixture-case:${current.id}. Only use the predefined isolated tool call.`,
    });
    let snapshot;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      snapshot = await rpc("getSession", { sessionId: session.id });
      if (snapshot.permissions.length) {
        assert.equal(
          current.expectPermission,
          true,
          `${current.id}: unexpected permission request`,
        );
        assert.equal(
          current.permissionSeen,
          false,
          "A resolved permission unexpectedly reappeared",
        );
        current.permissionSeen = true;
        const permission = snapshot.permissions[0];
        assert.equal(permission.approvalMode, "user-once");
        await assert.rejects(
          rpc("replyPermission", {
            sessionId: session.id,
            requestId: permission.id,
            decision: "always",
          }),
          /单次|记住/,
        );
        current.alwaysRejected = true;
        assert.equal(
          await readFile(fixtureFile, "utf8"),
          "Preserve unless this exact fixture grants full access.",
        );
        await rpc("replyPermission", {
          sessionId: session.id,
          requestId: permission.id,
          decision: current.decision,
        });
      }
      if (snapshot.questions.length && !current.questionSeen) {
        const question = snapshot.questions[0];
        if (current.kind === "plan_approval") {
          assert.equal(snapshot.session.mode, "plan");
          assert.equal(question.fields.length, 1);
          assert.equal(question.fields[0].description, approvalPlan);
          assert.ok(
            question.fields[0].options.some(
              (option) => option.value === "approve",
            ),
          );
          current.planVisible = true;
          current.questionSeen = true;
          await rpc("replyQuestion", {
            sessionId: session.id,
            requestId: question.id,
            answer: { answer_0: "approve" },
          });
        } else {
          assert.equal(current.kind, "question", "Unexpected native question");
          assert.equal(
            question.fields[0].type,
            current.multiple ? "multiselect" : "string",
          );
          assert.equal(question.fields.length, 2);
          assert.equal(question.fields[1].type, "string");
          current.questionSeen = true;
          await rpc("replyQuestion", {
            sessionId: session.id,
            requestId: question.id,
            answer: {
              answer_0: current.multiple ? ["First", "Second"] : "First",
              answer_1: "Third",
            },
          });
        }
      }
      const done = snapshot.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "text" &&
            part.text.includes(`PERMISSION_FIXTURE_DONE_${current.id}`),
        ),
      );
      if (snapshot.status === "idle" && done) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      snapshot.status,
      "idle",
      `${current.id}: did not reach a real terminal state`,
    );
    assert.equal(current.permissionSeen, current.expectPermission);
    assert.ok(
      snapshot.messages.some((message) =>
        message.parts.some((part) =>
          part.text?.includes(`PERMISSION_FIXTURE_DONE_${current.id}`),
        ),
      ),
      `${current.id}: agent did not continue after the tool result`,
    );
    const exists = await stat(fixtureFile).then(
      () => true,
      () => false,
    );
    const writeExists = await stat(current.writtenFile).then(
      () => true,
      () => false,
    );
    if (current.id === "full-access-clean")
      assert.equal(
        exists,
        false,
        "Full access did not execute our isolated clean",
      );
    else assert.equal(exists, true, "Read/denied/Plan case removed a fixture");
    let writtenDiff;
    if (current.id === "full-access-write") {
      assert.equal(writeExists, true, "Full access did not write our fixture");
      assert.equal(
        await readFile(current.writtenFile, "utf8"),
        "Native FullAccess wrote this isolated fixture.\n",
      );
      writtenDiff = snapshot.diffs.find(
        (diff) =>
          path.basename(diff.path.replaceAll("\\", "/")) ===
          path.basename(current.writtenFile),
      );
      assert.ok(
        writtenDiff,
        "Real native write is missing from normalized diffs",
      );
      assert.match(
        writtenDiff.patch,
        /\+Native FullAccess wrote this isolated fixture\./,
      );
      assert.ok(writtenDiff.additions > 0, "Written diff has no added lines");
      assert.equal(writtenDiff.deletions, 0);
      // V4's authoritative file-change contract supplies patches and counts,
      // without an added/deleted discriminator; the adapter reports modified.
      assert.equal(writtenDiff.status, "modified");
    } else assert.equal(writeExists, false, "Unexpected fixture write");
    const toolParts = snapshot.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool");
    if (current.id === "guarded-read")
      assert.match(JSON.stringify(toolParts), /git version/i);
    if (current.id === "plan-write")
      assert.match(
        JSON.stringify(toolParts),
        /plan|read.only|not allowed|denied/i,
      );
    if (current.kind === "question") {
      assert.equal(current.questionSeen, true);
      assert.match(JSON.stringify(toolParts), /First/);
      if (current.multiple) assert.match(JSON.stringify(toolParts), /Second/);
      assert.match(JSON.stringify(toolParts), /Third/);
      assert.ok(toolParts.some((part) => part.state === "completed"));
    }
    if (current.kind === "plan_approval") {
      assert.equal(current.planVisible, true);
      assert.equal(current.questionSeen, true);
      assert.equal(snapshot.session.mode, "build");
      assert.ok(
        toolParts.some(
          (part) =>
            part.name === current.toolName && part.state === "completed",
        ),
      );
      assert.match(JSON.stringify(toolParts), /approved/i);
    }
    proof.cases.push({
      id: current.id,
      nativeTool: current.toolName,
      modelCalls: current.modelCalls,
      titleCalls: current.titleCalls ?? 0,
      permissionSeen: current.permissionSeen,
      alwaysRejected: current.alwaysRejected,
      questionSeen: current.questionSeen,
      ...(current.kind === "plan_approval"
        ? {
            planBodyVisible: current.planVisible,
            nativePlanExited: snapshot.session.mode === "build",
          }
        : {}),
      terminal: snapshot.status,
      continuedAfterResult: true,
      fixturePreserved: exists,
      planFileAbsent: !writeExists,
      writtenDiff: writtenDiff
        ? {
            path: path.basename(writtenDiff.path.replaceAll("\\", "/")),
            patch: writtenDiff.patch,
            additions: writtenDiff.additions,
            deletions: writtenDiff.deletions,
            status: writtenDiff.status,
          }
        : undefined,
      toolStates: toolParts.map((part) => part.state),
    });
  }
  proof.modelRequests = modelRequests;
  proof.success = true;
  await rpc("shutdown");
} catch (error) {
  failure = error;
  proof.success = false;
  proof.error = error.message;
} finally {
  if (worker && worker.exitCode == null) {
    worker.stdin.end();
    await Promise.race([
      new Promise((resolve) => worker.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          worker.kill();
          resolve();
        }, 12_000),
      ),
    ]);
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  proof.cleanup = true;
  await writeFile(
    path.join(
      tmpdir(),
      caseFilter
        ? "lolicode-native-permissions-filtered-proof.json"
        : "lolicode-native-permissions-proof.json",
    ),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof, null, 2));
}
if (failure) process.exitCode = 1;
