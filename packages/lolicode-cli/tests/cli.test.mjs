import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli =
  process.env.LOLICODE_TEST_CLI ||
  fileURLToPath(new URL("../bin/lolicode.mjs", import.meta.url));
const key = "lolicode-fixture-key-never-print";

function run(args, { env = {}, cwd, input = "" } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${stdout}\n${stderr}`));
    }, 60000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function reply(response, delta, finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [value, reason] of [
    [{ role: "assistant" }, null],
    [delta, null],
    [{}, finishReason],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "cli-fixture", object: "chat.completion.chunk", created: 1700000000, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
const tool = (response, name, args) =>
  reply(
    response,
    {
      tool_calls: [
        {
          index: 0,
          id: "call_fixture",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );

async function fixture(t, handler, api = "openai-completions") {
  const root = await mkdtemp(path.join(os.tmpdir(), "lolicode-cli-test-"));
  const cwd = path.join(root, "project with spaces 项目");
  await mkdir(cwd);
  const calls = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      const endpoint = {
        "openai-completions": "chat/completions",
        "openai-responses": "responses",
        "anthropic-messages": "messages",
      }[api];
      assert.ok(
        request.url === `/v1/${endpoint}` ||
          request.url === `/v1/${endpoint}?beta=true`,
        request.url,
      );
      if (api === "anthropic-messages")
        assert.equal(request.headers["x-api-key"], key);
      else assert.equal(request.headers.authorization, `Bearer ${key}`);
      assert.equal(request.headers["x-lolicode-client"], "LoliCode");
      assert.equal(request.headers["x-openrouter-title"], undefined);
      assert.equal(request.headers["http-referer"], undefined);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      calls.push(body);
      await handler(body, response, calls.length);
    } catch (error) {
      failure ||= error;
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "fixture_error", message: error.message },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    LOLICODE_HOME: path.join(root, "home"),
    LOLICODE_BASE_URL: `http://127.0.0.1:${server.address().port}${api === "anthropic-messages" ? "" : "/v1"}`,
    LOLICODE_MODEL: "fixture",
    LOLICODE_API_KEY: key,
    LOLICODE_API: api,
    NO_COLOR: "1",
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.basename(root).startsWith("lolicode-cli-test-"));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 200,
    });
    if (failure) throw failure;
  });
  return { root, cwd, env, calls, run: (args) => run(args, { cwd, env }) };
}

test("help, argument errors, model configuration and diagnostics do not need a model call", async (t) => {
  const f = await fixture(t, () => assert.fail("Unexpected model call"));
  assert.equal((await f.run(["--help"])).code, 0);
  const added = await f.run([
    "models",
    "add",
    "local",
    "--base-url",
    f.env.LOLICODE_BASE_URL,
    "--model",
    "fixture",
    "--api-key-env",
    "LOLICODE_API_KEY",
    "--json",
  ]);
  assert.equal(added.code, 0, added.stderr);
  const config = await readFile(
    path.join(f.env.LOLICODE_HOME, "config.json"),
    "utf8",
  );
  assert.ok(!config.includes(key));
  assert.equal(JSON.parse(config).selected, "local");
  assert.equal(
    (await f.run(["models", "add", "local", "--model", "overwrite"])).code,
    1,
  );
  const diagnostic = await f.run(["doctor", "--json"]);
  assert.equal(diagnostic.code, 0, diagnostic.stdout + diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).status, "ok");
  assert.equal((await f.run(["run", "x", "--approval", "invalid"])).code, 1);
  assert.equal((await f.run(["run", "x", "--timeout", "-1"])).code, 1);
  assert.equal(
    (
      await f.run([
        "models",
        "add",
        "__proto__",
        "--base-url",
        "http://example.com/v1",
        "--model",
        "x",
      ])
    ).code,
    0,
  );
  assert.equal((await f.run(["models", "use", "__proto__"])).code, 0);
  assert.equal(
    Object.hasOwn(
      JSON.parse(
        await readFile(path.join(f.env.LOLICODE_HOME, "config.json"), "utf8"),
      ).channels,
      "__proto__",
    ),
    true,
  );
});

test(
  "real Harness streams a task, persists and resumes its native history",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (body, response, number) => {
      if (number === 1) reply(response, { content: "Hello, little paws! 🐾" });
      else {
        assert.match(
          JSON.stringify(body.messages),
          /remember the blue umbrella/,
        );
        reply(response, { content: "I remember the blue umbrella." });
      }
    });
    const first = await f.run(["run", "remember the blue umbrella", "--json"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(first.stderr, "");
    const result = JSON.parse(first.stdout);
    assert.equal(result.status, "ok");
    assert.match(result.text, /little paws/);
    const history = await readdir(
      path.join(f.env.LOLICODE_HOME, "harness", "sessions"),
    );
    assert.ok(history.length > 0);
    const resumed = await f.run([
      "resume",
      result.sessionId,
      "-p",
      "What do you remember?",
      "--stream-json",
    ]);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    const frames = resumed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(frames.some((frame) => frame.type === "text_delta"));
    assert.equal(frames.at(-1).status, "ok");
    assert.match(frames.at(-1).text, /blue umbrella/);
    assert.deepEqual(
      await readdir(path.join(f.env.LOLICODE_HOME, "locks")),
      [],
    );
  },
);

test(
  "real Harness writes inside the workspace with explicit workspace policy",
  { timeout: 60000 },
  async (t) => {
    let destination;
    const f = await fixture(t, (body, response, number) => {
      if (number === 1)
        tool(response, "write", {
          file_path: destination,
          content: "written by the real Harness",
        });
      else {
        assert.match(
          JSON.stringify(
            body.messages.findLast((message) => message.role === "tool"),
          ),
          /Created file|wrote|written/i,
        );
        reply(response, { content: "File created." });
      }
    });
    destination = path.join(f.cwd, "proof.txt");
    const result = await f.run([
      "run",
      "write the file",
      "--approval",
      "workspace",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(
      await readFile(destination, "utf8"),
      "written by the real Harness",
    );
  },
);

for (const outside of [false, true]) {
  test(
    `noninteractive mode rejects ${outside ? "outside-project escalation" : "review-mode writes"} and returns approval_required`,
    { timeout: 60000 },
    async (t) => {
      let destination;
      const f = await fixture(t, (body, response, number) => {
        if (number === 1)
          tool(response, "write", {
            file_path: destination,
            content: "must not exist",
            ...(outside && {
              sandbox_permissions: "danger-full-access",
              justification: "write outside the project",
            }),
          });
        else reply(response, { content: "The write needs your approval." });
      });
      destination = path.join(outside ? f.root : f.cwd, "denied.txt");
      const result = await f.run([
        "run",
        "request a write",
        "--approval",
        outside ? "workspace" : "review",
        "--json",
      ]);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "approval_required");
      await assert.rejects(stat(destination), { code: "ENOENT" });
    },
  );
}

test(
  "real Harness executes a shell command in the project",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (body, response, number) => {
      if (number === 1) {
        const name = process.platform === "win32" ? "pwsh" : "bash";
        assert.ok(
          body.tools.some((tool) => tool.function.name === name),
          `Missing ${name} tool`,
        );
        tool(response, name, {
          command:
            process.platform === "win32"
              ? "Set-Content -LiteralPath 'command-proof.txt' -Value 'executed'"
              : "printf executed > command-proof.txt",
          description: "Verify CLI command execution",
        });
      } else {
        const toolResult = body.messages.findLast(
          (message) => message.role === "tool",
        );
        assert.ok(
          !/runner.*failed|not recognized|ENOENT|Error:|file access denied|cannot find/i.test(
            JSON.stringify(toolResult),
          ),
          JSON.stringify(toolResult),
        );
        reply(response, { content: "Command finished." });
      }
    });
    const result = await f.run([
      "run",
      "run a command",
      "--approval",
      "workspace",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(
      (await readFile(path.join(f.cwd, "command-proof.txt"), "utf8")).trim(),
      "executed",
    );
  },
);

test(
  "a failed provider returns an error and redacts a key echoed by the provider",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (_, response) =>
      response.writeHead(401, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: { message: `bad key ${key}`, type: "authentication_error" },
        }),
      ),
    );
    const result = await f.run(["run", "fail", "--json"]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "error");
    assert.ok(!result.stdout.includes(key));
    assert.ok(!result.stderr.includes(key));
  },
);

test(
  "a hung model is cancelled by the CLI deadline",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (_, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": waiting\n\n");
    });
    const result = await f.run(["run", "wait", "--timeout", "1", "--json"]);
    assert.equal(result.code, 124, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "timeout");
    assert.deepEqual(
      await readdir(path.join(f.env.LOLICODE_HOME, "locks")),
      [],
    );
  },
);

test(
  "real Harness reads a file and admits piped project context",
  { timeout: 60000 },
  async (t) => {
    let target;
    const f = await fixture(t, (body, response, number) => {
      if (number === 1) {
        assert.match(JSON.stringify(body.messages), /piped project context/);
        tool(response, "read", { file_path: target });
      } else {
        assert.match(
          JSON.stringify(
            body.messages.findLast((message) => message.role === "tool"),
          ),
          /a blue umbrella/,
        );
        reply(response, {
          content: "The project file mentions a blue umbrella.",
        });
      }
    });
    target = path.join(f.cwd, "notes.txt");
    await writeFile(target, "a blue umbrella\n");
    const result = await run(["run", "read the notes", "--stdin", "--json"], {
      cwd: f.cwd,
      env: f.env,
      input: "piped project context",
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).text, /blue umbrella/);
  },
);

test(
  "a noninteractive user question returns input_required",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, (_, response, number) => {
      if (number === 1)
        tool(response, "ask_user_question", {
          questions: [
            {
              id: "color",
              question: "Choose a color",
              options: [{ label: "rose" }, { label: "cream" }],
            },
          ],
        });
      else
        reply(response, { content: "Please choose a color in the terminal." });
    });
    const result = await f.run(["run", "ask a question", "--json"]);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "input_required");
  },
);

for (const api of ["openai-responses", "anthropic-messages"]) {
  test(
    `the installed Harness completes a task over ${api}`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(
        t,
        (_, response) => {
          const text = `Hello from ${api}.`;
          const send = (event) =>
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          if (api === "openai-responses") {
            const item = {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            };
            send({
              type: "response.created",
              response: {
                id: "resp_fixture",
                status: "in_progress",
                output: [],
              },
            });
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            });
            send({
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: item.id,
              delta: text,
            });
            send({ type: "response.output_item.done", output_index: 0, item });
            send({
              type: "response.completed",
              response: {
                id: "resp_fixture",
                status: "completed",
                output: [item],
                usage: {
                  input_tokens: 10,
                  output_tokens: 10,
                  total_tokens: 20,
                },
              },
            });
          } else {
            send({
              type: "message_start",
              message: {
                id: "msg_fixture",
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            });
            send({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            send({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            });
            send({ type: "content_block_stop", index: 0 });
            send({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 10 },
            });
            send({ type: "message_stop" });
          }
          response.end();
        },
        api,
      );
      const result = await f.run(["run", "say hello", "--json"]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).text, `Hello from ${api}.`);
    },
  );
}
