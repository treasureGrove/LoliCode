import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Remote } from "./remote.mjs";
import type { Services, Shared } from "./services.mjs";
import type { NativeServiceAccess } from "./automation.js";

export interface GatewayLease {
  /** Local worker-only gateway endpoint. Never forwarded to the remote machine. */
  baseUrl: string;
  bearerToken: string;
  release(): Promise<void> | void;
}

export type RemoteRuntimePreferencesRequest =
  Shared.ZCodeSessionRequestRuntimePreferencesParams & { requestId: string };
export type RemoteRuntimePreferencesResponse = Parameters<
  Services.IZCodeAgentService["respondSessionRuntimePreferences"]
>[0];

export interface RemoteOwnerOptions {
  connectOptions?: Remote.ConnectOptions;
  acquireGatewayLease: (input: { remoteId: string }) => Promise<GatewayLease>;
  provisionGateway: (input: {
    remoteId: string;
    services: NativeServiceAccess;
    baseUrl: string;
    /** Random relay credential; not an upstream API key or local gateway token. */
    apiKey: string;
  }) => Promise<{ dispose(): Promise<void> | void } | void>;
  /** Host-owned app preferences only; never account/provider credentials. */
  resolveRuntimePreferences?: (
    request: RemoteRuntimePreferencesRequest,
  ) => Promise<Shared.ZCodeSessionRuntimePreferencesResult>;
  onEvent?: (event: { type: string; remoteId: string; code?: number }) => void;
  /** Test seams for the genuine native API, not production substitutes. */
  createBackend?: typeof Remote.createRemoteBackend;
  connect?: typeof Remote.connectRemote;
}

type RecordEntry = {
  id: string;
  kind: Shared.RemoteTarget["kind"];
  state: "connecting" | "connected";
  abort: AbortController;
  backend?: Remote.IRemoteBackend;
  connection?: Remote.RemoteConnection;
  relay?: StdioGatewayRelay;
  lease?: GatewayLease;
  provisioning?: { dispose(): Promise<void> | void };
  runtimePreferences?: { dispose(): void };
  workspaces: Set<string>;
  initialization?: Promise<void>;
  disposal?: Promise<void>;
};

/** Owned SSH/WSL/Docker connections; no global/user credential mirroring. */
export class RemoteOwner {
  private readonly entries = new Map<string, RecordEntry>();
  private closed = false;

  constructor(private readonly options: RemoteOwnerOptions) {}

  list() {
    return [...this.entries.values()].map(({ id, kind, state }) => ({
      id,
      kind,
      state,
    }));
  }

  busy(): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.state === "connecting" ||
        (entry.relay?.activeRequests() ?? 0) > 0,
    );
  }

  listWSL() {
    return Remote.listWSLDistros();
  }

  getServices(id: string): NativeServiceAccess {
    const entry = this.entries.get(id);
    if (!entry?.connection || entry.state !== "connected")
      throw new Error("Remote workspace is not connected");
    return entry.connection.services;
  }

  bindWorkspace(id: string, workspaceIdentity: string): void {
    this.getServices(id);
    if (!workspaceIdentity?.trim())
      throw new Error("Remote workspace identity is required");
    this.entries.get(id)!.workspaces.add(workspaceIdentity);
  }

  resolveWorkspace(workspaceIdentity: string): NativeServiceAccess {
    const matches = [...this.entries.values()].filter((entry) =>
      entry.workspaces.has(workspaceIdentity),
    );
    if (matches.length !== 1)
      throw new Error("Automation target remote workspace is not connected");
    return this.getServices(matches[0].id);
  }

  async connect(input: { id: string; target: Shared.RemoteTarget }) {
    if (this.closed) throw new Error("Remote connection owner is closed");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))
      throw new Error("Invalid remote connection id");
    if (this.entries.has(input.id))
      throw new Error("Remote connection already exists");
    if (!["ssh", "wsl", "docker"].includes(input.target.kind)) {
      throw new Error("Use an SSH, WSL or Docker target for remote deployment");
    }
    const deployment = this.options.connectOptions;
    if (
      !deployment?.skipDeploy &&
      !deployment?.mockCdnDir &&
      !deployment?.remoteCdnBaseUrl &&
      !deployment?.remoteCdnBaseUrls?.length
    ) {
      // Never silently download the upstream desktop's remote product assets.
      // The host supplies a verified LoliCode-owned asset set or an explicitly
      // predeployed runtime. Windows node.exe is not a Linux/WSL runtime.
      throw new Error(
        "Remote deployment assets are not prepared; configure an owned asset directory or a predeployed runtime",
      );
    }
    const entry: RecordEntry = {
      id: input.id,
      kind: input.target.kind,
      state: "connecting",
      abort: new AbortController(),
      workspaces: new Set(),
    };
    this.entries.set(input.id, entry);
    const initialization = (async () => {
      const target =
        input.target.kind === "ssh"
          ? await resolveSSHConfigTarget(input.target)
          : input.target;
      const backend = await (
        this.options.createBackend ?? Remote.createRemoteBackend
      )(target);
      entry.backend = backend;
      if (entry.abort.signal.aborted)
        throw new Error("Remote connection canceled");
      if (this.options.connectOptions?.mockCdnDir) {
        const manifest = JSON.parse(
          await readFile(
            join(this.options.connectOptions.mockCdnDir, "asset-manifest.json"),
            "utf8",
          ),
        );
        const environment = await backend.detect();
        if (manifest.platform !== `${environment.platform}-${environment.arch}`)
          throw new Error("当前未准备此远端系统与架构的 LoliCode 运行组件");
        const versions: string[] = manifest.native?.requiredGlibcSymbols ?? [];
        if (environment.platform === "linux" && versions.length) {
          await assertRemoteGlibc(backend, versions);
        }
      }
      // Native deployment assets may be shared, but LoliCode's services must not
      // read/write the remote user's original ZCode configuration or OAuth store.
      const namespace = createHash("sha256")
        .update(input.id)
        .digest("hex")
        .slice(0, 24);
      const isolated = isolateRemoteBackend(backend, namespace);
      const connection = await (this.options.connect ?? Remote.connectRemote)(
        isolated,
        {
          ...this.options.connectOptions,
          signal: entry.abort.signal,
          onDidRemoteClose: ({ code }) => {
            this.options.onEvent?.({
              type: "remote.closed",
              remoteId: entry.id,
              code,
            });
            void this.disconnect(entry.id);
          },
        },
      );
      entry.connection = connection;
      if (entry.abort.signal.aborted)
        throw new Error("Remote connection canceled");
      // Remote agents cannot read the desktop's app-global settings. Install
      // the genuine Host response bridge before provisioning or task creation.
      entry.runtimePreferences = this.bridgeRuntimePreferences(entry);
      entry.lease = await this.options.acquireGatewayLease({
        remoteId: entry.id,
      });
      entry.relay = await startStdioGatewayRelay(
        isolated,
        entry.lease,
        entry.abort.signal,
      );
      const provisioning = await this.options.provisionGateway({
        remoteId: entry.id,
        services: connection.services,
        baseUrl: entry.relay.baseUrl,
        apiKey: entry.relay.apiKey,
      });
      if (provisioning) entry.provisioning = provisioning;
      if (entry.abort.signal.aborted)
        throw new Error("Remote connection canceled");
      entry.state = "connected";
      this.options.onEvent?.({ type: "remote.connected", remoteId: entry.id });
    })();
    entry.initialization = initialization;
    try {
      await initialization;
      return { id: entry.id, kind: entry.kind, state: entry.state };
    } catch (error) {
      await this.disposeEntry(entry);
      throw error;
    }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) await this.disposeEntry(entry);
  }

  private bridgeRuntimePreferences(entry: RecordEntry) {
    const agent = entry.connection!.services.zcodeAgentService;
    if (!agent?.onDynamicSessionRuntimePreferencesRequest) {
      if (this.options.resolveRuntimePreferences)
        throw new Error("Remote runtime preferences service is unavailable");
      return undefined;
    }
    const pending = new Set<string>();
    return agent.onDynamicSessionRuntimePreferencesRequest()((request) => {
      if (entry.abort.signal.aborted || pending.has(request.requestId)) return;
      pending.add(request.requestId);
      void (async () => {
        let resolution: RemoteRuntimePreferencesResponse["resolution"];
        try {
          if (!this.options.resolveRuntimePreferences)
            throw new Error("Host runtime preferences are not configured");
          const preferences =
            await this.options.resolveRuntimePreferences(request);
          // Keep this payload narrow even if a caller accidentally returns its
          // whole settings object. The native protocol validates these fields.
          resolution = {
            status: "resolved",
            preferences: {
              nativeSearchEnhancementsEnabled:
                preferences.nativeSearchEnhancementsEnabled,
              memoryEnabled: preferences.memoryEnabled,
              askUserQuestionAutoResolutionEnabled:
                preferences.askUserQuestionAutoResolutionEnabled,
              modelContextBudgetStrategy:
                preferences.modelContextBudgetStrategy,
              ...(preferences.subagentRuntimeConfigEnabled === undefined
                ? {}
                : {
                    subagentRuntimeConfigEnabled:
                      preferences.subagentRuntimeConfigEnabled,
                  }),
              ...(request.scope === "user-execution" &&
              preferences.integratedTerminalShell
                ? {
                    integratedTerminalShell:
                      preferences.integratedTerminalShell,
                  }
                : {}),
            },
          };
        } catch {
          resolution = {
            status: "failed",
            message: "Unable to resolve desktop runtime preferences",
          };
        }
        if (entry.abort.signal.aborted) return;
        await agent.respondSessionRuntimePreferences({
          requestId: request.requestId,
          resolution,
        });
      })()
        .catch(() => {
          if (!entry.abort.signal.aborted)
            this.options.onEvent?.({
              type: "remote.preferences_error",
              remoteId: entry.id,
            });
        })
        .finally(() => pending.delete(request.requestId));
    });
  }

  private disposeEntry(entry: RecordEntry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.abort.abort();
    const disposePreferences = () => {
      const subscription = entry.runtimePreferences;
      entry.runtimePreferences = undefined;
      try {
        subscription?.dispose();
      } catch {
        /* Continue revoking all resources. */
      }
    };
    disposePreferences();
    entry.disposal = (async () => {
      // A disconnect may race backend creation, deployment or provisioning. Wait
      // for that owned initialization before releasing resources assigned late.
      await entry.initialization?.catch(() => {});
      disposePreferences();
      // Revoke before closing transport: a stale remote provider must stop working.
      await Promise.allSettled([
        Promise.resolve().then(() => entry.lease?.release()),
        Promise.resolve().then(() => entry.relay?.dispose()),
        Promise.resolve().then(() => entry.provisioning?.dispose()),
      ]);
      try {
        if (entry.connection)
          await entry.connection.disposeAndWait({ timeoutMs: 5_000 });
        else entry.backend?.dispose();
      } finally {
        if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
      }
    })();
    return entry.disposal;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.entries.keys()].map((id) => this.disconnect(id)),
    );
  }
}

/** Check the ABI actually required by our bundled terminal binary, not Node's
 * lower minimum. A failed/unknown probe blocks deployment rather than leaving
 * a connected workspace with a permanently broken terminal. */
export async function assertRemoteGlibc(
  backend: Remote.IRemoteBackend,
  symbols: string[],
): Promise<void> {
  const required = symbols
    .map((value) => /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value))
    .filter((value): value is RegExpExecArray => Boolean(value))
    .map((value) => value.slice(1).map((part) => Number(part ?? 0)))
    .sort(compareVersion)
    .at(-1);
  if (!required) throw new Error("远端组件缺少可验证的 glibc 兼容信息");
  const stream = await backend.exec("getconf GNU_LIBC_VERSION");
  let output = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    if (output.length < 4096) output += chunk.toString();
  });
  stream.stderr.resume();
  await new Promise<void>((resolveProbe, reject) => {
    const timer = setTimeout(() => {
      stream.stdin.end();
      reject(new Error("无法验证远端 glibc 版本，请检查系统兼容性后重试"));
    }, 10_000);
    const disposable = stream.onClose((code) => {
      clearTimeout(timer);
      disposable.dispose();
      if (code !== 0)
        reject(
          new Error("此远端系统无法提供 glibc 版本，不能使用当前终端组件"),
        );
      else resolveProbe();
    });
  });
  const match = /(?:glibc|GNU libc)\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) throw new Error("无法确认远端 glibc 版本，不能使用当前终端组件");
  const actual = match.slice(1).map((part) => Number(part ?? 0));
  if (compareVersion(actual, required) < 0) {
    throw new Error(
      `当前远端终端组件需要 glibc ${required[0]}.${required[1]} 或更高版本；检测到 ${actual[0]}.${actual[1]}`,
    );
  }
}

function compareVersion(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Resolve an explicitly selected alias using the original config path only. */
export async function resolveSSHConfigTarget(
  target: Extract<Shared.RemoteTarget, { kind: "ssh" }>,
  configPath = process.env.LOLICODE_SSH_CONFIG_PATH,
  query: (args: string[]) => Promise<string> = async (args) => {
    try {
      const { stdout } = await promisify(execFile)("ssh", args, {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch {
      throw new Error("无法读取所选 SSH 配置，请检查系统 SSH 与配置文件路径");
    }
  },
): Promise<Extract<Shared.RemoteTarget, { kind: "ssh" }>> {
  if (!target.sshConfigAlias) return target;
  if (!configPath || !isAbsolute(configPath))
    throw new Error("原始 SSH 配置路径不可用，请直接填写主机和认证信息");
  const alias = target.sshConfigAlias.trim();
  if (!alias || alias.startsWith("-") || /[\s\0\r\n]/.test(alias))
    throw new Error("SSH 配置名称无效");
  const output = await query([
    "-G",
    "-F",
    configPath,
    "-o",
    "BatchMode=yes",
    alias,
  ]);
  const entries = new Map(
    output.split(/\r?\n/).map((line) => {
      const index = line.indexOf(" ");
      return index < 0
        ? [line.toLowerCase(), ""]
        : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
    }),
  );
  if (
    ["proxycommand", "proxyjump"].some(
      (key) => entries.has(key) && entries.get(key) !== "none",
    )
  ) {
    throw new Error(
      "此 SSH 配置需要跳板机；当前原生连接后端不支持，请填写可直接连接的主机",
    );
  }
  const host =
    target.host && target.host !== alias
      ? target.host
      : entries.get("hostname");
  const username = target.username || entries.get("user");
  const port = target.port ?? Number(entries.get("port") ?? 22);
  if (
    !host ||
    !username ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  )
    throw new Error("SSH 配置缺少有效的主机、用户或端口");
  const originalHome = dirname(dirname(configPath));
  const expand = (path: string) =>
    path.startsWith("~/") || path.startsWith("~\\")
      ? resolve(originalHome, path.slice(2))
      : path;
  let privateKeyPath = target.privateKeyPath
    ? expand(target.privateKeyPath)
    : undefined;
  if (!privateKeyPath && !target.password) {
    // Metadata/stat only here. Native SSH authentication owns key file reading;
    // the facade never copies key contents into its isolated home or responses.
    const candidate = entries.get("identityfile");
    if (candidate && candidate !== "none") {
      const path = expand(candidate);
      if (
        await stat(path).then(
          (item) => item.isFile(),
          () => false,
        )
      )
        privateKeyPath = path;
    }
  }
  return {
    ...target,
    host,
    username,
    port,
    ...(privateKeyPath ? { privateKeyPath } : {}),
  };
}

function isolateRemoteBackend(
  backend: Remote.IRemoteBackend,
  namespace: string,
): Remote.IRemoteBackend {
  // Keep native deployment logic, while giving LoliCode its own install root.
  // A ZCode user may have a different installed version in ~/.zcode/server.
  const mapLiteral = (value: string) => {
    const heartbeat =
      '(while [ "$(cat "$owner_file" 2>/dev/null || true)" = "$owner_token" ]; do touch "$owner_file" 2>/dev/null || exit 0; sleep 30; done) &';
    // Pinned native deploy-lock holder: killing its heartbeat shell can leave
    // the sleep child holding the SSH stdout/stderr pipe for 30s, exceeding the
    // genuine lock owner's 5s release timeout. Only detach this known silent
    // loop's stdio; its owner check, heartbeat, cleanup trap and lock stay intact.
    const mapped = value
      .replaceAll("/.zcode/server", "/.lolicode/server")
      .replaceAll(
        heartbeat,
        heartbeat.replace("done) &", "done) </dev/null >/dev/null 2>&1 &"),
      );
    return value.includes("runtime_root=")
      ? mapped.replaceAll(
          '"$HOME/.lolicode/server/agents/',
          '"$runtime_root/agents/',
        )
      : mapped;
  };
  const ownedPath = (value: string) =>
    mapLiteral(value).replace(/(?:\\[0-7]{3})+/g, (encoded) => {
      // Native deploy-lock holders and literal files use printf %b with octal
      // bytes. Rewrite the decoded script too, then preserve that exact encoding
      // boundary; shell quoting/nested traps cannot expose the upstream root.
      const decoded = Buffer.from(
        (encoded.match(/\\([0-7]{3})/g) ?? []).map((part) =>
          Number.parseInt(part.slice(1), 8),
        ),
      ).toString("utf8");
      const mapped = mapLiteral(decoded);
      return mapped === decoded
        ? encoded
        : [...Buffer.from(mapped)]
            .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
            .join("");
    });
  const ownedWrapper = ownedPath;
  return {
    // Native deployment uses this marker for WSL's byte-upload wrapper path.
    ...((backend as { kind?: string }).kind
      ? { kind: (backend as { kind?: string }).kind }
      : {}),
    detect: () => backend.detect(),
    upload: async (local, remote, options) => {
      if (/^zcode-agent-wrapper-\d+-\d+\.sh$/.test(basename(local))) {
        // WSL's native deployer uploads this generated shell script as bytes,
        // so rewriting only exec commands or remote file names is insufficient.
        // Rewrite an owned copy; never modify the upstream temp/user source.
        const original = await readFile(local, "utf8");
        if (original.length > 1024 * 1024)
          throw new Error("Remote wrapper is unexpectedly large");
        const temporary = await mkdtemp(
          join(tmpdir(), "lolicode-remote-wrapper-"),
        );
        const file = join(temporary, "wrapper.sh");
        try {
          await writeFile(file, ownedWrapper(original), {
            encoding: "utf8",
            mode: 0o600,
          });
          await backend.upload(file, ownedPath(remote), options);
        } finally {
          await rm(file, { force: true });
          await rmdir(temporary).catch(() => {});
        }
      } else await backend.upload(local, ownedPath(remote), options);
    },
    exists: (path) => backend.exists(ownedPath(path)),
    readFile: async (path) => {
      const value = await backend.readFile(ownedPath(path));
      // Native wrapper freshness checks compare the generated source. Present
      // the original virtual path while the actual file uses our install root.
      return path.includes("/agents/") &&
        value.includes('exec "$runtime_root/node"')
        ? value
            .replaceAll(
              '"$runtime_root/agents/',
              '"$HOME/.zcode/server/agents/',
            )
            .replaceAll("$HOME/.lolicode/server", "$HOME/.zcode/server")
        : value;
    },
    exec: (command) => {
      // Deployment commands can mention zcode-server.cjs too; only the native
      // server launch owns a private HOME. Assets always stay in the real user's
      // separate .lolicode/server install tree.
      const launch =
        command.includes("ZCODE_SERVER_RUNTIME_ROOT=") &&
        command.includes("~/.zcode/server/node");
      const mapped = command.includes("runtime_root=")
        ? ownedWrapper(command)
        : ownedPath(command);
      return backend.exec(
        launch
          ? // env receives ordinary arguments, expanded before it changes HOME.
            // Leading shell assignments otherwise expand sequentially on dash:
            // the next $HOME (including native binary root) can already be private.
            `lolicode_remote_home="$HOME"; mkdir -p "$lolicode_remote_home/.lolicode/remote/${namespace}/home" && env HOME="$lolicode_remote_home/.lolicode/remote/${namespace}/home" USERPROFILE="$lolicode_remote_home/.lolicode/remote/${namespace}/home" ZCODE_DATA_BASE_DIR="$lolicode_remote_home/.lolicode/remote/${namespace}/data" GLM_BINARY_PATH="$lolicode_remote_home/.lolicode/server/agents/glm/zcode-agent" ${mapped}`
          : mapped,
      );
    },
    dispose: () => backend.dispose(),
    ...(backend.onDidDisconnect
      ? { onDidDisconnect: backend.onDidDisconnect }
      : {}),
    ...(backend.disposeAndWait
      ? { disposeAndWait: (options) => backend.disposeAndWait!(options) }
      : {}),
    ...(backend.resolveRuntimeProxy
      ? { resolveRuntimeProxy: (url) => backend.resolveRuntimeProxy!(url) }
      : {}),
  };
}

export interface StdioGatewayRelay {
  /** Remote loopback address only; the native provider appends its API paths. */
  baseUrl: string;
  apiKey: string;
  activeRequests(): number;
  dispose(): Promise<void>;
}

const ALLOWED_PATHS = new Set([
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
]);
const REQUEST_LIMIT = 16 * 1024 * 1024;

/**
 * An authenticated HTTP relay over the backend's existing encrypted stdio
 * transport. Neither upstream credentials nor the desktop gateway lease leave
 * the worker; the remote receives a separate random, revocable relay token.
 */
export async function startStdioGatewayRelay(
  backend: Remote.IRemoteBackend,
  lease: GatewayLease,
  signal?: AbortSignal,
): Promise<StdioGatewayRelay> {
  const origin = new URL(lease.baseUrl);
  if (
    !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Gateway relay requires a private loopback endpoint");
  }
  if (!lease.bearerToken)
    throw new Error("Gateway lease credential is required");
  if (signal?.aborted) throw new Error("Remote connection canceled");
  // Only a constant program enters the command line. Credentials enter stdin.
  const program = REMOTE_RELAY_PROGRAM;
  const command = `~/.zcode/server/node -e '${program.replaceAll("'", "'\\''")}'`;
  const stream = await backend.exec(command);
  const token = randomBytes(32).toString("base64url");
  const requests = new Map<string, AbortController>();
  let closed = false;
  let resolveReady!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const lines = createInterface({ input: stream.stdout });
  let writeChain = Promise.resolve();
  const write = (frame: unknown) => {
    const operation = writeChain.then(async () => {
      if (closed) return;
      if (!stream.stdin.write(`${JSON.stringify(frame)}\n`))
        await once(stream.stdin, "drain");
    });
    writeChain = operation.catch(() => {});
    return operation;
  };
  const forward = async (frame: Record<string, unknown>) => {
    const id = String(frame.id ?? "");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || requests.has(id))
      throw new Error("Invalid gateway request");
    const path = String(frame.path ?? "");
    const method = frame.method;
    if (
      !ALLOWED_PATHS.has(path) ||
      (path === "/v1/models" ? method !== "GET" : method !== "POST")
    ) {
      await write({
        type: "head",
        id,
        status: 403,
        headers: { "content-type": "application/json" },
      });
      await write({
        type: "data",
        id,
        body: Buffer.from('{"error":"Relay route is not allowed"}').toString(
          "base64",
        ),
      });
      await write({ type: "end", id });
      return;
    }
    const body = frame.body
      ? Buffer.from(String(frame.body), "base64")
      : undefined;
    if (body && body.length > REQUEST_LIMIT)
      throw new Error("Gateway request is too large");
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${lease.bearerToken}`,
      };
      for (const [name, value] of Object.entries(
        (frame.headers ?? {}) as Record<string, unknown>,
      )) {
        if (
          [
            "content-type",
            "accept",
            "anthropic-version",
            "anthropic-beta",
          ].includes(name.toLowerCase()) &&
          typeof value === "string"
        ) {
          headers[name.toLowerCase()] = value;
        }
      }
      const target = new URL(origin);
      target.pathname = `${origin.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}${path}`;
      const response = await fetch(target, {
        method: String(method),
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
      const responseHeaders: Record<string, string> = {};
      for (const name of ["content-type", "cache-control", "retry-after"]) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      await write({
        type: "head",
        id,
        status: response.status,
        headers: responseHeaders,
      });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < chunk.length; offset += 48_000) {
              await write({
                type: "data",
                id,
                body: Buffer.from(
                  chunk.slice(offset, offset + 48_000),
                ).toString("base64"),
              });
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      await write({ type: "end", id });
    } catch {
      // Do not forward native fetch errors: URLs/headers may contain credentials.
      await write({
        type: "error",
        id,
        message: "The desktop model gateway is unavailable",
      });
    } finally {
      requests.delete(id);
    }
  };
  lines.on("line", (line) => {
    if (line.length > 24 * 1024 * 1024) {
      void dispose();
      return;
    }
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (
        frame.type === "ready" &&
        Number.isInteger(frame.port) &&
        Number(frame.port) > 0 &&
        Number(frame.port) <= 65535
      ) {
        resolveReady(Number(frame.port));
      } else if (frame.type === "request") {
        void forward(frame).catch(() =>
          write({
            type: "error",
            id: frame.id,
            message: "Invalid relay request",
          }),
        );
      } else if (frame.type === "cancel")
        requests.get(String(frame.id))?.abort();
    } catch {
      void dispose();
    }
  });
  // Drain diagnostic stderr without forwarding arbitrary remote text to logs/UI.
  stream.stderr.resume();
  const onError = () => {
    rejectReady(new Error("Gateway relay transport closed"));
    void dispose();
  };
  stream.stdin.on("error", onError);
  stream.stdout.on("error", onError);
  const closeSubscription = stream.onClose(onError);
  const onAbort = () => {
    rejectReady(new Error("Remote connection canceled"));
    void dispose();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    rejectReady(new Error("Gateway relay startup timed out"));
    void dispose();
  }, 15_000);
  timeout.unref?.();
  async function dispose(): Promise<void> {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    closeSubscription.dispose();
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    lines.close();
    stream.stdin.end();
    stream.stdout.off("error", onError);
    // Keep stdin's error handler through shutdown: late EPIPE must not crash host.
  }
  try {
    await write({ type: "configure", token });
    const port = await ready;
    clearTimeout(timeout);
    if (signal?.aborted || closed)
      throw new Error("Remote connection canceled");
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: token,
      activeRequests: () => requests.size,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Exact remote program, also executed as a local child in offline transport tests. */
export const REMOTE_RELAY_PROGRAM = String.raw`
const http = require("node:http");
const crypto = require("node:crypto");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const pending = new Map();
let token, server;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const stop = () => { for (const res of pending.values()) res.destroy(); pending.clear(); server?.closeAllConnections(); server?.close(); lines.close(); process.exitCode = 0; };
process.stdin.on("end", stop);
process.stdout.on("error", stop);
lines.on("line", line => {
  if (line.length > 24 * 1024 * 1024) return stop();
  let frame; try { frame = JSON.parse(line); } catch { return stop(); }
  if (frame.type === "configure" && !server && typeof frame.token === "string" && frame.token.length >= 32) {
    token = frame.token;
    server = http.createServer((req, res) => {
      const actual = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from("Bearer " + token);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); return res.end(); }
      const allowed = ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages"];
      if (!allowed.includes(req.url) || (req.url === "/v1/models" ? req.method !== "GET" : req.method !== "POST")) { res.writeHead(403); return res.end(); }
      const id = crypto.randomBytes(16).toString("hex");
      const chunks = []; let size = 0;
      req.on("data", chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(chunk); });
      req.on("end", () => { if (res.writableEnded) return; pending.set(id, res); send({ type: "request", id, path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("base64") }); });
      res.on("close", () => { if (pending.delete(id)) send({ type: "cancel", id }); });
    });
    server.requestTimeout = 0;
    server.listen(0, "127.0.0.1", () => send({ type: "ready", port: server.address().port }));
    return;
  }
  const res = pending.get(frame.id); if (!res) return;
  if (frame.type === "head") res.writeHead(frame.status, frame.headers);
  if (frame.type === "data") res.write(Buffer.from(frame.body, "base64"));
  if (frame.type === "end") { pending.delete(frame.id); res.end(); }
  if (frame.type === "error") { pending.delete(frame.id); if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: frame.message })); }
});
`;
