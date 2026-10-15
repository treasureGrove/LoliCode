import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createNativeExtensionAdapter } from "./extensions.js";
import { NodeServices, Services } from "./services.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const home = process.env.LOLICODE_FACADE_TEST_HOME;
  assert.ok(
    home && home === process.env.HOME && home === process.env.USERPROFILE,
    "Native extension tests require a child process with an isolated home before module import",
  );
  const workspace = await mkdtemp(
    join(tmpdir(), "lolicode-native-extensions-"),
  );
  const services = new Services.ServiceCollection();
  const skillService = NodeServices.createSkillsService({
    isDesktopRuntime: true,
  });
  const mcpService = NodeServices.createMcpSyncService();
  const calls: Array<{ method: string; input: any }> = [];
  let pluginList: any[] = [];
  const pluginService = {
    async listPlugins() {
      return { plugins: pluginList, diagnostics: [] };
    },
    async addPluginMarketplace(input: any) {
      calls.push({ method: "addMarketplace", input });
      return { diagnostics: [] };
    },
    async installPlugin(input: any) {
      calls.push({ method: "install", input });
      const id = `${input.pluginName}@${input.marketplace}`;
      pluginList = [
        {
          id,
          name: input.pluginName,
          enabled: true,
          rootPath: "native-owned-path",
          configuredOptions: { token: "fixture-secret" },
        },
      ];
      return {
        installedPlugins: [
          { name: input.pluginName, marketplace: input.marketplace },
        ],
        diagnostics: [],
      };
    },
    async setPluginEnabled(input: any) {
      calls.push({ method: "enable", input });
      pluginList[0].enabled = input.enabled;
      return {};
    },
    async uninstallPlugin(input: any) {
      calls.push({ method: "uninstall", input });
      pluginList = [];
      return { diagnostics: [] };
    },
    async configurePlugin(input: any) {
      calls.push({ method: "configure", input });
      return { diagnostics: [] };
    },
  };
  services.register(Services.ISkillsService, skillService);
  services.register(Services.IMcpSyncService, mcpService);
  services.register(Services.IPluginManagementService, pluginService as never);
  services.register(Services.IZCodeAgentService, {
    async getSkillReferenceCatalog() {
      return { authority: "workspace", skills: [] };
    },
  } as never);
  let busy = false;
  const adapter = createNativeExtensionAdapter({
    services,
    privateRoot: home,
    homeDirectory: home,
    workspace: () => ({ path: workspace }),
    isBusy: () => busy,
  });
  cleanups.push(async () => {
    await rm(workspace, { recursive: true, force: true });
    // These are test-owned child HOME directories, never the real user's home.
    await rm(join(home, ".zcode"), { recursive: true, force: true });
    await rm(join(home, "extensions"), { recursive: true, force: true });
  });
  return {
    home,
    workspace,
    adapter,
    calls,
    mcpService,
    skillService,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

test("native skills import, discovery and enable state work without changing original bytes", async () => {
  const { workspace, adapter } = await fixture();
  const source = join(workspace, "source-skill");
  await mkdir(source);
  const original =
    "---\nname: fixture-skill\ndescription: Offline fixture only.\n---\nOriginal instructions.\n";
  await writeFile(join(source, "SKILL.md"), original);
  const catalog = await adapter.importSkill(source);
  const imported = catalog.skills.find(
    (skill) => skill.name === "fixture-skill",
  );
  assert.ok(imported);
  assert.equal(imported.loaded, null); // A workspace directory is not a resident session snapshot.
  assert.equal(
    (await adapter.setSkillEnabled(imported.id, false)).skills.find(
      (skill) => skill.id === imported.id,
    )?.enabled,
    false,
  );
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), original);
  assert.ok(
    !(await adapter.removeSkill(imported.id)).skills.some(
      (skill) => skill.id === imported.id,
    ),
  );
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), original);
});

test("MCP credentials and positional arguments stay masked and unchanged when toggled", async () => {
  const { adapter, mcpService } = await fixture();
  await mcpService.saveMcpToUserDirectory({
    action: "upsert",
    source: "zcodeagentmcp",
    name: "fixture",
    config: {
      type: "stdio",
      command: "node",
      args: ["server.js", "secret-position"],
      env: { TOKEN: "private-environment" },
      enabled: true,
    },
  });
  const config = await adapter.getExtensionConfig();
  const text = JSON.stringify(config);
  assert.ok(
    !text.includes("secret-position") && !text.includes("private-environment"),
  );
  const servers = config.mcp.servers as Record<string, any>;
  servers.fixture.disabled = true;
  await adapter.saveExtensionConfig(config);
  const saved = (await mcpService.loadMcpFromUserDirectory()).servers.find(
    (server) => server.name === "fixture",
  )!;
  assert.equal(saved.config.type, "stdio");
  assert.deepEqual(saved.config.args, ["server.js", "secret-position"]);
  assert.equal(saved.config.env?.TOKEN, "private-environment");
  assert.equal(saved.enabled, false);
  await assert.rejects(adapter.saveExtensionConfig(config), /已被修改/);
});

test("new hidden credentials and malformed native options fail before any MCP write", async () => {
  const { adapter, mcpService } = await fixture();
  const config = await adapter.getExtensionConfig();
  config.mcp.servers = {
    invalid: { type: "local", command: ["node", "[hidden]"] },
  };
  await assert.rejects(adapter.saveExtensionConfig(config), /占位符/);
  assert.deepEqual((await mcpService.loadMcpFromUserDirectory()).servers, []);
  config.mcp.servers = {
    valid: { type: "remote", url: "https://offline.invalid/mcp" },
  };
  config.pluginOptions = { missing: { unknown: {} } };
  await assert.rejects(
    adapter.saveExtensionConfig(config),
    /找不到|格式|只接受/,
  );
  assert.deepEqual((await mcpService.loadMcpFromUserDirectory()).servers, []);
});

test("native plugin import uses an unchanged manifest and the genuine marketplace/install API contract", async () => {
  const { workspace, adapter, calls } = await fixture();
  const source = join(workspace, "plugin-source");
  await mkdir(join(source, ".zcode-plugin"), { recursive: true });
  const original = JSON.stringify({
    name: "fixture-native",
    version: "1.0.0",
    description: "Offline fixture",
  });
  await writeFile(join(source, ".zcode-plugin", "plugin.json"), original);
  const catalog = await adapter.installPlugin(source);
  assert.equal(calls[0].method, "addMarketplace");
  assert.equal(calls[1].method, "install");
  assert.equal(calls[1].input.pluginName, "fixture-native");
  assert.ok(calls[1].input.marketplace.startsWith("lolicode-local-"));
  assert.equal(
    await readFile(
      join(calls[0].input.source, "plugin", ".zcode-plugin", "plugin.json"),
      "utf8",
    ),
    original,
  );
  assert.equal(
    await readFile(join(source, ".zcode-plugin", "plugin.json"), "utf8"),
    original,
  );
  assert.equal(catalog.plugins[0].loaded, null);
  const config = await adapter.getExtensionConfig();
  assert.equal(
    (config.pluginOptions[catalog.plugins[0].id] as any).token,
    "[hidden]",
  );
  await adapter.setPluginEnabled(catalog.plugins[0].id, false);
  assert.equal(calls.at(-1)?.input.pluginId, catalog.plugins[0].id);
});

test("OpenCode executable plugins are rejected and a running task prevents mutation", async () => {
  const { workspace, adapter, setBusy, calls } = await fixture();
  const plugin = join(workspace, "opencode.js");
  await writeFile(plugin, "export default { id: 'v2-only' };");
  await assert.rejects(adapter.installPlugin(plugin), /OpenCode JS/);
  setBusy(true);
  await assert.rejects(adapter.setPluginEnabled("fixture", true), /任务结束/);
  assert.equal(calls.length, 0);
});
