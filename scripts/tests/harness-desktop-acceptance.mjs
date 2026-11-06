// Runs a hidden Windows development build with a disposable profile and model.
// Run from a non-elevated shell so WebView2 honors the fixture debugging port.
// Usage: node scripts/tests/harness-desktop-acceptance.mjs [--permissions | --output-links | --compact | --dock-tools | --background-jobs | --native-modes | --switching | --session-export | --titles]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import {
  buildEnvironment,
  targetDirectory,
  windowsToolchainEnvironment,
} from "../dev/lolicode-development.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const permissionsOnly = process.argv.includes("--permissions");
const outputLinksOnly = process.argv.includes("--output-links");
const compactOnly = process.argv.includes("--compact");
const dockToolsOnly = process.argv.includes("--dock-tools");
const backgroundJobsOnly = process.argv.includes("--background-jobs");
const nativeModesOnly = process.argv.includes("--native-modes");
const switchingOnly = process.argv.includes("--switching");
const switchingReducedMotion = switchingOnly && process.env.LOLICODE_HARNESS_DESKTOP_REDUCED_MOTION === "1";
const switchingProfileScale = switchingOnly && process.env.LOLICODE_HARNESS_DESKTOP_PROFILE_SCALE === "1";
const sessionExportOnly = process.argv.includes("--session-export");
const titlesOnly = process.argv.includes("--titles");
const titles = {
  firstPrompt: "请整理故障排查顺序，并列出需要复核的检查项。",
  firstAnswer: "已经整理排查顺序和复核检查项。",
  generatedTitle: "整理故障排查清单",
  manualTitle: "手工保留的会话名称",
  nextPrompt: "继续核对上一项结果，保留已经确认的记录。",
  nextAnswer: "后续检查已完成，原有记录已保留。",
  manualPrompt: "复核修改后的清单，确保记录仍然完整。",
  manualAnswer: "清单已复核，记录完整。",
  racePrompt: "分析构建日志并标记第一次异常。",
  raceAnswer: "已定位构建日志中的第一次异常。",
  raceGeneratedTitle: "分析构建异常",
  raceManualTitle: "先手动确定的名称",
};
let titleRequests = 0;
let titleConversationTurns = 0;
let heldTitleReply;
const sessionExport = {
  title: "完整 Markdown 验收",
  emptyTitle: "空会话 Markdown 验收",
  legacyTitle: "旧会话 Markdown 验收",
  legacyId: "lc:" + randomUUID(),
  legacyHistory: "HARNESS_EXPORT_LEGACY_HISTORY",
  legacyPrompt: "HARNESS_EXPORT_LEGACY_PROMPT",
  legacyAnswer: "HARNESS_EXPORT_LEGACY_ANSWER",
  workerTitle: "Markdown 导出子任务",
  workerPrompt: "HARNESS_EXPORT_WORKER_PROMPT",
  workerAnswer: "HARNESS_EXPORT_WORKER_ANSWER",
  activePrompt: "HARNESS_EXPORT_ACTIVE_PROMPT",
  activeAnswer: "HARNESS_EXPORT_ACTIVE_ANSWER",
  turnPrefix: "HARNESS_EXPORT_TURN_",
  answerPrefix: "HARNESS_EXPORT_ANSWER_",
  turns: 22,
};
let sessionExportRequests = 0;
let releaseSessionExportReply;
const occupyProxyPort = process.env.LOLICODE_HARNESS_DESKTOP_OCCUPY_PROXY === "1";
const nativeModes = {
  plan: "DESKTOP_NATIVE_PLAN: implement the revised fixture plan.",
  planFile: "native-approved-plan.txt",
  planText: "Approved revised plan executed.",
  feedback: "Use the revised file name.",
  goal: "Verify the native desktop goal over two rounds.",
  goalText: "Native desktop Goal verified and complete.",
};
const backgroundJobs = {
  start: "HARNESS_DESKTOP_BACKGROUND_START",
  next: "HARNESS_DESKTOP_BACKGROUND_NEXT",
  release: "harness-background-release",
  result: "harness-background-result",
  started: "Background job is waiting for its release file.",
  continued: "The same job is still running in the next turn.",
  output: "HARNESS_DESKTOP_BACKGROUND_JOB_OUTPUT",
  woke: "Harness woke this conversation after the job completed.",
  cancel: "HARNESS_DESKTOP_BACKGROUND_CANCEL",
  cancelStarted: "The cancellation fixture job has started.",
  cancelPid: "harness-background-cancel-pid",
};
const appConfig = JSON.parse(await readFile(path.join(repository, "src-tauri/tauri.conf.json"), "utf8"));
const appVersion = appConfig.version;
const harnessVersion = JSON.parse(await readFile(path.join(
  repository, "packages/lolicode-harness-runtime/package.json",
), "utf8")).dependencies["@deepseek-ai/dsh"];
const appWindowConfig = appConfig.app.windows.find((window) => window.label === "main");
const cli = path.join(repository, "node_modules/@tauri-apps/cli/tauri.js");
const target = process.env.LOLICODE_HARNESS_DESKTOP_TARGET_DIR
  ? path.resolve(process.env.LOLICODE_HARNESS_DESKTOP_TARGET_DIR)
  : targetDirectory;
const executable = path.join(target, "debug/lolicode.exe");
const previousOverlay = process.env.LOLICODE_HARNESS_DESKTOP_REUSE_OVERLAY;
const rebuildOverlay = process.env.LOLICODE_HARNESS_DESKTOP_REBUILD === "1";
const reuseConfig = previousOverlay ? JSON.parse(await readFile(previousOverlay, "utf8")) : null;
if (reuseConfig) {
  const origin = new URL(reuseConfig.build.devUrl);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.href, `${origin.origin}/`);
  assert.match(reuseConfig.identifier, /^art\.treasuregrove\.lolicode-harness-[0-9a-f]{32}$/);
}
const fixtureRenderer = new URL(
  "./harness-desktop-renderer.mjs",
  import.meta.url,
);
const namespace = `/__harness_acceptance_${randomUUID().replaceAll("-", "")}`;
const model = "harness-desktop-vision";
const fixtureKey = "isolated-harness-desktop-key";
const prompt = {
  approve:
    "HARNESS_DESKTOP_APPROVE: inspect the attached image and run the fixture write.",
  reject: "HARNESS_DESKTOP_REJECT: request the second fixture write.",
  resume: "HARNESS_DESKTOP_RESUME: continue from the existing conversation.",
};
const answers = {
  approve: "Harness desktop image and approved write verified.",
  reject: "Harness desktop rejected write verified.",
  resume: "Harness desktop resumed the previous conversation.",
};
const keyboard = {
  title: "Keyboard steering acceptance",
  scrollPrimer: "HARNESS_DESKTOP_SCROLL_PRIMER",
  scrollHistory: Array.from({ length: 65 }, (_, index) => `Historical paragraph ${index + 1} for the desktop scroll acceptance.`).join("\n\n"),
  start: "HARNESS_DESKTOP_STEER_START",
  insert: "HARNESS_DESKTOP_STEER_INSERT",
  first: "Original response completed before steering.",
  next: "Keyboard input reached the current task.",
};
const workspaceSwitch = {
  file: "workspace-proof.txt",
  first: {
    prompt:
      "HARNESS_DESKTOP_WORKSPACE_FIRST: write the workspace proof in the original project.",
    content: "Original workspace\n",
    answer: "The original workspace finished after switching.",
  },
  second: {
    prompt:
      "HARNESS_DESKTOP_WORKSPACE_SECOND: write the workspace proof in the second project.",
    content: "Second workspace\n",
    answer: "The second workspace finished while the original was waiting.",
  },
};
const website = {
  goal: "做一个简单的活动报名网页，完成后把运行页面给我看。",
  title: "制作活动报名网页",
  workerPrompt:
    "Build the LoliCode acceptance website in index.html and present it.",
  proof: "HARNESS_SECRETARY_LIVE_2026",
};
const browserTool = {
  title: "Browser tool desktop acceptance",
  openPrompt: "HARNESS_DESKTOP_BROWSER_OPEN",
  inspectPrompt: "HARNESS_DESKTOP_BROWSER_INSPECT",
  navigatePrompt: "HARNESS_DESKTOP_BROWSER_NAVIGATE",
  closedPrompt: "HARNESS_DESKTOP_BROWSER_CLOSED",
  reopenPrompt: "HARNESS_DESKTOP_BROWSER_REOPEN",
  closeFromToolPrompt: "HARNESS_DESKTOP_BROWSER_CLOSE_FROM_TOOL",
  opened: "The approved browser tool opened the development page.",
  inspected: "The browser tool read and updated the sidebar's live page.",
  navigated: "The browser tool navigated within the approved development origin.",
  closed: "The browser tool confirmed that the sidebar closed its page.",
  reopened: "The browser tool opened a new page.",
  closeFromTool: "The browser tool closed its own page.",
  fullTitle: "Full access browser acceptance",
  fullPrompt: "HARNESS_DESKTOP_BROWSER_FULL_ACCESS",
  fullQuestion: "Which theme should the acceptance page use?",
  fullAnswer: "Dark theme",
  fullCompleted: "The full-access browser ran and the genuine question was answered.",
  proof: "HARNESS_BROWSER_TOOL_LIVE",
  nextTitle: "Browser tool desktop second page",
};
const outputLinks = {
  prompt: "HARNESS_DESKTOP_OUTPUT_LINKS",
  title: "Assistant output link preview",
  proof: "HARNESS_ASSISTANT_OUTPUT_LINK",
  label: "Open the delivered website",
  secondTitle: "Independent output browser tab",
  editedTitle: "Edited output browser address",
  file: "docs/report.md",
  fileLine: 2,
  fileText: "Preview content from the assistant output file.",
};
const compact = {
  title: "Native compact acceptance",
  original: "HARNESS_DESKTOP_COMPACT_ORIGINAL",
  followup: "HARNESS_DESKTOP_COMPACT_FOLLOWUP",
  summary: "The acceptance workspace uses amber as its fixture color.",
  answer: "I retained amber from the compacted history.",
};

function interactiveHtml(title, proof, blockedRequest) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <main><h1>${title}</h1><p id="proof">Loading</p><button id="counter" hidden></button><p id="status"></p></main>
    <script>
      if (typeof window.__TAURI_INTERNALS__ === "undefined" && typeof window.__TAURI__ === "undefined") {
        document.getElementById("proof").textContent = ${JSON.stringify(proof)};
        const button = document.getElementById("counter");
        const status = document.getElementById("status");
        let count = 0;
        function render() {
          button.textContent = String(count);
          status.textContent = "Browser fixture count " + count;
        }
        render();
        button.hidden = false;
        button.addEventListener("click", event => {
          if (event.isTrusted) {
            count++;
            render();
          }
        });
        ${blockedRequest ? `fetch(${JSON.stringify(blockedRequest)}, { mode: "no-cors" }).catch(() => {});` : ""}
      }
    </script>`;
}
const workerFollowup = {
  title: "Manual Harness worker",
  task: "HARNESS_DESKTOP_MANUAL: write manual-worker.txt in your assigned worktree.",
  firstAnswer: "Manual worker finished the isolated write.",
  followup: "HARNESS_DESKTOP_MANUAL_FOLLOWUP: continue this exact worker.",
  secondAnswer: "Manual worker continued its original conversation.",
  legacyParent: `lc:${randomUUID()}`,
  legacyChild: `lc:${randomUUID()}`,
  legacyTask: `task-${randomUUID()}`,
  legacyHistory: "Old v1.0.6 worker discussion survives in the first new model call.",
  legacyPrompt: "HARNESS_DESKTOP_LEGACY_FOLLOWUP: continue the old worker.",
  legacyAnswer: "Legacy worker continued under Harness.",
};
const workerQueue = {
  start: "HARNESS_DESKTOP_CHILD_QUEUE_START",
  insert: "HARNESS_DESKTOP_CHILD_QUEUE_INSERT",
  later: "HARNESS_DESKTOP_CHILD_QUEUE_LATER",
  remove: "HARNESS_DESKTOP_CHILD_QUEUE_REMOVE",
  afterRestart: "HARNESS_DESKTOP_CHILD_QUEUE_AFTER_RESTART",
  first: "The child completed its original response.",
  inserted: "The child handled the inserted message.",
  finished: "The child handled the remaining queued message.",
  resumed: "The child resumed its saved queue after restart.",
};

if (process.platform !== "win32")
  throw new Error("This desktop acceptance fixture is for Windows WebView2.");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "lolicode-harness-desktop-"),
);
const profile = path.join(temporary, ".lolicode-dev");
const project = path.join(temporary, "project");
const otherProject = path.join(temporary, "other workspace");
const approvedFile = path.join(temporary, "approved.txt");
const rejectedFile = path.join(temporary, "rejected.txt");
const reportPath = path.join(temporary, "report.ndjson");
const overlayPath = path.join(temporary, "tauri.overlay.json");
await mkdir(profile);
await mkdir(project);
await mkdir(otherProject);
if (outputLinksOnly || dockToolsOnly) {
  await mkdir(path.join(project, "docs"));
  await writeFile(path.join(project, outputLinks.file), `# Fixture report\n${outputLinks.fileText}\n`);
}
for (const args of [["init", "--quiet"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--quiet", "-m", "Acceptance fixture"]]) {
  const git = spawnSync("git", args, { cwd: project, windowsHide: true, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr || git.error?.message);
}
await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    silentStartup: true,
    checkUpdates: false,
    sessionAutoSyncEnabled: false,
    firstRunNoticeConfirmed: true,
    whatsNewSeenVersion: appVersion,
    newLayoutNoticeConfirmed: true,
    language: "zh",
  }),
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server
      .once("error", reject)
      .listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(request, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Fixture request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function reply(response, delta, finishReason, pauseBetweenTextChunks = false) {
  const chunk = (value, finish = null) => ({
    id: "chatcmpl-desktop-harness-fixture",
    created: 1,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const write = (value, finish) =>
    response.write(`data: ${JSON.stringify(chunk(value, finish))}\n\n`);
  write({ role: "assistant" });
  if (pauseBetweenTextChunks) {
    const midpoint = Math.floor(delta.content.length / 2);
    write({ content: delta.content.slice(0, midpoint) });
    if (typeof pauseBetweenTextChunks === "function")
      await pauseBetweenTextChunks();
    else await new Promise((resolve) => setTimeout(resolve, 350));
    write({ content: delta.content.slice(midpoint) });
  } else {
    write(delta);
  }
  write({}, finishReason);
  response.end("data: [DONE]\n\n");
}

function toolReply(response, name, args, id) {
  reply(
    response,
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

const observed = {
  image: false,
  approved: false,
  rejected: false,
  history: false,
  secretary: false,
  worker: false,
  livePreview: false,
  liveBrowserTool: false,
  manualWorker: false,
  workerFollowup: false,
  legacyWorker: false,
  automation: false,
  workspaceSwitch: false,
};
const finishedWorkspaceWrites = new Set();
let modelError;
let releaseKeyboardReply;
let releaseWorkerReply;
let browserToolId;
let browserPageRequests = 0;
let browserNextPageRequests = 0;
let blockedBrowserRequests = 0;
const browserPageServer = createServer((request, response) => {
  if (outputLinksOnly && request.method === "GET" && ["/output-link", "/output-link-second", "/output-link-second?edited=1"].includes(request.url)) {
    const title = request.url === "/output-link" ? outputLinks.title
      : request.url.includes("?edited") ? outputLinks.editedTitle : outputLinks.secondTitle;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(interactiveHtml(title, outputLinks.proof));
    return;
  }
  if (request.method !== "GET" || !["/fixture", "/next"].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  const next = request.url === "/next";
  if (next) browserNextPageRequests++;
  else browserPageRequests++;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(interactiveHtml(next ? browserTool.nextTitle : browserTool.title, browserTool.proof, browserTool.blockedRequest));
});

function findToolValue(value, predicate) {
  if (typeof value === "string") {
    try {
      return findToolValue(JSON.parse(value), predicate);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const part of Object.values(value)) {
    const match = findToolValue(part, predicate);
    if (match) return match;
  }
}

const modelServer = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/browser-cross-origin-probe") {
      blockedBrowserRequests++;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    assert.equal(request.method, "POST", `Unexpected fixture model request ${request.method} ${request.url}`);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    const body = JSON.parse(await readBody(request));
    assert.equal(body.model, model);
    const allMessages = JSON.stringify(body.messages);
    const userMessages = JSON.stringify(
      body.messages.filter((message) => message.role === "user"),
    );
    const toolResult = (id) =>
      body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === id,
      );
    const hasResult = (id) => Boolean(toolResult(id));
    const hasTool = (name) =>
      body.tools?.some((tool) => tool.function.name === name);
    const secretaryPrompt = "You are the user's LoliCode secretary";
    if (allMessages.includes("Create a concise title for an AI coding-assistant session from the supplied human messages.")) {
      assert.equal(body.tools?.length ?? 0, 0);
      assert.ok(userMessages.includes("Generate the session title from this JSON array of human messages:"));
      if (sessionExportOnly) sessionExportRequests++;
      if (titlesOnly) {
        const number = ++titleRequests;
        assert.ok(number <= 2, "A manual title must not trigger another title request");
        assert.ok(userMessages.includes(number === 1 ? titles.firstPrompt : titles.racePrompt));
        assert.ok(!userMessages.includes(titles.nextPrompt));
        const release = Promise.withResolvers();
        const finished = Promise.withResolvers();
        heldTitleReply = { number, release: release.resolve, finished: finished.promise };
        response.once("close", release.resolve);
        try {
          await release.promise;
          if (!response.destroyed)
            await reply(response, { content: number === 1 ? titles.generatedTitle : titles.raceGeneratedTitle }, "stop");
        } finally {
          heldTitleReply = undefined;
          finished.resolve();
        }
      } else {
        await reply(response, { content: "桌面验收会话" }, "stop");
      }
      return;
    }
    if (titlesOnly) {
      const [expected, answer] = [
        [titles.firstPrompt, titles.firstAnswer],
        [titles.nextPrompt, titles.nextAnswer],
        [titles.manualPrompt, titles.manualAnswer],
        [titles.racePrompt, titles.raceAnswer],
      ][titleConversationTurns++] ?? [];
      assert.ok(expected && userMessages.includes(expected), "The title fixture model received an unexpected conversation turn");
      await reply(response, { content: answer }, "stop");
      return;
    }
    if (sessionExportOnly) {
      sessionExportRequests++;
      const { turnPrefix, answerPrefix, legacyPrompt, legacyHistory, legacyAnswer,
        workerPrompt, workerAnswer, activePrompt, activeAnswer } = sessionExport;
      const lastPrompt = body.messages.filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .findLast((content) => [turnPrefix, legacyPrompt, workerPrompt, activePrompt]
          .some((marker) => content?.includes(marker)));
      const turn = lastPrompt?.match(/HARNESS_EXPORT_TURN_(\d{2})\b/);
      if (turn) {
        await reply(response, { content: answerPrefix + turn[1] }, "stop");
      } else if (lastPrompt?.includes(workerPrompt)) {
        await reply(response, { content: workerAnswer }, "stop");
      } else if (lastPrompt?.includes(legacyPrompt)) {
        assert.ok(allMessages.includes(legacyHistory), "The migration did not restore the legacy transcript to the model");
        await reply(response, { content: legacyAnswer }, "stop");
      } else if (lastPrompt?.includes(activePrompt)) {
        await reply(response, { content: activeAnswer }, "stop", () => new Promise((resolve) => {
          releaseSessionExportReply = () => {
            releaseSessionExportReply = undefined;
            resolve();
          };
        }));
      } else {
        throw new Error("Unexpected model request in the session export fixture");
      }
      return;
    }
    if (nativeModesOnly) {
      const round = body.messages.findLast(message => JSON.stringify(message).includes("<goal_round>"));
      if (round) {
        if (hasResult("native-goal-complete")) {
          observed.nativeGoal = true;
          reply(response, { content: nativeModes.goalText }, "stop");
        } else if (hasResult("native-goal-read")) {
          const result = toolResult("native-goal-read").content;
          const { goal } = JSON.parse(typeof result === "string" ? result : result[0].text);
          assert.equal(goal.roundsStarted, 2);
          toolReply(response, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "complete" }, "native-goal-complete");
        } else if (JSON.stringify(round).includes("Round: 2/")) {
          toolReply(response, "get_goal", {}, "native-goal-read");
        } else {
          assert.match(JSON.stringify(round), /Round: 1\//);
          reply(response, { content: "Goal progress saved for the second round." }, "stop");
        }
      } else {
        assert.ok(userMessages.includes(nativeModes.plan));
        if (hasResult("native-plan-write")) {
          observed.nativePlan = true;
          reply(response, { content: nativeModes.planText }, "stop");
        } else if (hasResult("native-plan-revised")) {
          assert.match(JSON.stringify(toolResult("native-plan-revised").content), /Plan approved/);
          toolReply(response, "write", { file_path: path.join(project, nativeModes.planFile), content: nativeModes.planText }, "native-plan-write");
        } else if (hasResult("native-plan-draft")) {
          assert.ok(JSON.stringify(toolResult("native-plan-draft").content).includes(nativeModes.feedback));
          toolReply(response, "exit_plan_mode", { plan: "# Revised desktop plan\n- Write the approved file." }, "native-plan-revised");
        } else {
          assert.ok(hasTool("exit_plan_mode"), "The upstream /plan command did not activate Harness Plan");
          assert.ok(!hasTool("enter_plan_mode"), "The desktop added a model-facing Plan entry tool");
          toolReply(response, "exit_plan_mode", { plan: "# Initial desktop plan\n- Write the fixture file." }, "native-plan-draft");
        }
      }
      return;
    }
    if (backgroundJobsOnly) {
      const shell = "call_background_pwsh";
      const list = "call_background_list";
      const cancel = "call_background_cancel";
      if (userMessages.includes(backgroundJobs.cancel)) {
        if (!hasResult(cancel)) {
          toolReply(response, "pwsh", {
            description: "Start stoppable background process",
            command: `[IO.File]::WriteAllText((Join-Path (Get-Location) '${backgroundJobs.cancelPid}'), "$PID"); while ($true) { Start-Sleep -Milliseconds 100 }`,
            run_in_background: true,
          }, cancel);
        } else {
          assert.match(JSON.stringify(toolResult(cancel)?.content), /started background job/);
          reply(response, { content: backgroundJobs.cancelStarted }, "stop");
        }
      } else if (userMessages.includes(backgroundJobs.output) && await readFile(path.join(project, backgroundJobs.result), "utf8").catch(() => "") === backgroundJobs.output) {
        observed.backgroundWake = true;
        reply(response, { content: backgroundJobs.woke }, "stop");
      } else if (userMessages.includes(backgroundJobs.next)) {
        if (!hasResult(list)) {
          assert.ok(hasTool("job_list"));
          toolReply(response, "job_list", {}, list);
        } else {
          const previous = toolResult(shell)?.content;
          const jobs = JSON.stringify(toolResult(list)?.content);
          const id = JSON.stringify(previous).match(/started background job ([\w-]+)/)?.[1];
          assert.ok(id && jobs.includes(id) && jobs.includes("running"), jobs);
          observed.backgroundContinuation = true;
          reply(response, { content: backgroundJobs.continued }, "stop");
        }
      } else if (!hasResult(shell)) {
        assert.ok(userMessages.includes(backgroundJobs.start));
        assert.ok(hasTool("pwsh"));
        toolReply(response, "pwsh", {
          description: "Wait for acceptance fixture release file",
          command: `while (-not (Test-Path '${backgroundJobs.release}')) { Start-Sleep -Milliseconds 100 }; [IO.File]::WriteAllText((Join-Path (Get-Location) '${backgroundJobs.result}'), '${backgroundJobs.output}'); Write-Output '${backgroundJobs.output}'`,
          run_in_background: true,
        }, shell);
      } else {
        assert.match(JSON.stringify(toolResult(shell)?.content), /started background job/);
        reply(response, { content: backgroundJobs.started }, "stop");
      }
      return;
    }
    if (compactOnly) {
      assert.ok(!userMessages.includes('"/compact"'), "The model received the command as ordinary user text");
      if (userMessages.includes("Do NOT mention this summarization request")) {
        assert.ok(userMessages.includes(compact.original));
        observed.nativeCompactionSummary = true;
        reply(response, { content: compact.summary }, "stop");
      } else if (userMessages.includes(compact.followup)) {
        assert.ok(allMessages.includes("<compacted-summary>") && allMessages.includes(compact.summary));
        assert.ok(!userMessages.includes(compact.original));
        observed.nativeCompactionResume = true;
        reply(response, { content: compact.answer }, "stop");
      } else {
        assert.ok(userMessages.includes(compact.original));
        reply(response, { content: "I recorded the fixture color." }, "stop");
      }
      return;
    }
    if (outputLinksOnly && userMessages.includes(outputLinks.prompt)) {
      reply(response, {
        content: `[${outputLinks.label}](${outputLinks.url}) and [the project report](${outputLinks.file}#L${outputLinks.fileLine}).`,
      }, "stop");
      return;
    }
    if (userMessages.includes(browserTool.fullPrompt)) {
      const openId = "call_full_browser_open";
      const actionId = "call_full_browser_click";
      const snapshotId = "call_full_browser_snapshot";
      const questionId = "call_full_browser_question";
      const foldedClickId = "call_full_browser_folded_click";
      const foldedSnapshotId = "call_full_browser_folded_snapshot";
      if (!hasResult(openId)) {
        assert.ok(hasTool("browser_open"));
        toolReply(response, "browser_open", { url: browserTool.url }, openId);
        return;
      }
      const opened = findToolValue(toolResult(openId), (value) => typeof value.browser_id === "string");
      assert.ok(opened, "Full access did not open the approved local browser");
      if (!hasResult(actionId)) {
        toolReply(response, "browser_action", {
          browser_id: opened.browser_id, action: "click", selector: "#counter",
        }, actionId);
      } else if (!hasResult(snapshotId)) {
        toolReply(response, "browser_snapshot", { browser_id: opened.browser_id }, snapshotId);
      } else if (!hasResult(questionId)) {
        const snapshot = findToolValue(toolResult(snapshotId), (value) => Array.isArray(value.elements));
        assert.match(snapshot?.text ?? "", /Browser fixture count 1/);
        assert.ok(hasTool("ask_user_question"));
        toolReply(response, "ask_user_question", {
          questions: [{
            id: "theme", question: browserTool.fullQuestion,
            options: [{ label: "Light theme" }, { label: browserTool.fullAnswer }],
          }],
        }, questionId);
      } else if (!hasResult(foldedClickId)) {
        assert.ok(JSON.stringify(toolResult(questionId)).includes(browserTool.fullAnswer));
        toolReply(response, "browser_action", {
          browser_id: opened.browser_id, action: "click", selector: "#counter",
        }, foldedClickId);
      } else if (!hasResult(foldedSnapshotId)) {
        toolReply(response, "browser_snapshot", { browser_id: opened.browser_id }, foldedSnapshotId);
      } else {
        const snapshot = findToolValue(toolResult(foldedSnapshotId), (value) => Array.isArray(value.elements));
        assert.match(snapshot?.text ?? "", /Browser fixture count 2/);
        reply(response, { content: browserTool.fullCompleted }, "stop");
      }
      return;
    }
    if (userMessages.includes(browserTool.openPrompt)) {
      const openId = "call_desktop_browser_open";
      const snapshotId = "call_desktop_browser_snapshot";
      const actionId = "call_desktop_browser_click";
      const navigateId = "call_desktop_browser_navigate";
      const closedId = "call_desktop_browser_closed";
      const reopenId = "call_desktop_browser_reopen";
      const modelCloseId = "call_desktop_browser_close_from_tool";
      assert.ok(hasTool("browser_open") && hasTool("browser_snapshot") && hasTool("browser_action"));
      const rememberBrowser = (id, content) => {
        const result = toolResult(id);
        const opened = findToolValue(result, (value) => typeof value.browser_id === "string");
        assert.ok(opened, `The browser tool failed to open: ${JSON.stringify(result)}`);
        assert.equal(opened.url, browserTool.url);
        browserToolId = opened.browser_id;
        reply(response, { content }, "stop");
      };
      if (!hasResult(openId)) {
        toolReply(response, "browser_open", { url: browserTool.url }, openId);
      } else if (userMessages.includes(browserTool.closeFromToolPrompt)) {
        if (!hasResult(modelCloseId)) {
          toolReply(response, "browser_close", { browser_id: browserToolId }, modelCloseId);
        } else {
          assert.ok(findToolValue(toolResult(modelCloseId), (value) => value.closed === true));
          observed.liveBrowserTool = true;
          reply(response, { content: browserTool.closeFromTool }, "stop");
        }
      } else if (userMessages.includes(browserTool.reopenPrompt)) {
        if (!hasResult(reopenId)) {
          toolReply(response, "browser_open", { url: browserTool.url }, reopenId);
        } else {
          rememberBrowser(reopenId, browserTool.reopened);
        }
      } else if (userMessages.includes(browserTool.closedPrompt)) {
        if (!hasResult(closedId)) {
          toolReply(response, "browser_snapshot", { browser_id: browserToolId }, closedId);
        } else {
          assert.match(JSON.stringify(toolResult(closedId)), /已关闭|不存在/);
          reply(response, { content: browserTool.closed }, "stop");
        }
      } else if (userMessages.includes(browserTool.navigatePrompt)) {
        if (!hasResult(navigateId)) {
          toolReply(response, "browser_action", {
            browser_id: browserToolId, action: "navigate", url: browserTool.nextUrl,
          }, navigateId);
        } else {
          assert.ok(findToolValue(toolResult(navigateId), (value) => value.url === browserTool.nextUrl));
          reply(response, { content: browserTool.navigated }, "stop");
        }
      } else if (userMessages.includes(browserTool.inspectPrompt)) {
        if (!hasResult(snapshotId)) {
          toolReply(response, "browser_snapshot", { browser_id: browserToolId }, snapshotId);
        } else if (!hasResult(actionId)) {
          const snapshot = findToolValue(toolResult(snapshotId), (value) => Array.isArray(value.elements));
          assert.ok(snapshot, "The browser tool did not return a DOM snapshot");
          assert.match(snapshot.text, /Browser fixture count 1/);
          toolReply(response, "browser_action", { browser_id: browserToolId, action: "click", selector: "#counter" }, actionId);
        } else {
          assert.ok(findToolValue(toolResult(actionId), (value) => value.url === browserTool.url),
            `The browser tool did not click the live page: ${JSON.stringify(toolResult(actionId))}`);
          reply(response, { content: browserTool.inspected }, "stop");
        }
      } else {
        rememberBrowser(openId, browserTool.opened);
      }
      return;
    }
    if (userMessages.includes(workerQueue.start)) {
      assert.ok(!allMessages.includes(secretaryPrompt));
      assert.ok(!userMessages.includes(workerQueue.remove));
      if (userMessages.includes(workerQueue.afterRestart)) {
        assert.ok(allMessages.includes(workerQueue.finished));
        assert.equal(userMessages.split(workerQueue.afterRestart).length, 2);
        observed.workerQueueRestart = true;
        await reply(response, { content: workerQueue.resumed }, "stop");
      } else if (userMessages.includes(workerQueue.later)) {
        assert.ok(allMessages.includes(workerQueue.inserted));
        assert.equal(userMessages.split(workerQueue.later).length, 2);
        observed.workerQueue = true;
        await reply(response, { content: workerQueue.finished }, "stop");
      } else if (userMessages.includes(workerQueue.insert)) {
        assert.ok(allMessages.includes(workerQueue.first));
        assert.equal(userMessages.split(workerQueue.insert).length, 2);
        await reply(response, { content: workerQueue.inserted }, "stop");
      } else {
        assert.equal(releaseWorkerReply, undefined);
        await reply(response, { content: workerQueue.first }, "stop", () =>
          new Promise((resolve) => { releaseWorkerReply = resolve; }),
        );
      }
      return;
    }
    const knownUserPrompts = [workspaceSwitch.first.prompt, workspaceSwitch.second.prompt, ...Object.values(prompt)];
    const latestUser = body.messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message))
      .findLast((message) => knownUserPrompts.some((value) => message.includes(value)));
    for (const [name, turn, directory] of [
      ["first", workspaceSwitch.first, project],
      ["second", workspaceSwitch.second, otherProject],
    ]) {
      if (!latestUser?.includes(turn.prompt)) continue;
      const callId = `call_desktop_workspace_${name}`;
      if (!hasResult(callId)) {
        assert.ok(hasTool("write"));
        toolReply(
          response,
          "write",
          { file_path: workspaceSwitch.file, content: turn.content },
          callId,
        );
      } else {
        assert.equal(
          await readFile(path.join(directory, workspaceSwitch.file), "utf8"),
          turn.content,
        );
        finishedWorkspaceWrites.add(name);
        observed.workspaceSwitch = finishedWorkspaceWrites.size === 2;
        await reply(response, { content: turn.answer }, "stop");
      }
      return;
    }
    if (userMessages.includes("HARNESS_DESKTOP_AUTOMATION")) {
      assert.ok(!allMessages.includes(secretaryPrompt));
      assert.ok(hasTool("write"));
      if (!hasResult("call_desktop_automation_write")) {
        toolReply(response, "write", {
          file_path: "automation-proof.txt", content: "Harness background automation\n",
        }, "call_desktop_automation_write");
      } else {
        assert.equal(await readFile(path.join(project, "automation-proof.txt"), "utf8"), "Harness background automation\n");
        observed.automation = true;
        reply(response, { content: "Harness background automation finished." }, "stop");
      }
      return;
    }
    if (userMessages.includes(workerFollowup.legacyPrompt)) {
      assert.match(allMessages, new RegExp(workerFollowup.legacyHistory));
      assert.ok(!allMessages.includes(secretaryPrompt));
      observed.legacyWorker = true;
      reply(response, { content: workerFollowup.legacyAnswer }, "stop");
      return;
    }
    if (userMessages.includes(workerFollowup.followup)) {
      assert.ok(allMessages.includes(workerFollowup.firstAnswer));
      assert.ok(!allMessages.includes(secretaryPrompt));
      observed.workerFollowup = true;
      reply(response, { content: workerFollowup.secondAnswer }, "stop");
      return;
    }
    if (userMessages.includes(workerFollowup.task)) {
      assert.ok(!allMessages.includes(secretaryPrompt));
      if (!hasResult("call_desktop_manual_write")) {
        toolReply(response, "write", { file_path: "manual-worker.txt", content: "isolated manual worker\n" }, "call_desktop_manual_write");
      } else {
        observed.manualWorker = true;
        reply(response, { content: workerFollowup.firstAnswer }, "stop");
      }
      return;
    }
    if (userMessages.includes(website.workerPrompt)) {
      assert.ok(
        !allMessages.includes(secretaryPrompt),
        "The worker must not inherit the secretary's role",
      );
      if (!hasResult("call_desktop_website_write")) {
        assert.ok(hasTool("write"));
        toolReply(
          response,
          "write",
          {
            file_path: "index.html",
            content: interactiveHtml("活动报名", website.proof),
          },
          "call_desktop_website_write",
        );
      } else if (!hasResult("call_desktop_website_present")) {
        assert.ok(hasTool("present"));
        toolReply(
          response,
          "present",
          { files: [{ path: "index.html", description: "活动报名网页" }] },
          "call_desktop_website_present",
        );
      } else if (!hasResult("call_desktop_website_report")) {
        assert.ok(hasTool("report_task"));
        toolReply(response, "report_task", {
          state: "ready",
          summary: "活动报名网页已验证，等待验收。",
        }, "call_desktop_website_report");
      } else {
        assert.ok(allMessages.includes("Task report recorded: ready"));
        assert.match(
          await readFile(path.join(project, "index.html"), "utf8"),
          new RegExp(website.proof),
        );
        observed.worker = true;
        reply(response, { content: "活动报名网页已完成并交付预览。" }, "stop");
      }
      return;
    }
    if (userMessages.includes(website.goal)) {
      assert.equal(hasTool("report_task"), false, "The secretary cannot report on behalf of workers");
      assert.ok(
        allMessages.includes(secretaryPrompt),
        "Natural-language goal did not reach the Harness secretary",
      );
      if (!hasResult("call_desktop_website_delegate")) {
        assert.ok(
          hasTool("subagent"),
          "Secretary did not receive the upstream subagent tool",
        );
        observed.secretary = true;
        toolReply(
          response,
          "subagent",
          { description: website.title, prompt: website.workerPrompt },
          "call_desktop_website_delegate",
        );
      } else {
        reply(response, { content: "活动报名页面已派给子任务。" }, "stop");
      }
      return;
    }
    if (userMessages.includes(keyboard.start)) {
      if (userMessages.includes(keyboard.insert)) {
        assert.ok(allMessages.includes(keyboard.first));
        assert.equal(userMessages.split(keyboard.insert).length, 2);
        observed.keyboardSteering = true;
        await reply(response, { content: keyboard.next }, "stop");
      } else {
        assert.equal(releaseKeyboardReply, undefined);
        await reply(response, { content: keyboard.first }, "stop", () =>
          new Promise((resolve) => { releaseKeyboardReply = resolve; }),
        );
      }
      return;
    }
    if (userMessages.includes(keyboard.scrollPrimer)) {
      await reply(response, { content: keyboard.scrollHistory }, "stop");
      return;
    }
    const step = ["resume", "reject", "approve"].find((stage) =>
      allMessages.includes(prompt[stage]),
    );
    assert.ok(step, `Unexpected Harness request (${body.messages.map(({ role }) => role).join(",")})`);
    assert.ok(
      body.tools?.some(
        (tool) =>
          tool.function.name === "write" &&
          tool.function.parameters.properties.sandbox_permissions,
      ),
      "Model did not receive the upstream Harness write schema",
    );
    if (step === "resume") {
      assert.match(
        allMessages,
        /Harness desktop image and approved write verified\./,
      );
      assert.match(allMessages, /Harness desktop rejected write verified\./);
      observed.history = true;
      reply(response, { content: answers.resume }, "stop");
      return;
    }
    if (step === "approve") {
      const image = body.messages
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .some(
          (block) =>
            block.type === "image_url" &&
            block.image_url?.url?.startsWith("data:image/"),
        );
      assert.ok(image, "The first turn did not include the requested image");
      observed.image = true;
    }
    const callId = `call_desktop_${step}`;
    const result = body.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === callId,
    );
    if (result) {
      if (step === "approve") {
        assert.equal(
          await readFile(approvedFile, "utf8"),
          "Approved desktop Harness write.\n",
        );
        observed.approved = true;
      } else {
        await assert.rejects(readFile(rejectedFile), { code: "ENOENT" });
        assert.match(JSON.stringify(result.content), /denied|rejected/i);
        observed.rejected = true;
      }
      await reply(response, { content: answers[step] }, "stop", step === "approve");
      return;
    }
    const args = {
      file_path: step === "approve" ? approvedFile : rejectedFile,
      content:
        step === "approve"
          ? "Approved desktop Harness write.\n"
          : "Unexpected rejected write.\n",
      sandbox_permissions: "danger-full-access",
      justification:
        "Verify the approval decision with a disposable acceptance file.",
    };
    reply(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: { name: "write", arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    );
  } catch (error) {
    modelError ??= error;
    response.writeHead(400).end();
  }
});

const accountModule = `
  const status = async () => ({account: null, persistent: false, warning: null});
  const unavailable = async () => { throw new Error("Account operations are disabled in this isolated fixture."); };
  export const lolicodeAccountApi = {status, login: unavailable, logout: unavailable,
    refreshRelay: unavailable, relayStatus: unavailable, connectRelay: unavailable};
`;
let fixture;
let report;
let vite;
let activeChild;
let firstLaunch = true;
let occupiedProxyRequests = 0;
const portReservation = createServer((_request, response) => {
  occupiedProxyRequests++;
  response.writeHead(409).end();
});

const previewTargetIds = new Map();

async function fixtureDebugPorts(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name === "DevToolsActivePort");
  const ports = await Promise.all(files.map(async (file) => {
    const text = await readFile(path.join(file.parentPath, file.name), "utf8").catch(() => "");
    return Number(text.split("\n", 1)[0]);
  }));
  return ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

async function verifyNativePreview({ url, click, count = 1, requireVisible = false }) {
  const pageUrl = new URL(url);
  assert.equal(pageUrl.protocol, "http:");
  assert.equal(pageUrl.hostname, "127.0.0.1");
  const tool = fixture.phase === "browser-tool";
  const link = fixture.phase === "output-links";
  const dock = fixture.phase === "dock-tools" || fixture.phase === "dock-tools-restart";
  if (tool) assert.equal(url, browserTool.url);
  else if (link) assert.equal(url, outputLinks.url);
  else if (dock) assert.ok(url === browserTool.url || url === browserTool.nextUrl);
  else {
    assert.equal(fixture.phase, "restart");
    assert.match(pageUrl.pathname, /^\/__lolicode_preview\/[a-f0-9]+\/index\.html$/);
  }
  assert.ok(count === 1 || (tool && !click && count === 2));
  assert.ok(activeChild?.pid && activeChild.exitCode === null);
  const proof = tool || dock ? browserTool.proof : link ? outputLinks.proof : website.proof;
  const directory = tool
    ? path.join(profile, "agent", "browser-profiles")
    : path.join(process.env.LOCALAPPDATA, fixture.identifier, link || dock ? "agent-link-preview-webview" : "agent-preview-webview");
  const deadline = Date.now() + 12_000;
  let target;
  let targetPort;
  while (!target && Date.now() < deadline) {
    for (const port of await fixtureDebugPorts(directory)) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        target = (await response.json()).find((item) => item.url === pageUrl.href && item.type === "page");
        if (target) {
          targetPort = port;
          break;
        }
      } catch {}
    }
    if (!target) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(target, `Cannot inspect fixture WebView2 at ${directory}. Run the acceptance script from a non-elevated shell.`);
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  assert.equal(socketUrl.protocol, "ws:");
  assert.equal(socketUrl.hostname, "127.0.0.1");
  assert.equal(socketUrl.port, String(targetPort));
  const socket = new WebSocket(socketUrl);
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    let nextId = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const dispose = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
      };
      const onMessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        dispose();
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`Timed out in WebView2 ${method}`));
      }, 5000);
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const read = async () => {
      const response = await call("Runtime.evaluate", {
        expression: `(() => {
          const button = document.getElementById("counter");
          const rect = button?.getBoundingClientRect();
          const x = rect && rect.x + rect.width / 2;
          const y = rect && rect.y + rect.height / 2;
          return {
            proof: document.getElementById("proof")?.textContent,
            count: button?.textContent,
            x,
            y,
            clickable: rect && document.elementFromPoint(x, y) === button,
            visible: document.visibilityState === "visible",
          };
        })()`,
        returnByValue: true,
      });
      return response.result.value;
    };
    let state = await read();
    const readyUntil = Date.now() + 5000;
    while ((!state?.clickable || state.proof !== proof || (requireVisible && !state.visible)) && Date.now() < readyUntil) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await read();
    }
    assert.equal(state.proof, proof);
    if (requireVisible) assert.ok(state.visible, "A native browser tab was hidden by its neighboring pane");
    if (click) {
      assert.ok(state.clickable, "The native button did not finish layout");
      assert.equal(state.count, "0");
      // Wait for WebView2 to publish hit-test geometry after attaching its
      // native surface. The first DOM layout can be available a frame sooner.
      await call("Runtime.evaluate", {
        expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
        awaitPromise: true,
        returnByValue: true,
      });
      state = await read();
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: state.x, y: state.y });
      for (const [type, buttons] of [["mousePressed", 1], ["mouseReleased", 0]]) {
        await call("Input.dispatchMouseEvent", { type, x: state.x, y: state.y, button: "left", buttons, clickCount: 1 });
      }
      const clickedUntil = Date.now() + 2000;
      do {
        state = await read();
        if (state.count === "1") break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      } while (Date.now() < clickedUntil);
      assert.equal(state.count, "1", `The native preview did not receive a browser click (${JSON.stringify(state)})`);
      previewTargetIds.set(url, target.id);
    } else {
      assert.equal(target.id, previewTargetIds.get(url), "The sidebar replaced the original native document");
      assert.equal(state.count, String(count), "The native document lost its interaction state");
      if (!tool) observed.livePreview = true;
    }
  } finally {
    socket.close();
  }
}

async function sessionExportJournal() {
  const root = path.join(profile, "agent/harness-desktop");
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/i.test(entry.name)) files.push(file);
    }
  }
  await visit(root);
  return Promise.all(files.sort().map(async (file) => [
    path.relative(root, file),
    createHash("sha256").update(await readFile(file)).digest("hex"),
    (await stat(file)).mtimeMs,
  ]));
}

const vitePlugin = {
  name: "lolicode-harness-desktop-acceptance",
  enforce: "pre",
  load(id) {
    if (
      id
        .split("?")[0]
        .replaceAll("\\", "/")
        .endsWith("/src/lib/api/lolicode-account.ts")
    )
      return accountModule;
  },
  transform(source, id) {
    if (!sessionExportOnly) return;
    const file = id.split("?")[0].replaceAll("\\", "/");
    if (!file.endsWith("/src/lib/clipboard.ts") && !file.endsWith("/src/lib/api/agent.ts"))
      return;
    const nativeImport = 'import { invoke } from "@tauri-apps/api/core";';
    assert.ok(source.includes(nativeImport), "Cannot safely observe the session export IPC");
    return source.replace(nativeImport, [
      'import { invoke as nativeInvoke } from "@tauri-apps/api/core";',
      "function invoke(command: string, args?: Record<string, unknown>, options?: Parameters<typeof nativeInvoke>[2]) {",
      '  if (command === "copy_text_to_clipboard") {',
      "    (globalThis.__fixtureSessionExportClipboard ??= []).push(args?.text);",
      "    return Promise.resolve(true);",
      "  }",
      '  if (command === "read_agent_session_markdown") {',
      "    (globalThis.__fixtureSessionExportReads ??= []).push(args?.sessionId);",
      "  }",
      "  return nativeInvoke(command, args, options);",
      "}",
    ].join("\n"));
  },
  transformIndexHtml() {
    return [
      ...(switchingReducedMotion ? [{
        tag: "script",
        injectTo: "head-prepend",
        children: `{
          const matchMedia = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const result = matchMedia(query);
            if (query === "(prefers-reduced-motion: reduce)") {
              Object.defineProperty(result, "matches", { value: true });
            }
            return result;
          };
        }`,
      }] : []),
      {
        tag: "script",
        attrs: { type: "module", src: `${namespace}/renderer.mjs` },
        injectTo: "body",
      },
    ];
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url === `${namespace}/renderer.mjs`) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(fixtureRenderer));
      } else if (switchingOnly && request.url === `${namespace}/switching.mjs`) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(new URL("./harness-desktop-switching.mjs", import.meta.url)));
      } else if (titlesOnly && request.method === "POST" && request.url?.startsWith(`${namespace}/titles-release/`)) {
        const number = Number(request.url.slice(request.url.lastIndexOf("/") + 1));
        if (!Number.isInteger(number) || number < 1 || number > titleRequests) {
          response.writeHead(409).end();
        } else {
          const pending = heldTitleReply;
          if (pending?.number === number) {
            pending.release();
            await pending.finished;
          }
          response.writeHead(204).end();
        }
      } else if (sessionExportOnly && request.url === `${namespace}/session-export.mjs`) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(await readFile(new URL("./harness-desktop-session-export.mjs", import.meta.url)));
      } else if (sessionExportOnly && request.url === `${namespace}/session-export-proof`) {
        try {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            requests: sessionExportRequests,
            held: Boolean(releaseSessionExportReply),
            journal: await sessionExportJournal(),
          }));
        } catch (error) {
          response.writeHead(500).end(String(error));
        }
      } else if (sessionExportOnly && request.url === `${namespace}/session-export-release` && request.method === "POST") {
        if (!releaseSessionExportReply) {
          response.writeHead(409).end();
          return;
        }
        releaseSessionExportReply();
        response.writeHead(204).end();
      } else if (request.url === `${namespace}/config`) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(fixture));
      } else if (backgroundJobsOnly && request.url === `${namespace}/release-background-job` && request.method === "POST") {
        await writeFile(path.join(project, backgroundJobs.release), "released");
        response.writeHead(204).end();
      } else if (backgroundJobsOnly && request.url === `${namespace}/background-process-status`) {
        const pid = Number(await readFile(path.join(project, backgroundJobs.cancelPid), "utf8").catch(() => ""));
        if (!Number.isSafeInteger(pid) || pid < 1) {
          response.end("starting");
        } else {
          try {
            process.kill(pid, 0);
            response.end("running");
          } catch (error) {
            response.end(error.code === "ESRCH" ? "stopped" : String(error.code));
          }
        }
      } else if (request.url === `${namespace}/release-keyboard-reply` && request.method === "POST") {
        if (!releaseKeyboardReply) {
          response.writeHead(409).end();
          return;
        }
        releaseKeyboardReply();
        response.end("ok");
      } else if (request.url === `${namespace}/release-worker-reply` && request.method === "POST") {
        if (!releaseWorkerReply) {
          response.writeHead(409).end();
          return;
        }
        releaseWorkerReply();
        response.end("ok");
      } else if (request.url === `${namespace}/worker-reply-ready`) {
        response.writeHead(releaseWorkerReply ? 204 : 409).end();
      } else if (request.url === `${namespace}/native-preview-proof` && request.method === "POST") {
        try {
          await verifyNativePreview(JSON.parse(await readBody(request, 4096)));
          response.writeHead(204).end();
        } catch (error) {
          response.writeHead(500).end(error.message);
        }
      } else if (request.url === `${namespace}/browser-next-loads`) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(browserNextPageRequests));
      } else if (dockToolsOnly && request.url === `${namespace}/browser-page-loads`) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(browserPageRequests));
      } else if (
        request.url === `${namespace}/report` &&
        request.method === "POST"
      ) {
        try {
          report = JSON.parse(await readBody(request, 16384));
          await appendFile(reportPath, `${JSON.stringify(report)}\n`);
          response.end("ok");
          if (report.result === "failed") {
            const child = activeChild;
            setTimeout(() => stopOwnedChild(child), 5_000).unref();
          }
        } catch (error) {
          modelError ??= error;
          response.writeHead(400).end();
        }
      } else next();
    });
  },
};

function stopOwnedChild(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
}

async function launch(env, phase) {
  report = undefined;
  fixture.phase = phase;
  const log = createWriteStream(path.join(temporary, `desktop-${phase}.log`));
  const logFinished = finished(log);
  const existing = !firstLaunch || (Boolean(reuseConfig) && !rebuildOverlay);
  firstLaunch = false;
  const child = spawn(
    existing ? executable : process.execPath,
    existing ? [] : [
      cli,
      "dev",
      "--no-watch",
      "--exit-on-panic",
      "--config",
      "src-tauri/tauri.dev.conf.json",
      "--config",
      overlayPath,
    ],
    {
      cwd: repository,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  activeChild = child;
  const timer = setTimeout(() => stopOwnedChild(child), 12 * 60_000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (modelError) throw modelError;
    assert.equal(
      report?.result,
      "passed",
      report?.message ||
        `No acceptance report in phase ${phase}: ${JSON.stringify(exit)}`,
    );
    assert.equal(
      exit.code,
      0,
      `Fixture desktop did not exit cleanly in phase ${phase}`,
    );
    return report;
  } finally {
    clearTimeout(timer);
    stopOwnedChild(child);
    activeChild = undefined;
    log.end();
    await logFinished;
  }
}

async function seedLegacyWorker() {
  const sessions = path.join(profile, "agent/native/sessions");
  await mkdir(sessions, { recursive: true });
  const { legacyParent, legacyChild, legacyTask, legacyHistory } = workerFollowup;
  const snapshot = (id, title, coordination) => ({
    session: { id, title, coordination, projectPath: project, mode: "build", permissionMode: "ask",
      model: { providerId: "lolicode", modelId: `harness-desktop-fixture/${model}` }, createdAt: 1, updatedAt: 2 },
    status: "idle", messages: [], permissions: [], questions: [], diffs: [], error: null,
    streamConnected: false, streamGap: false,
  });
  const secretary = snapshot(legacyParent, "v1.0.6 secretary", { role: "secretary" });
  const worker = snapshot(legacyChild, "v1.0.6 worker", { role: "worker", parentSessionId: legacyParent, taskId: legacyTask });
  worker.messages.push({ id: "legacy-worker-message", role: "assistant", parts: [{ type: "text", text: legacyHistory }], createdAt: 2, completedAt: 2 });
  const originals = [
    [legacyParent, { format: 1, snapshot: secretary, history: [], commands: {}, secretaryTasks: [{
      id: legacyTask, parentSessionId: legacyParent, sessionId: legacyChild, title: worker.session.title,
      instructions: "Preserve original worker context", status: "completed", createdAt: 1, updatedAt: 2,
      projectPath: project, requestId: "legacy-task-request", executionMode: "shared",
    }] }],
    [legacyChild, { format: 1, snapshot: worker, history: [], commands: {} }],
  ].map(([id, value]) => [path.join(sessions, `${id.slice(3)}.json`), JSON.stringify(value)]);
  for (const [file, contents] of originals) await writeFile(file, contents, { flag: "wx" });
  return originals;
}

async function seedSessionExportLegacy() {
  const sessions = path.join(profile, "agent/native/sessions");
  await mkdir(sessions, { recursive: true });
  const { legacyId, legacyTitle, legacyHistory } = sessionExport;
  const contents = JSON.stringify({
    format: 1,
    snapshot: {
      session: {
        id: legacyId, title: legacyTitle, projectPath: project, mode: "build", permissionMode: "ask",
        model: { providerId: "lolicode", modelId: "harness-desktop-fixture/" + model },
        createdAt: 1, updatedAt: 2,
      },
      status: "idle",
      messages: [{ id: "legacy-export-message", role: "assistant",
        parts: [{ type: "text", text: legacyHistory }], createdAt: 2, completedAt: 2 }],
      permissions: [], questions: [], diffs: [], error: null, streamConnected: false, streamGap: false,
    },
    history: [],
    commands: {},
  });
  const file = path.join(sessions, legacyId.slice(3) + ".json");
  await writeFile(file, contents, { flag: "wx" });
  return { file, contents };
}

async function seedSwitchingHistory() {
  const metadataDirectory = path.join(profile, "agent/harness-sessions");
  await mkdir(metadataDirectory, { recursive: true });
  const turns = 160;
  const sessions = [];
  for (const [index, label] of ["A", "B", "C", "D", "E", "F"].entries()) {
    const id = randomUUID();
    const recordDirectory = path.join(profile, "agent/harness-desktop", id);
    await mkdir(recordDirectory, { recursive: true });
    const session = {
      id: `lc:${id}`, title: `切换验收会话 ${label}`, projectPath: project,
      mode: "build", permissionMode: "full_access", createdAt: 100, updatedAt: 700 - index * 100,
      model: { providerId: "lolicode", modelId: `harness-desktop-fixture/${model}` },
    };
    const messages = [];
    const marker = turn => `SWITCHING-${label}-TURN-${String(turn).padStart(3, "0")}`;
    // A exercises a dense visible Markdown window; E is a similarly large
    // record whose extra bytes are in an old tool result outside that window.
    const denseTail = switchingProfileScale && label === "A"
      ? Array.from({ length: 54 }, (_, index) => [
          `#### 复现步骤 ${index + 1}`,
          "1. **打开工作区**，检查最近的变更。\n2. 对照预期值并记录结果。",
          "```json\n{\"actual\": \"verified\", \"expected\": \"verified\", \"complete\": true}\n```",
        ].join("\n\n")).join("\n\n")
      : "";
    for (let turn = 1; turn <= turns; turn++) {
      const createdAt = 1000 + turn * 2;
      messages.push({
        id: `user-${label}-${turn}`, role: "user", createdAt, completedAt: createdAt,
        parts: [{ type: "text", text: `读取测试工作区并记录第 ${turn} 轮的验收结果。` }],
      }, {
        id: `assistant-${label}-${turn}`, role: "assistant", createdAt: createdAt + 1, completedAt: createdAt + 1,
        parts: [{
          type: "tool", id: `read-${label}-${turn}`, name: "read", state: "completed",
          input: { file_path: `fixture/${label}-${turn}.txt` }, output: "Isolated switching fixture result.",
        }, {
          type: "text",
          text: [
            `### ${marker(turn)}`,
            "已核对配置、整理结果，并保留了复现步骤。",
            "1. 读取工作区中的测试数据。\n2. 比较历史结果并记录当前状态。",
            "```json\n{\"fixture\": true, \"status\": \"verified\"}\n```",
            ...(denseTail && turn > turns - 12 ? [denseTail] : []),
          ].join("\n\n"),
        }],
      });
    }
    // Seed only the desktop read model. No real user data or SDK task is replayed.
    await writeFile(path.join(metadataDirectory, `${id}.json`), JSON.stringify({
      session, fullAccessSelected: true,
    }), { flag: "wx" });
    const record = {
      snapshot: {
        session, status: "idle", messages, permissions: [], questions: [], diffs: [],
        error: null, streamConnected: false, streamGap: false,
      },
      rootCreated: false, receipts: {},
    };
    if (switchingProfileScale && (label === "A" || label === "E")) {
      const bytes = Buffer.byteLength(JSON.stringify(record));
      messages[1].parts[0].output += "x".repeat(Math.max(0, 820_000 - bytes));
    }
    const serialized = JSON.stringify(record);
    await writeFile(path.join(recordDirectory, "desktop.json"), serialized, { flag: "wx" });
    sessions.push({ id: session.id, title: session.title, first: marker(1), last: marker(turns),
      bytes: Buffer.byteLength(serialized) });
  }
  return {
    sessions, turns, source: "seeded-harness-desktop-snapshots",
    profileScale: switchingProfileScale,
    reducedMotion: switchingReducedMotion,
    baseline: process.env.LOLICODE_HARNESS_DESKTOP_SWITCHING_BASELINE === "1",
  };
}

try {
  const modelPort = await listen(modelServer);
  browserTool.url = `http://127.0.0.1:${await listen(browserPageServer)}/fixture`;
  browserTool.nextUrl = new URL("/next", browserTool.url).href;
  outputLinks.url = new URL("/output-link", browserTool.url).href;
  outputLinks.secondUrl = new URL("/output-link-second", browserTool.url).href;
  browserTool.blockedRequest = `http://127.0.0.1:${modelPort}/browser-cross-origin-probe`;
  const proxyPort = await listen(portReservation);
  if (!occupyProxyPort) await close(portReservation);
  const rendererReservation = createServer();
  const rendererPort = reuseConfig ? Number(new URL(reuseConfig.build.devUrl).port) : await listen(rendererReservation);
  if (!reuseConfig) await close(rendererReservation);
  const env = windowsToolchainEnvironment(
    buildEnvironment("development", {
      ...process.env,
      CC_SWITCH_TEST_HOME: temporary,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        "--remote-debugging-port=0",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ].join(" "),
    }),
  );
  env.CARGO_TARGET_DIR = target;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  delete env.LOLICODE_DEV_HARNESS;
  delete env.LOLICODE_HARNESS_NODE;
  process.env.VITE_LOLICODE_BUILD_CHANNEL = "development";
  vite = await createViteServer({
    root: path.join(repository, "src"),
    configFile: path.join(repository, "vite.config.ts"),
    plugins: [vitePlugin],
    server: { host: "127.0.0.1", port: rendererPort, strictPort: true },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const identifier = reuseConfig?.identifier ?? `art.treasuregrove.lolicode-harness-${randomUUID().replaceAll("-", "")}`;
  fixture = {
    origin,
    identifier,
    harnessVersion,
    permissionsOnly,
    profile,
    project,
    otherProject,
    proxyPort,
    occupyProxyPort,
    modelPort,
    fixtureKey,
    model,
    prompt,
    answers,
    keyboard,
    workspaceSwitch,
    website,
    browserTool,
    outputLinks,
    compact,
    backgroundJobs,
    nativeModes,
    titles: titlesOnly ? titles : undefined,
    sessionExport: sessionExportOnly ? sessionExport : undefined,
    switching: switchingOnly ? await seedSwitchingHistory() : undefined,
    workerFollowup,
    workerQueue,
  };
  const page = await fetch(origin);
  assert.ok(
    page.ok && (await page.text()).includes(`${namespace}/renderer.mjs`),
    "Fixture renderer injection failed",
  );
  await writeFile(
    overlayPath,
    JSON.stringify(reuseConfig ?? {
      identifier,
      build: {
        devUrl: origin,
        beforeDevCommand:
          "pnpm run prepare:agent-assets && pnpm run prepare:harness-runtime --bundle",
      },
      app: {
        windows: [{ ...appWindowConfig, dataDirectory: identifier }],
      },
    }),
  );
  console.log(`Isolated desktop acceptance reports: ${reportPath}`);
  if (!permissionsOnly && !outputLinksOnly && !compactOnly && !backgroundJobsOnly && !dockToolsOnly && !nativeModesOnly && !switchingOnly && !sessionExportOnly && !titlesOnly) {
    const first = await launch(env, "initial");
    assert.equal(first.sendScrollFollow, true);
    assert.ok(observed.image && observed.approved && observed.rejected);
    assert.equal(observed.keyboardSteering, true);
    assert.ok(observed.workspaceSwitch);
    for (const [directory, turn] of [
      [project, workspaceSwitch.first],
      [otherProject, workspaceSwitch.second],
    ]) {
      assert.equal(
        await readFile(path.join(directory, workspaceSwitch.file), "utf8"),
        turn.content,
      );
    }
    fixture.sessionId = first.sessionId;
    const legacyFiles = await seedLegacyWorker();
    const resumed = await launch(env, "restart");
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.nativePreviewRetained, true);
    assert.ok(observed.history);
    assert.ok(observed.secretary && observed.worker && observed.livePreview);
    assert.ok(observed.manualWorker && observed.workerFollowup && observed.legacyWorker);
    assert.equal(observed.workerQueue, true);
    assert.ok(observed.automation);
    fixture.workerQueueSessionId = resumed.manualWorkerSessionId;
    await launch(env, "worker-queue-restart");
    assert.equal(observed.workerQueueRestart, true);
    assert.equal(await readFile(path.join(resumed.manualWorktree, "manual-worker.txt"), "utf8"), "isolated manual worker\n");
    await assert.rejects(readFile(path.join(project, "manual-worker.txt")), { code: "ENOENT" });
    for (const [file, contents] of legacyFiles) assert.equal(await readFile(file, "utf8"), contents);
  }
  if (dockToolsOnly) {
    const dock = await launch(env, "dock-tools");
    assert.ok(dock.splitDock && dock.projectTree && dock.interactiveTerminal && dock.foldRetainsTools &&
      dock.terminalClose && dock.sharedSidebar);
    fixture.dockSessionId = dock.sessionId;
    fixture.dockSplitWidth = dock.splitWidth;
    const restart = await launch(env, "dock-tools-restart");
    assert.equal(restart.sessionId, dock.sessionId);
    assert.ok(restart.savedDock && restart.explicitBrowserRestore && restart.terminalRestartRequiresStart &&
      restart.parallelBrowsers && restart.staleBrowserShowIgnored);
  } else if (sessionExportOnly) {
    const legacy = await seedSessionExportLegacy();
    const warm = await launch(env, "session-export");
    assert.equal(warm.sessionExport, true);
    assert.equal(warm.cold, false);
    fixture.sessionExportState = warm.sessionExportState;
    const requests = sessionExportRequests;
    const cold = await launch(env, "session-export-restart");
    assert.equal(cold.sessionExport, true);
    assert.equal(cold.cold, true);
    assert.equal(sessionExportRequests, requests, "Cold export must not call the model");
    assert.equal(await readFile(legacy.file, "utf8"), legacy.contents, "The original legacy snapshot was modified");
  } else if (titlesOnly) {
    const warm = await launch(env, "titles");
    assert.ok(warm.generatedTitle && warm.followupWhileTitlePending && warm.manualTitleRetained && warm.manualTitleWonRace);
    assert.equal(titleRequests, 2);
    assert.equal(titleConversationTurns, 4);
    fixture.titleSessionId = warm.sessionId;
    fixture.titleRaceSessionId = warm.raceSessionId;
    const cold = await launch(env, "titles-restart");
    assert.equal(cold.sessionId, warm.sessionId);
    assert.equal(cold.manualTitleRetained, true);
    assert.equal(titleRequests, 2, "A cold reopen must not regenerate a title");
    assert.equal(titleConversationTurns, 4, "A cold reopen must not send a conversation turn");
  } else if (switchingOnly) {
    const result = await launch(env, "switching");
    assert.ok(!result.profileFailure, JSON.stringify(result.profileFailure));
    assert.ok(result.sessionSwitches.length >= 8 && result.modeSwitches.length >= 8);
    if (!fixture.switching.baseline) {
      for (const [name, passed] of Object.entries(result.checks))
        assert.equal(passed, true, `Desktop switching check failed: ${name}`);
    }
    console.log(JSON.stringify(result));
  } else if (nativeModesOnly) {
    const modes = await launch(env, "native-modes");
    assert.ok(modes.nativePlan && modes.nativeGoal && observed.nativePlan && observed.nativeGoal);
    if (occupyProxyPort) assert.equal(modes.occupiedProxyRecovered, true);
    assert.equal(await readFile(path.join(project, nativeModes.planFile), "utf8"), nativeModes.planText);
    fixture.nativeModesSessionId = modes.sessionId;
    const restarted = await launch(env, "native-modes-restart");
    assert.equal(restarted.sessionId, modes.sessionId);
    assert.equal(restarted.nativeModesRestored, true);
  } else if (backgroundJobsOnly) {
    const result = await launch(env, "background-jobs");
    assert.equal(result.backgroundJobs, true);
    assert.ok(observed.backgroundContinuation && observed.backgroundWake);
    assert.equal(await readFile(path.join(project, backgroundJobs.result), "utf8"), backgroundJobs.output);
    const nativeId = result.sessionId.replace(/^lc:/, "");
    assert.match(nativeId, /^[0-9a-f-]{36}$/);
    const saved = JSON.parse(await readFile(path.join(profile, "agent", "harness-desktop", nativeId, "desktop.json"), "utf8"));
    assert.equal(saved.receipts["background-start"].status, "completed");
    assert.equal(saved.receipts["background-followup"].status, "completed");
    assert.equal(saved.receipts["background-cancel"].status, "completed");
  } else if (compactOnly) {
    const result = await launch(env, "compact");
    assert.equal(result.nativeCompaction, true);
    assert.equal(observed.nativeCompactionSummary, true);
    assert.equal(observed.nativeCompactionResume, true);
  } else if (outputLinksOnly) {
    const links = await launch(env, "output-links");
    assert.ok(links.nativeOutputLink && links.outputFile && links.nativeBrowserTabs);
  } else {
    const browser = await launch(env, "browser-tool");
    assert.ok(browser.nativeBrowserTool && browser.nativeBrowserHistory && browser.fullAccessQuestion && observed.liveBrowserTool);
    assert.ok(browserPageRequests > 0);
    assert.equal(blockedBrowserRequests, 0, "The native browser sent a request outside the approved origin");
    const toolProfiles = await readdir(path.join(profile, "agent", "browser-profiles"));
    assert.ok(toolProfiles.every((name) => !name.startsWith("tool-")), "Closing the native browsers left disposable WebView2 profiles behind");
    await appendFile(reportPath, `${JSON.stringify({ result: "passed", phase: "browser-tool-cleanup" })}\n`);
  }
  if (occupyProxyPort) {
    assert.ok(portReservation.listening, "The conflicting listener stopped during acceptance");
    assert.equal(occupiedProxyRequests, 0, "The app contacted the process occupying its saved port");
  }
  console.log(JSON.stringify({ result: "passed", ...observed, reportPath }));
} finally {
  stopOwnedChild(activeChild);
  await vite?.close();
  if (modelServer.listening) await close(modelServer);
  if (browserPageServer.listening) await close(browserPageServer);
  if (portReservation.listening) await close(portReservation);
}
// Vite plugins can leave development-only handles after their server closes.
// The acceptance reports and application exits have already been awaited.
process.exit(0);
