import path from "node:path";
import { Context } from "@deepseek-ai/cordis";

/**
 * A disposable, observation-only composition of the pinned official services.
 * Starting the SDK profile also loads providers, tool backends, package discovery
 * and configuration watchers. None are needed to read a stored session, but all
 * official wire projection providers are: omitting them silently drops state.
 * Keep this composition covered by full live/cold Gateway contract comparisons.
 */
export async function createNativeReaderContext(home, sessions) {
  if (!path.isAbsolute(home) || !path.isAbsolute(sessions)) throw new Error("Invalid native reader directories");
  const entries = [
    ["@deepseek-ai/dsh-session"],
    ["@deepseek-ai/dsh-session-projection"],
    ["@deepseek-ai/dsh-session-persistence-jsonl", { root: sessions }],
    ["@deepseek-ai/dsh-session-query"],
    ["@deepseek-ai/dsh-storage"],
    ["@deepseek-ai/dsh-storage-json", { root: path.join(home, "storages") }],
    ["@deepseek-ai/dsh-storage-domain", { backend: "json" }],
    ["@deepseek-ai/dsh-system-prompt"],
    ["@deepseek-ai/dsh-tools"],
    ["@deepseek-ai/dsh-agent"],
    // An empty official registry satisfies the controller's type dependencies.
    // No model provider, declarative Agent or startup plugin. The lazy executor
    // dependencies below remain unused.
    ["@deepseek-ai/dsh-llm"],
    ["@deepseek-ai/dsh-agent-default-model", { provider: "readonly", model: "readonly" }],
    ["@deepseek-ai/dsh-fs-local", { cwd: home }],
    ["@deepseek-ai/dsh-attachment-local", { dshHome: home }],
    ["@deepseek-ai/dsh-credentials-local", { dshHome: home, watch: false }],
    ["@deepseek-ai/dsh-agent-loop", { agents: [] }],
    ["@deepseek-ai/dsh-token-meter"],
    ["@deepseek-ai/dsh-goal"],
    // This required, deployment-owned prompt is never assembled by a reader;
    // the official plan projection depends only on persisted events.
    ["@deepseek-ai/dsh-plan-mode", { section: "Read-only native session observation; do not activate an Agent." }],
    ["@deepseek-ai/dsh-tool-todo", { allowParallelInProgress: true }],
    ["@deepseek-ai/dsh-user-questions"],
    ["@deepseek-ai/dsh-session-title", { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }],
    ["@deepseek-ai/dsh-working-directory"],
    ["@deepseek-ai/dsh-subagent"],
    // rc.2 publishes persisted Team mode/tasks through this official service,
    // even when Team mode defaults off. Keep its projection without enabling
    // new Teams, registering Team tools, or activating any Agent.
    ["@deepseek-ai/dsh-agent-team", { defaultEnabled: false }],
    // The official permissions projection derives its view from these lazy
    // services. Registering them does not run a shell or provision a sandbox.
    ["@deepseek-ai/dsh-subprocess-local"],
    ["@deepseek-ai/dsh-sandbox-local"],
    ["@deepseek-ai/dsh-sandbox-policy", { mode: "workspace-write", workspaceRoot: home }],
    [process.platform === "win32" ? "@deepseek-ai/dsh-pwsh-sandbox" : "@deepseek-ai/dsh-bash-sandbox"],
    ["@deepseek-ai/dsh-user-approval", { policy: "ask" }],
    ["@deepseek-ai/dsh-permission-presets", { presets: {
      "read-only": { sandbox: "read-only", approval: "ask" },
      "workspace-write": { sandbox: "workspace-write", approval: "ask" },
      "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
    } }],
    ["@deepseek-ai/dsh-client-connection"],
    ["@deepseek-ai/dsh-api-remote-access"],
    ["@deepseek-ai/dsh-typert-registry"],
    ["@deepseek-ai/dsh-api-gateway"],
    ["@deepseek-ai/dsh-commands"],
    ["@deepseek-ai/dsh-workspace"],
    ["@deepseek-ai/dsh-client-file-upload"],
    ["@deepseek-ai/dsh-api-session-controller"],
    ["@deepseek-ai/dsh-session-stats"],
    ["@deepseek-ai/dsh-session-turn-outline"],
  ];
  const modules = await Promise.all(entries.map(([name]) => import(name)));
  const ctx = new Context();
  try {
    const fibers = entries.map(([, config], index) => ctx.plugin(modules[index].default ?? modules[index], config));
    for (const fiber of fibers) await fiber.await();
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
