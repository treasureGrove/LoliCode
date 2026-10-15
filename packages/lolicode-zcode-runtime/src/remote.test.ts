import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import {
  RemoteOwner,
  assertRemoteGlibc,
  resolveSSHConfigTarget,
  startStdioGatewayRelay,
  REMOTE_RELAY_PROGRAM,
  type RemoteOwnerOptions,
  type RemoteRuntimePreferencesRequest,
  type RemoteRuntimePreferencesResponse,
} from "./remote.js";
import type { Remote } from "./remote.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function backendFixture() {
  const children: ChildProcessWithoutNullStreams[] = [];
  const commands: string[] = [];
  let disposed = 0;
  const backend = {
    async detect() {
      return { platform: "linux", arch: "x64" };
    },
    async upload() {},
    async exists() {
      return true;
    },
    async readFile() {
      return "fixture";
    },
    async exec(command: string) {
      commands.push(command);
      // Execute the exact production remote program, using a local process in
      // place of the encrypted SSH/WSL transport. No real SSH/WSL is contacted.
      const child = spawn(process.execPath, ["-e", REMOTE_RELAY_PROGRAM], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onClose(listener: (code: number) => void) {
          const callback = (code: number | null) => listener(code ?? -1);
          child.on("close", callback);
          return {
            dispose: () => {
              child.off("close", callback);
            },
          };
        },
      };
    },
    dispose() {
      disposed++;
      for (const child of children) child.stdin.end();
    },
  } as Remote.IRemoteBackend;
  cleanups.push(async () => {
    for (const child of children) {
      child.stdin.end();
      if (child.exitCode == null && !child.killed) {
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              child.kill();
              resolve();
            }, 1_000),
          ),
        ]);
      }
    }
  });
  return {
    backend,
    children,
    commands,
    get disposed() {
      return disposed;
    },
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

function runtimePreferencesFixture(
  resolveRuntimePreferences?: RemoteOwnerOptions["resolveRuntimePreferences"],
  provision?: () => Promise<void>,
) {
  const fixture = backendFixture();
  const responses: RemoteRuntimePreferencesResponse[] = [];
  let listener:
    | ((request: RemoteRuntimePreferencesRequest) => void)
    | undefined;
  let disposed = 0;
  const owner = new RemoteOwner({
    connectOptions: { skipDeploy: true },
    createBackend: async () => fixture.backend,
    connect: async () =>
      ({
        services: {
          zcodeAgentService: {
            onDynamicSessionRuntimePreferencesRequest:
              () => (callback: typeof listener) => {
                listener = callback;
                return {
                  dispose() {
                    disposed++;
                    listener = undefined;
                  },
                };
              },
            async respondSessionRuntimePreferences(
              response: RemoteRuntimePreferencesResponse,
            ) {
              responses.push(response);
            },
          },
        },
        async disposeAndWait() {
          fixture.backend.dispose();
        },
      }) as never,
    acquireGatewayLease: async () => ({
      baseUrl: "http://127.0.0.1:1",
      bearerToken: "local-fixture",
      release() {},
    }),
    provisionGateway: async () => {
      await provision?.();
    },
    resolveRuntimePreferences,
  });
  cleanups.push(() => owner.dispose());
  return {
    owner,
    responses,
    get disposed() {
      return disposed;
    },
    emit(request: RemoteRuntimePreferencesRequest) {
      assert.ok(
        listener,
        "Host bridge must be installed before a task requests preferences",
      );
      listener(request);
    },
    connect: () =>
      owner.connect({
        id: "preferences-fixture",
        target: { kind: "wsl", distro: "fixture" },
      }),
  };
}

async function waitForResponses(responses: unknown[], length: number) {
  const deadline = Date.now() + 2_000;
  while (responses.length < length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(responses.length, length);
}

test("remote Host preferences bridge is ready before provisioning and preserves native scope", async () => {
  const requests: RemoteRuntimePreferencesRequest[] = [];
  const fixture = runtimePreferencesFixture(
    async (request) => {
      requests.push(request);
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
        integratedTerminalShell: { mode: "auto" },
        accidentalAccountToken: "must-never-leave-host",
      };
    },
    async () => {
      fixture.emit({
        requestId: "materialize",
        sessionId: "draft",
        scope: "runtime-materialization",
      });
      await waitForResponses(fixture.responses, 1);
    },
  );
  await fixture.connect();
  fixture.emit({
    requestId: "execute",
    sessionId: "draft",
    scope: "user-execution",
  });
  await waitForResponses(fixture.responses, 2);
  assert.equal(requests[0].sessionId, "draft");
  assert.deepEqual(fixture.responses[0], {
    requestId: "materialize",
    resolution: {
      status: "resolved",
      preferences: {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      },
    },
  });
  assert.equal(fixture.responses[1].resolution.status, "resolved");
  if (fixture.responses[1].resolution.status === "resolved")
    assert.deepEqual(
      fixture.responses[1].resolution.preferences.integratedTerminalShell,
      { mode: "auto" },
    );
  assert.ok(
    !JSON.stringify(fixture.responses).includes("must-never-leave-host"),
  );
  await fixture.owner.disconnect("preferences-fixture");
  assert.equal(fixture.disposed, 1);
});

test("remote preference resolver failure returns a sanitized native failure instead of timing out", async () => {
  const fixture = runtimePreferencesFixture(async () => {
    throw new Error("secret-internal-setting-path");
  });
  await fixture.connect();
  fixture.emit({
    requestId: "failed",
    sessionId: "draft",
    scope: "runtime-materialization",
  });
  await waitForResponses(fixture.responses, 1);
  assert.deepEqual(fixture.responses[0], {
    requestId: "failed",
    resolution: {
      status: "failed",
      message: "Unable to resolve desktop runtime preferences",
    },
  });
  assert.ok(!JSON.stringify(fixture.responses).includes("secret-internal"));
});

test("disconnect detaches preferences immediately and ignores a resolver finishing after close", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const fixture = runtimePreferencesFixture(async () => {
    calls++;
    await pending;
    return {
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: "preflight-v1",
    };
  });
  await fixture.connect();
  const request = {
    requestId: "late",
    sessionId: "draft",
    scope: "user-execution" as const,
  };
  fixture.emit(request);
  fixture.emit(request);
  assert.equal(
    calls,
    1,
    "duplicate pending native requests must not resolve twice",
  );
  await fixture.owner.disconnect("preferences-fixture");
  assert.equal(fixture.disposed, 1);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.responses.length, 0);
});

test("a provisioning failure also releases the native preferences subscription", async () => {
  const fixture = runtimePreferencesFixture(undefined, async () => {
    throw new Error("owned provisioning failure");
  });
  await assert.rejects(fixture.connect(), /owned provisioning failure/);
  assert.equal(fixture.disposed, 1);
  assert.deepEqual(fixture.owner.list(), []);
});

test("remote inference uses an authenticated stdio relay without exporting the local lease", async () => {
  const calls: Array<{
    url?: string;
    authorization?: string;
    extra?: string;
    body: string;
  }> = [];
  const local = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      url: req.url,
      authorization: req.headers.authorization,
      extra: req.headers["x-secret"] as string,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "must-not-relay=secret",
    });
    res.end('{"choices":[{"message":{"content":"offline fixture"}}]}');
  });
  const origin = await listen(local);
  const fixture = backendFixture();
  const leaseToken = "local-only-lease-fixture";
  const relay = await startStdioGatewayRelay(fixture.backend, {
    baseUrl: `${origin}/gateway/v1`,
    bearerToken: leaseToken,
    release() {},
  });
  cleanups.push(() => relay.dispose());
  const response = await fetch(`${relay.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.apiKey}`,
      "content-type": "application/json",
      "x-secret": "do-not-forward",
    },
    body: '{"model":"fixture","messages":[]}',
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /offline fixture/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${leaseToken}`);
  assert.equal(calls[0].url, "/gateway/v1/chat/completions");
  assert.equal(calls[0].extra, undefined);
  assert.notEqual(relay.apiKey, leaseToken);
  assert.ok(
    fixture.commands.every(
      (command) =>
        !command.includes(leaseToken) && !command.includes(relay.apiKey),
    ),
  );
});

test("unauthenticated or arbitrary URL requests never reach the desktop gateway", async () => {
  let calls = 0;
  const origin = await listen(
    createServer((_req, res) => {
      calls++;
      res.end("unexpected");
    }),
  );
  const { backend } = backendFixture();
  const relay = await startStdioGatewayRelay(backend, {
    baseUrl: origin,
    bearerToken: "local-fixture",
    release() {},
  });
  cleanups.push(() => relay.dispose());
  assert.equal((await fetch(`${relay.baseUrl}/models`)).status, 401);
  const headers = { authorization: `Bearer ${relay.apiKey}` };
  assert.equal(
    (await fetch(`${origin}/never-requested-by-relay`, { method: "HEAD" }))
      .status,
    200,
  );
  calls = 0;
  assert.equal(
    (await fetch(`${relay.baseUrl}/../../admin`, { headers })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${relay.baseUrl}/models?target=http://example.invalid`, {
        headers,
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    startStdioGatewayRelay(backend, {
      baseUrl: "https://example.invalid",
      bearerToken: "secret",
      release() {},
    }),
    /private loopback/,
  );
});

test("streaming responses preserve content and relay activity until the real stream ends", async () => {
  let finish!: () => void;
  const origin = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"first"}\n\n');
      finish = () => res.end("data: [DONE]\n\n");
    }),
  );
  const { backend } = backendFixture();
  const relay = await startStdioGatewayRelay(backend, {
    baseUrl: origin,
    bearerToken: "local-fixture",
    release() {},
  });
  cleanups.push(() => relay.dispose());
  const response = await fetch(`${relay.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.apiKey}` },
    body: "{}",
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(relay.activeRequests(), 1);
  finish();
  assert.equal(
    await response.text(),
    'data: {"delta":"first"}\n\ndata: [DONE]\n\n',
  );
  assert.equal(relay.activeRequests(), 0);
});

test("provision failure revokes the gateway lease and closes the native remote owner", async () => {
  const fixture = backendFixture();
  let releases = 0;
  let closes = 0;
  const owner = new RemoteOwner({
    connectOptions: { skipDeploy: true },
    createBackend: async () => fixture.backend,
    connect: async () =>
      ({
        services: {},
        client: {},
        dispose() {},
        async disposeAndWait() {
          closes++;
          fixture.backend.dispose();
        },
      }) as never,
    acquireGatewayLease: async () => ({
      baseUrl: "http://127.0.0.1:1",
      bearerToken: "private-lease",
      release() {
        releases++;
      },
    }),
    provisionGateway: async () => {
      throw new Error("fixture provider validation failed");
    },
  });
  cleanups.push(() => owner.dispose());
  await assert.rejects(
    owner.connect({
      id: "fixture-ssh",
      target: { kind: "ssh", host: "invalid.test", username: "fixture" },
    }),
    /provider validation/,
  );
  assert.equal(releases, 1);
  assert.equal(closes, 1);
  assert.deepEqual(owner.list(), []);
});

test("disconnect during provisioning waits and cleans late-created resources exactly once", async () => {
  const fixture = backendFixture();
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let released = 0;
  let providerDisposed = 0;
  const owner = new RemoteOwner({
    connectOptions: { skipDeploy: true },
    createBackend: async () => fixture.backend,
    connect: async () =>
      ({
        services: {},
        client: {},
        dispose() {},
        async disposeAndWait() {
          fixture.backend.dispose();
        },
      }) as never,
    acquireGatewayLease: async () => ({
      baseUrl: "http://127.0.0.1:1",
      bearerToken: "fixture",
      release() {
        released++;
      },
    }),
    provisionGateway: async () => {
      entered();
      await blocked;
      return {
        dispose() {
          providerDisposed++;
        },
      };
    },
  });
  cleanups.push(() => owner.dispose());
  const connecting = owner.connect({
    id: "fixture-wsl",
    target: { kind: "wsl", distro: "fixture" },
  });
  void connecting.catch(() => {});
  await started;
  const disconnecting = owner.disconnect("fixture-wsl");
  finish();
  await disconnecting;
  await assert.rejects(connecting, /canceled/);
  assert.equal(released, 1);
  assert.equal(providerDisposed, 1);
  assert.equal(owner.busy(), false);
  assert.deepEqual(owner.list(), []);
});

test("remote deployment without owned assets fails before contacting an SSH host", async () => {
  let contacted = false;
  const owner = new RemoteOwner({
    createBackend: async () => {
      contacted = true;
      throw new Error("must not be called");
    },
    acquireGatewayLease: async () => {
      throw new Error("must not be called");
    },
    provisionGateway: async () => {},
  });
  await assert.rejects(
    owner.connect({
      id: "not-prepared",
      target: { kind: "ssh", host: "invalid.test", username: "fixture" },
    }),
    /assets are not prepared/,
  );
  assert.equal(contacted, false);
  assert.deepEqual(owner.list(), []);
  await owner.dispose();
});

test("SSH aliases use the explicit original config path and do not invoke a shell", async () => {
  const config = "C:/fixture/original-home/.ssh/config";
  let queryArgs: string[] = [];
  const resolved = await resolveSSHConfigTarget(
    {
      kind: "ssh",
      sshConfigAlias: "fixture-alias",
      host: "fixture-alias",
      username: "",
    },
    config,
    async (args) => {
      queryArgs = args;
      return "hostname 192.0.2.55\nuser fixture-user\nport 2202\nidentityfile none\n";
    },
  );
  assert.deepEqual(queryArgs, [
    "-G",
    "-F",
    config,
    "-o",
    "BatchMode=yes",
    "fixture-alias",
  ]);
  assert.equal(resolved.host, "192.0.2.55");
  assert.equal(resolved.username, "fixture-user");
  assert.equal(resolved.port, 2202);
  assert.equal(resolved.privateKeyPath, undefined);
  await assert.rejects(
    resolveSSHConfigTarget(
      { kind: "ssh", sshConfigAlias: "fixture", host: "fixture", username: "" },
      config,
      async () => "hostname fixture\nuser fixture\nproxyjump bastion\n",
    ),
    /跳板机/,
  );
});

test("native quoted install paths and WSL byte-uploaded wrappers stay in LoliCode's namespace", async () => {
  const fixture = backendFixture();
  (fixture.backend as Remote.IRemoteBackend & { kind: string }).kind = "wsl";
  const directory = await mkdtemp(join(tmpdir(), "lolicode-wrapper-fixture-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(
    directory,
    `zcode-agent-wrapper-${process.pid}-${Date.now()}.sh`,
  );
  const original =
    '#!/bin/sh\nruntime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"\nexec "$runtime_root/node" "$HOME/.zcode/server/agents/glm/zcode.cjs" "$@"\n';
  await writeFile(script, original);
  let uploaded = "",
    uploadedPath = "";
  fixture.backend.upload = async (local, remote) => {
    uploaded = await readFile(local, "utf8");
    uploadedPath = remote;
  };
  fixture.backend.readFile = async () => uploaded;
  const owner = new RemoteOwner({
    connectOptions: { skipDeploy: true },
    createBackend: async () => fixture.backend,
    connect: async (backend) => {
      assert.equal((backend as { kind?: string }).kind, "wsl");
      await backend.exec(
        'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server" ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs',
      );
      await backend.exec("\"$HOME\"'/.zcode/server/node' --version");
      const holder =
        'set -eu\nlock_dir="$HOME"\'/.zcode/server/.deploy.lock\'\nmkdir -p "$lock_dir"\n' +
        "trap cleanup_deploy_lock EXIT HUP INT TERM\n" +
        '(while [ "$(cat "$owner_file" 2>/dev/null || true)" = "$owner_token" ]; do touch "$owner_file" 2>/dev/null || exit 0; sleep 30; done) &\nlock_heartbeat_pid=$!\n';
      const octal = [...Buffer.from(holder)]
        .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
        .join("");
      await backend.exec(
        `printf '%b' '${octal}' > "$HOME"'/.zcode/server/.deploy.lock.holder.sh'\ntrap 'rm -f "$HOME"'"'"'/.zcode/server/.deploy.lock.holder.sh'"'"'' EXIT`,
      );
      await backend.exec("(while :; do sleep 30; done) & unrelated_pid=$!");
      await backend.upload(script, "~/.zcode/server/glm/zcode.new");
      assert.equal(
        await backend.readFile("~/.zcode/server/agents/glm/zcode-agent"),
        original,
      );
      return {
        services: {},
        client: {},
        dispose() {},
        async disposeAndWait() {
          fixture.backend.dispose();
        },
      } as never;
    },
    acquireGatewayLease: async () => ({
      baseUrl: "http://127.0.0.1:1",
      bearerToken: "fixture",
      release() {},
    }),
    provisionGateway: async () => {},
  });
  cleanups.push(() => owner.dispose());
  await owner.connect({
    id: "native-wsl-path",
    target: { kind: "wsl", distro: "fixture" },
  });
  assert.ok(
    fixture.commands.every((command) => !command.includes("/.zcode/server")),
  );
  assert.match(fixture.commands[0], /HOME=.*lolicode\/remote/);
  assert.match(fixture.commands[0], /&& env HOME=/);
  // Run the exact production launch in a real POSIX shell. A fake executable
  // only prints its environment; no SSH, real model or user configuration runs.
  const shell = ["/bin/sh", "C:/Program Files/Git/bin/bash.exe"].find(
    (candidate) => existsSync(candidate),
  );
  assert.ok(shell, "A POSIX shell is required for remote launch regression");
  const shellHome = join(directory, "shell-home");
  const serverRoot = join(shellHome, ".lolicode/server");
  await mkdir(serverRoot, { recursive: true });
  await writeFile(
    join(serverRoot, "node"),
    '#!/bin/sh\nprintf "%s\\n" "$HOME" "$USERPROFILE" "$ZCODE_DATA_BASE_DIR" "$ZCODE_SERVER_RUNTIME_ROOT" "$0" "$1" "$GLM_BINARY_PATH"\n',
    { mode: 0o700 },
  );
  const result = spawnSync(shell, ["-c", fixture.commands[0]], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: shellHome.replaceAll("\\", "/"),
      BASH_ENV: "",
      ENV: "",
    },
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const shellPath = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(
        /^([a-z]):\//i,
        (_, drive: string) => `/${drive.toLowerCase()}/`,
      );
  const [home, profile, data, binaries, executable, scriptPath, agentWrapper] =
    result.stdout.trim().split(/\r?\n/).map(shellPath);
  assert.equal(home, profile);
  // Git Bash may expose Windows TEMP through its /tmp mount rather than /c.
  // Compare the owned directory identity and relative layout, not mount aliases.
  const originalHome = home.split("/.lolicode/remote/")[0];
  assert.ok(originalHome.endsWith(`/${basename(directory)}/shell-home`));
  assert.equal(home.split("/.lolicode/remote/").length, 2);
  assert.equal(data, home.replace(/\/home$/, "/data"));
  assert.equal(binaries, `${originalHome}/.lolicode/server`);
  assert.equal(executable, `${binaries}/node`);
  assert.equal(scriptPath, `${binaries}/zcode-server.cjs`);
  assert.equal(agentWrapper, `${binaries}/agents/glm/zcode-agent`);
  assert.ok(!agentWrapper.startsWith(`${home}/`));
  const holderCommand = fixture.commands.find((command) =>
    command.includes("printf '%b'"),
  )!;
  const encodedHolder = holderCommand.match(/(?:\\[0-7]{3})+/)?.[0];
  assert.ok(encodedHolder);
  const decodedHolder = Buffer.from(
    (encodedHolder.match(/\\[0-7]{3}/g) ?? []).map((part) =>
      Number.parseInt(part.slice(1), 8),
    ),
  ).toString();
  assert.ok(decodedHolder.includes("/.lolicode/server"));
  assert.ok(!decodedHolder.includes("/.zcode/server"));
  assert.ok(decodedHolder.includes("done) </dev/null >/dev/null 2>&1 &"));
  assert.ok(
    decodedHolder.includes('" = "$owner_token" ]; do touch "$owner_file"'),
  );
  assert.ok(
    decodedHolder.includes("trap cleanup_deploy_lock EXIT HUP INT TERM"),
  );
  assert.ok(decodedHolder.includes("lock_heartbeat_pid=$!"));
  assert.ok(
    fixture.commands.includes(
      "(while :; do sleep 30; done) & unrelated_pid=$!",
    ),
  );
  assert.equal(uploadedPath, "~/.lolicode/server/glm/zcode.new");
  assert.ok(uploaded.includes("$HOME/.lolicode/server"));
  assert.ok(uploaded.includes('"$runtime_root/agents/glm/zcode.cjs"'));
  assert.ok(!uploaded.includes("/.zcode/server"));
  assert.equal(await readFile(script, "utf8"), original);
});

test("remote deployment checks the terminal binary's actual glibc minimum and fails closed", async () => {
  const fixture = (output: string, code = 0) =>
    ({
      async exec(command: string) {
        assert.equal(command, "getconf GNU_LIBC_VERSION");
        const stdin = new PassThrough(),
          stdout = new PassThrough(),
          stderr = new PassThrough();
        const listeners = new Set<(code: number) => void>();
        setImmediate(() => {
          stdout.end(output);
          for (const listener of [...listeners]) listener(code);
        });
        return {
          stdin,
          stdout,
          stderr,
          onClose(listener: (code: number) => void) {
            listeners.add(listener);
            return {
              dispose() {
                listeners.delete(listener);
              },
            };
          },
        };
      },
    }) as unknown as Remote.IRemoteBackend;
  const symbols = ["GLIBC_2.2.5", "GLIBC_2.28", "GLIBC_2.32", "GLIBC_2.34"];
  await assert.rejects(
    assertRemoteGlibc(fixture("glibc 2.28\n"), symbols),
    /需要 glibc 2\.34/,
  );
  await assertRemoteGlibc(fixture("glibc 2.38\n"), symbols);
  await assert.rejects(
    assertRemoteGlibc(fixture("", 1), symbols),
    /无法提供 glibc/,
  );
});
