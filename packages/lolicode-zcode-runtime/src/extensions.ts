import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Services } from "./services.mjs";
import type { Shared } from "./services.mjs";
import type { NativeServiceAccess } from "./automation.js";
import type {
  AgentExtensionConfig,
  AgentExtensions,
  AgentPluginStore,
} from "../../../src/types/agent.js";

type Workspace = { path: string; identity?: string; sessionId?: string };
export interface NativeExtensionOptions {
  services: NativeServiceAccess;
  privateRoot: string;
  /** Isolated HOME supplied to the native worker before importing services. */
  homeDirectory: string;
  workspace: () => Workspace | undefined;
  isBusy?: () => boolean;
}

/** UI compatibility over native ZCode skills, plugin management and MCP services. */
export function createNativeExtensionAdapter(options: NativeExtensionOptions) {
  let tail = Promise.resolve();
  const privateRoot = resolve(options.privateRoot);
  const home = resolve(options.homeDirectory);
  if (!isAbsolute(options.privateRoot) || !inside(privateRoot, home))
    throw new Error("Extensions require an isolated private home");
  const get = <T>(
    descriptor: Services.ServiceDescriptor<T>,
    property: keyof Services.IServiceAccessor,
  ): T => {
    const service =
      options.services.get?.(descriptor) ?? options.services[property];
    if (!service)
      throw new Error(
        `Native extension service is unavailable: ${descriptor.channelName}`,
      );
    return service as T;
  };
  const skills = () => get(Services.ISkillsService, "skillsService");
  const plugins = () =>
    get(Services.IPluginManagementService, "pluginManagementService");
  const agent = () => get(Services.IZCodeAgentService, "zcodeAgentService");
  const mcp = () => get(Services.IMcpSyncService, "mcpSyncService");

  async function target() {
    const workspace = options.workspace();
    if (workspace)
      return {
        workspacePath: workspace.path,
        workspaceIdentity: workspace.identity,
      };
    const scratch = join(privateRoot, "extensions-workspace");
    await mkdir(scratch, { recursive: true });
    return { workspacePath: scratch };
  }

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(async () => {
      if (options.isBusy?.())
        throw new Error("请等当前任务结束后再修改技能、插件或工具");
      return operation();
    });
    tail = current.then(
      () => {},
      () => {},
    );
    return current;
  };

  async function readNativeConfig() {
    const [servers, pluginList] = await Promise.all([
      mcp().loadMcpFromUserDirectory(),
      plugins().listPlugins(await target()),
    ]);
    const nativeServers = Object.fromEntries(
      servers.servers
        .filter(
          (server) =>
            server.source === "zcodeagentmcp" && server.scope === "user",
        )
        .map((server) => [
          server.name,
          { ...server.config, enabled: server.enabled !== false },
        ]),
    );
    const pluginOptions = Object.fromEntries(
      pluginList.plugins.map((plugin) => [
        plugin.id,
        plugin.configuredOptions ?? {},
      ]),
    );
    return { nativeServers, pluginOptions };
  }

  async function getExtensionConfig(): Promise<AgentExtensionConfig> {
    const current = await readNativeConfig();
    const value = {
      mcp: {
        servers: Object.fromEntries(
          Object.entries(current.nativeServers).map(([id, server]) => [
            id,
            nativeToUiMcp(server),
          ]),
        ),
      },
      pluginOptions: current.pluginOptions,
    };
    return {
      revision: revision(current),
      ...(mask(value) as object),
    } as AgentExtensionConfig;
  }

  async function getExtensions(): Promise<AgentExtensions> {
    const scope = await target();
    const [skillList, pluginList, config, runtimeMcp, runtimeSkills] =
      await Promise.all([
        skills().list(scope),
        plugins().listPlugins(scope),
        mcp().loadMcpFromUserDirectory(),
        mcp()
          .listWorkspaceMcpServerStatuses({ ...scope, mode: "status" })
          .catch(() => undefined),
        agent()
          .getSkillReferenceCatalog({
            ...scope,
            sessionId: options.workspace()?.sessionId,
          })
          .catch(() => undefined),
      ]);
    const native = await readNativeConfig();
    const authoritativeSession = runtimeSkills?.authority === "session";
    const loaded = new Map(
      runtimeSkills?.skills.map((skill) => [skill.id, skill]) ?? [],
    );
    return {
      revision: revision(native),
      skills: skillList.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.pluginId?.endsWith("@zcode-plugins-official")
          ? "bundled"
          : "local",
        installed: true,
        enabled: skill.enabled,
        requirements: requirements(skill.name),
        loaded: authoritativeSession ? loaded.has(skill.id) : null,
        runtimeId: loaded.has(skill.id) ? skill.id : null,
        runtimeStatus: !skill.enabled
          ? "disabled"
          : authoritativeSession
            ? loaded.has(skill.id)
              ? "loaded"
              : "pending_reload"
            : "unknown",
      })),
      plugins: pluginList.plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        entry: plugin.rootPath,
        enabled: plugin.enabled,
        // Current UI has one plugin collection. Native source identity remains
        // available in runtimeId; do not claim a configured manifest is active.
        source: "local",
        loaded: plugin.enabled ? null : false,
        runtimeId: plugin.id,
        runtimeStatus: !plugin.enabled
          ? "disabled"
          : plugin.packageStatus === "missing"
            ? "not_loaded"
            : "unknown",
        error: pluginList.diagnostics.find(
          (item) => item.pluginId === plugin.id && item.severity === "error",
        )?.message,
      })),
      mcpServers: config.servers
        .filter((server) => server.source === "zcodeagentmcp")
        .map((server) => {
          const status = runtimeMcp?.statuses[server.name];
          const connected = status?.status === "connected";
          return {
            id: server.name,
            type: server.config.command ? "local" : "remote",
            enabled: server.enabled !== false,
            loaded: connected ? true : server.enabled === false ? false : null,
            runtimeId: server.name,
            runtimeStatus:
              server.enabled === false
                ? "disabled"
                : (status?.status ?? "unknown"),
            error: status?.error,
          };
        }),
      ...(authoritativeSession
        ? {
            loadedSkills: runtimeSkills.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
            })),
            pendingReload: skillList.skills.some(
              (skill) => skill.enabled !== loaded.has(skill.id),
            ),
          }
        : {}),
      ...(runtimeMcp
        ? {
            loadedMcpServers: Object.entries(runtimeMcp.statuses).map(
              ([name, value]) => ({
                name,
                status: value.status,
                error: value.error,
              }),
            ),
          }
        : {}),
    };
  }

  async function getPluginStore(): Promise<AgentPluginStore> {
    const overview = await plugins().getPluginsOverview(await target());
    return overview as AgentPluginStore;
  }

  async function findSkill(id: string) {
    const scope = await target();
    const skill = (await skills().list(scope)).skills.find(
      (item) => item.id === id,
    );
    if (!skill) throw new Error("找不到这个技能，请刷新后重试");
    return { scope, skill };
  }

  return {
    getExtensions,
    getPluginStore,
    getExtensionConfig,
    async setSkillEnabled(id: string, enabled: boolean) {
      return mutate(async () => {
        const { scope, skill } = await findSkill(id);
        await skills().setEnabled({
          ...scope,
          scope: skill.scope,
          skillId: skill.id,
          enabled,
        });
        return getExtensions();
      });
    },
    async importSkill(path: string) {
      return mutate(async () => {
        const source = await realpath(path);
        await stat(join(source, "SKILL.md"));
        await validateCopy(source);
        const name = `${safeName(basename(source))}-${hash(source).slice(0, 10)}`;
        const destination = join(home, ".zcode", "skills", name);
        await mkdir(join(home, ".zcode", "skills"), { recursive: true });
        await cp(source, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        return getExtensions();
      });
    },
    async removeSkill(id: string) {
      return mutate(async () => {
        const { scope, skill } = await findSkill(id);
        if (skill.scope === "plugin")
          throw new Error("内置插件技能请通过停用插件管理，不能删除原始内容");
        // Never let a compatibility action delete an unrelated project skill.
        if (
          !inside(
            join(home, ".zcode", "skills"),
            resolve(skill.sourcePath ?? skill.path),
          )
        ) {
          throw new Error("只能移除已导入 LoliCode 私有目录的技能");
        }
        await skills().deleteSkill({ ...scope, skillId: id });
        return getExtensions();
      });
    },
    async installPlugin(path: string) {
      return mutate(async () => {
        const source = await realpath(path);
        if (!(await stat(source)).isDirectory())
          throw new Error(
            "请选择包含 .zcode-plugin/plugin.json 的原生插件文件夹；OpenCode JS 插件不能直接安装",
          );
        let manifest: { name?: string };
        try {
          manifest = JSON.parse(
            await readFile(
              join(source, ".zcode-plugin", "plugin.json"),
              "utf8",
            ),
          );
        } catch {
          throw new Error(
            "这不是 ZCode 原生插件：缺少有效的 .zcode-plugin/plugin.json",
          );
        }
        if (
          !manifest.name ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(manifest.name)
        )
          throw new Error("原生插件名称无效");
        await validateCopy(source);
        const marketplace = `lolicode-local-${hash(source).slice(0, 16)}`;
        const root = join(
          privateRoot,
          "extensions",
          "marketplaces",
          marketplace,
        );
        await mkdir(root, { recursive: true });
        const copied = join(root, "plugin");
        await cp(source, copied, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        // The wrapper marketplace is ours; the original plugin bytes are copied
        // unchanged and native plugin validation/install owns its semantics.
        await writeFile(
          join(root, "marketplace.json"),
          JSON.stringify({
            name: marketplace,
            plugins: [{ name: manifest.name, source: "./plugin" }],
          }),
          "utf8",
        );
        const scope = await target();
        assertNativeDiagnostics(
          await plugins().addPluginMarketplace({ ...scope, source: root }),
        );
        const result = await plugins().installPlugin({
          ...scope,
          marketplace,
          pluginName: manifest.name,
          scope: "user",
        });
        assertNativeDiagnostics(result);
        if (
          !result.installedPlugins.some(
            (plugin) =>
              plugin.name === manifest.name &&
              plugin.marketplace === marketplace,
          )
        )
          throw new Error("原生插件安装未完成，请检查插件声明后重试");
        return getExtensions();
      });
    },
    async addPluginMarketplace(source: string) {
      return mutate(async () => {
        const result = await plugins().addPluginMarketplace({
          ...(await target()),
          source: source.trim(),
        });
        assertNativeDiagnostics(result);
        return getPluginStore();
      });
    },
    async updatePluginMarketplace(marketplace?: string) {
      return mutate(async () => {
        const result = await plugins().updatePluginMarketplace({
          ...(await target()),
          ...(marketplace ? { marketplace } : {}),
        });
        assertNativeDiagnostics(result);
        return getPluginStore();
      });
    },
    async removePluginMarketplace(marketplace: string) {
      return mutate(async () => {
        const overview = await getPluginStore();
        const source = overview.marketplaces.find((item) => item.id === marketplace);
        if (!source) throw new Error("找不到这个插件市场，请刷新后重试");
        if (source.isOfficial || marketplace === "zcode-plugins-official")
          throw new Error("官方插件市场不能移除");
        assertNativeDiagnostics(
          await plugins().removePluginMarketplace({
            ...(await target()),
            marketplace,
          }),
        );
        return getPluginStore();
      });
    },
    async installMarketplacePlugin(marketplace: string, pluginName: string) {
      return mutate(async () => {
        const overview = await getPluginStore();
        const candidate = overview.availablePlugins.find(
          (item) => item.marketplace === marketplace && item.name === pluginName,
        );
        if (!candidate)
          throw new Error("插件不在当前市场目录中，请先刷新并重新选择");
        if (candidate?.listing?.requiresPaidPlan)
          throw new Error("这个插件需要付费套餐，当前市场不会安装此类插件");
        assertNativeDiagnostics(
          await plugins().installPlugin({
            ...(await target()),
            marketplace,
            pluginName,
            scope: "user",
          }),
        );
        return getPluginStore();
      });
    },
    async restoreBuiltinPlugin(pluginId: string) {
      return mutate(async () => {
        const overview = await getPluginStore();
        const candidate = overview.restorableBuiltins.find((item) => item.id === pluginId);
        if (!candidate) throw new Error("找不到可恢复的内置插件，请刷新市场后重试");
        if (candidate?.listing?.requiresPaidPlan)
          throw new Error("这个插件需要付费套餐，当前市场不会安装此类插件");
        assertNativeDiagnostics(
          await plugins().restoreBuiltinPlugin({
            ...(await target()),
            pluginId,
          }),
        );
        return getPluginStore();
      });
    },
    async updateMarketplacePlugin(pluginId: string) {
      return mutate(async () => {
        assertNativeDiagnostics(
          await plugins().updatePlugin({
            ...(await target()),
            pluginId,
          }),
        );
        return getPluginStore();
      });
    },
    async uninstallMarketplacePlugin(pluginId: string) {
      return mutate(async () => {
        assertNativeDiagnostics(
          await plugins().uninstallPlugin({
            ...(await target()),
            pluginId,
          }),
        );
        return getPluginStore();
      });
    },
    async setPluginEnabled(id: string, enabled: boolean) {
      return mutate(async () => {
        assertNativeDiagnostics(
          await plugins().setPluginEnabled({
            ...(await target()),
            pluginId: id,
            enabled,
            scope: "user",
          }),
        );
        return getExtensions();
      });
    },
    async uninstallPlugin(id: string) {
      return mutate(async () => {
        assertNativeDiagnostics(
          await plugins().uninstallPlugin({
            ...(await target()),
            pluginId: id,
          }),
        );
        return getExtensions();
      });
    },
    async saveExtensionConfig(input: AgentExtensionConfig) {
      return mutate(async () => {
        const original = await readNativeConfig();
        if (input.revision !== revision(original))
          throw new Error("工具设置已被修改，请刷新后重试");
        const previous = {
          mcp: {
            servers: Object.fromEntries(
              Object.entries(original.nativeServers).map(([id, value]) => [
                id,
                nativeToUiMcp(value),
              ]),
            ),
          },
          pluginOptions: original.pluginOptions,
        };
        const restored = restore(input, previous) as AgentExtensionConfig;
        const servers = restored.mcp.servers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers))
          throw new Error("MCP 工具配置格式无效");
        const next = Object.fromEntries(
          Object.entries(servers).map(([id, value]) => {
            if (!/^[a-zA-Z0-9_.-]+$/.test(id))
              throw new Error("MCP 工具名称无效");
            return [id, uiToNativeMcp(value)];
          }),
        );
        const nativePluginOptions = Object.entries(restored.pluginOptions).map(
          ([pluginId, value]) => {
            if (
              !Object.prototype.hasOwnProperty.call(
                original.pluginOptions,
                pluginId,
              )
            )
              throw new Error("找不到需要配置的原生插件");
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("原生插件选项格式无效");
            const options = value as Record<string, unknown>;
            if (
              Object.values(options).some(
                (item) =>
                  !["string", "boolean", "number"].includes(typeof item),
              )
            )
              throw new Error("原生插件选项只接受文本、数字或开关");
            return [pluginId, options] as const;
          },
        );
        // Validate every entry before the first write. Native services preserve
        // unrelated CLI configuration and persist native mcp.servers only.
        for (const id of Object.keys(original.nativeServers)) {
          if (!(id in next))
            await mcp().saveMcpToUserDirectory({
              action: "delete",
              source: "zcodeagentmcp",
              name: id,
            });
        }
        for (const [id, config] of Object.entries(next)) {
          await mcp().saveMcpToUserDirectory({
            action: "upsert",
            source: "zcodeagentmcp",
            name: id,
            config,
          });
        }
        const scope = await target();
        for (const [pluginId, options] of nativePluginOptions) {
          if (
            JSON.stringify(options) !==
            JSON.stringify(original.pluginOptions[pluginId])
          ) {
            assertNativeDiagnostics(
              await plugins().configurePlugin({
                ...scope,
                pluginId,
                options,
                scope: "user",
              }),
            );
          }
        }
        return getExtensions();
      });
    },
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function revision(value: unknown) {
  return Number.parseInt(hash(JSON.stringify(value)).slice(0, 12), 16);
}
function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "skill";
}
function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}
function requirements(name: string) {
  return ["docx", "pdf", "pptx", "xlsx"].includes(name)
    ? ["Python / Node.js；部分导出功能需要 LibreOffice"]
    : [];
}

function assertNativeDiagnostics(result: unknown) {
  const diagnostics =
    result && typeof result === "object"
      ? (result as { diagnostics?: Array<{ severity?: string }> }).diagnostics
      : undefined;
  if (diagnostics?.some((item) => item.severity === "error"))
    throw new Error("原生插件未通过验证，请检查插件配置后重试");
}

async function validateCopy(root: string) {
  let bytes = 0,
    files = 0;
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("导入目录包含符号链接，请先复制为普通文件");
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await walk(join(path, entry));
    } else if (info.isFile()) {
      bytes += info.size;
      files++;
    } else throw new Error("导入目录包含不支持的文件类型");
    if (bytes > 64 * 1024 * 1024 || files > 5_000)
      throw new Error("导入内容过大，请移除依赖缓存后重试");
  };
  await walk(root);
}

function nativeToUiMcp(
  value: Shared.McpServerConfig & { enabled?: boolean },
): Record<string, unknown> {
  if (value.command)
    return {
      type: "local",
      command: [value.command, ...(value.args ?? [])],
      ...(value.cwd ? { cwd: value.cwd } : {}),
      ...(value.env ? { environment: value.env } : {}),
      disabled: value.enabled === false,
    };
  return {
    type: "remote",
    url: value.url,
    ...(value.headers ? { headers: value.headers } : {}),
    ...(value.oauth ? { oauth: value.oauth } : {}),
    disabled: value.enabled === false,
    ...(value.type === "sse" ? { transport: "sse" } : {}),
  };
}

function uiToNativeMcp(value: unknown): Shared.McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP 工具配置格式无效");
  const item = value as Record<string, unknown>;
  if (item.disabled !== undefined && typeof item.disabled !== "boolean")
    throw new Error("MCP 启用状态无效");
  if (item.type === "local") {
    if (
      !Array.isArray(item.command) ||
      !item.command.length ||
      item.command.some((part) => typeof part !== "string" || !part)
    )
      throw new Error("本地 MCP 工具需要有效的启动命令");
    if (
      item.cwd !== undefined &&
      (typeof item.cwd !== "string" || !item.cwd.trim())
    )
      throw new Error("MCP 工作目录无效");
    return {
      type: "stdio",
      command: item.command[0],
      args: item.command.slice(1),
      enabled: item.disabled !== true,
      ...(item.cwd ? { cwd: item.cwd as string } : {}),
      ...(item.environment ? { env: stringRecord(item.environment) } : {}),
    };
  }
  if (item.type === "remote" && typeof item.url === "string") {
    const url = new URL(item.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("MCP 地址必须是有效的 HTTP 或 HTTPS 地址");
    return {
      type: item.transport === "sse" ? "sse" : "http",
      url: item.url,
      enabled: item.disabled !== true,
      ...(item.headers ? { headers: stringRecord(item.headers) } : {}),
      ...(item.oauth ? { oauth: oauthConfig(item.oauth) } : {}),
    };
  }
  throw new Error("不支持的 MCP 工具类型");
}

function stringRecord(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error("MCP 凭据与环境变量必须是文本");
  return value as Record<string, string>;
}

function oauthConfig(value: unknown): Shared.McpOAuthConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP 登录配置无效");
  const item = value as Record<string, unknown>;
  if (!["client_credentials", "authorization_code"].includes(String(item.type)))
    throw new Error("MCP 登录类型无效");
  if (
    item.type === "client_credentials" &&
    (typeof item.clientId !== "string" ||
      typeof item.clientSecret !== "string" ||
      !item.clientId ||
      !item.clientSecret)
  )
    throw new Error("MCP 客户端登录凭据不完整");
  if (
    Object.entries(item).some(
      ([key, value]) => key !== "type" && typeof value !== "string",
    )
  )
    throw new Error("MCP 登录配置必须是文本");
  return item as unknown as Shared.McpOAuthConfig;
}

function mask(value: unknown, key = ""): unknown {
  if (typeof value === "string" && key === "url") {
    try {
      const url = new URL(value);
      if (url.search || url.username || url.password) return "[hidden]";
    } catch {}
  }
  if (
    typeof value === "string" &&
    ["pluginOptions", "environment", "headers", "oauth"].includes(key)
  )
    return "[hidden]";
  if (Array.isArray(value))
    return value.map((item, index) =>
      key === "command" && index > 0 ? "[hidden]" : mask(item, key),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        mask(
          item,
          ["pluginOptions", "environment", "headers", "oauth"].includes(key)
            ? key
            : name,
        ),
      ]),
    );
  return value;
}

function restore(value: unknown, previous: unknown): unknown {
  if (value === "[hidden]") {
    if (previous === undefined) throw new Error("新的凭据不能填写隐藏占位符");
    return previous;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      restore(item, Array.isArray(previous) ? previous[index] : undefined),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        restore(
          item,
          previous && typeof previous === "object"
            ? (previous as Record<string, unknown>)[key]
            : undefined,
        ),
      ]),
    );
  return value;
}
