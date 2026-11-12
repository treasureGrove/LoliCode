import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { runtimeRoot as root } from "./runtime-fixture.mjs";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAK0lEQVR4nGNkaGCgCmCijjEMowYRAUYDmzAYDSPCYDSMCIPRMCIMBl8YAQAWVACw3XqkiQAAAABJRU5ErkJggg==";
const sessionId = "lolicode-sdk-fixture";
const model = "lolicode-test-vision";
const token = "fixture-lease";

function modelReply(response, delta, finishReason) {
  const chunk = (value, reason) => ({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: value, finish_reason: reason }],
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    chunk({ role: "assistant" }, null),
    chunk(delta, null),
    chunk({}, finishReason),
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function sdk(child, onApproval) {
  let stderr = "";
  let sequence = 0;
  let transportError;
  const pending = new Map();
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const send = (value) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", (error) => {
    transportError ??= error;
    child.kill();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.method === "approval/request") {
        send({ id: frame.id, result: { outcome: onApproval(frame.params) } });
      } else if (pending.has(frame.id) && !frame.method) {
        const { resolve, reject } = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) reject(new Error(frame.error.message));
        else resolve(frame.result);
      } else {
        assert.equal(frame.id, undefined, `Unexpected SDK frame: ${line}`);
      }
    } catch (error) {
      transportError ??= error;
      child.kill();
    }
  });
  return {
    exited,
    request(method, params) {
      const id = ++sequence;
      const response = new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      send({ id, method, params });
      return Promise.race([
        response,
        exited.then(({ code, signal }) => {
          throw (
            transportError ??
            new Error(`Harness exited (${signal ?? code}): ${stderr}`)
          );
        }),
      ]);
    },
  };
}

test(
  "published SDK forwards images and asks for a fresh one-shot approval",
  { timeout: 45_000 },
  async (t) => {
    const parent = path.resolve(os.tmpdir());
    const prefix = "lolicode-harness-sdk-smoke-";
    const temporary = await mkdtemp(path.join(parent, prefix));
    t.after(async () => {
      assert.equal(path.dirname(temporary), parent);
      assert.ok(path.basename(temporary).startsWith(prefix));
      await rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    });
    const home = path.join(temporary, "home");
    const project = path.join(temporary, "project");
    const target = path.join(temporary, "outside-project.txt");
    const gatewayPatch = path.join(temporary, "gateway.json");
    await mkdir(home);
    await mkdir(project);

    let turn;
    let failure;
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.model, model);
        if (++turn.requests === 1) {
          assert.ok(
            body.tools.find((tool) => tool.function.name === "write")?.function
              .parameters.properties.sandbox_permissions,
          );
          if (turn.outcome === "allowed-once") {
            const userImages = body.messages
              .filter(
                (message) =>
                  message.role === "user" && Array.isArray(message.content),
              )
              .flatMap((message) => message.content);
            assert.ok(
              userImages.some(
                (block) =>
                  block.type === "image_url" &&
                  block.image_url.url.startsWith("data:image/"),
              ),
            );
          }
          const argumentsJson = JSON.stringify({
            file_path: target,
            content: turn.outcome,
            sandbox_permissions: "danger-full-access",
            justification: "Verify approval for this temporary fixture file.",
          });
          modelReply(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${turn.number}`,
                  type: "function",
                  function: { name: "write", arguments: argumentsJson },
                },
              ],
            },
            "tool_calls",
          );
        } else {
          const toolResult = body.messages.findLast(
            (message) => message.role === "tool",
          );
          assert.match(JSON.stringify(toolResult), turn.result);
          modelReply(response, { content: "Fixture turn completed." }, "stop");
        }
      } catch (error) {
        failure ??= error;
        response.writeHead(400).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });

    // JSON is valid YAML. Passing values as data avoids YAML interpolation.
    await writeFile(
      gatewayPatch,
      JSON.stringify([
        {
          id: "llm-pi-ai",
          config: {
            providers: {
              "lolicode-gateway": {
                apiKeyEnv: "DSH_LOLICODE_GATEWAY_TOKEN",
                api: "openai-completions",
                baseURL: `http://127.0.0.1:${server.address().port}/v1`,
                compat: {
                  supportsDeveloperRole: false,
                  maxTokensField: "max_tokens",
                },
                models: [
                  {
                    id: model,
                    name: "Vision Fixture",
                    input: ["text", "image"],
                    contextWindow: 32768,
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
        },
      ]),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USERPROFILE|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR)$/i.test(
          key,
        ),
      ),
    );
    const child = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
        "--profile",
        "sdk",
        "--patch",
        path.join(root, "profile.cordis.patch.yml"),
        "--patch",
        gatewayPatch,
      ],
      {
        cwd: project,
        env: {
          ...env,
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_LOLICODE_GATEWAY_TOKEN: token,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const runtime = sdk(child, (request) => {
      assert.equal(request.sessionId, sessionId);
      assert.equal(request.toolName, "write");
      assert.equal(++turn.approvals, 1);
      return turn.outcome;
    });
    try {
      t.signal.addEventListener("abort", () => child.kill(), { once: true });
      const ready = await runtime.request("initialize", {
        cwd: project,
        provider: "lolicode-gateway",
        model,
        approvalRequests: true,
      });
      assert.equal(ready.serverInfo.name, "deepseek-harness-sdk-runtime");
      const outcomes = [
        ["allowed-once", /Created file/],
        ["rejected", /reject/i],
        ["cancelled", /cancel/i],
      ];
      for (const [number, [outcome, result]] of outcomes.entries()) {
        turn = { number, outcome, result, approvals: 0, requests: 0 };
        const contentBlocks = [
          { type: "text", text: `Test approval ${number + 1}.` },
        ];
        if (number === 0)
          contentBlocks.push({
            type: "image",
            mimeType: "image/png",
            name: "fixture.png",
            data: png,
          });
        const receipt = await runtime.request("session/prompt", {
          sessionId,
          contentBlocks,
        });
        assert.ok(receipt.messageId);
        await runtime.request("session/wait", { sessionId });
        if (failure) throw failure;
        assert.equal(turn.approvals, 1);
        assert.equal(turn.requests, 2);
        assert.equal(await readFile(target, "utf8"), "allowed-once");
      }
      await runtime.request("shutdown");
      assert.deepEqual(await runtime.exited, { code: 0, signal: null });
    } finally {
      child.kill();
      await runtime.exited;
    }
  },
);
