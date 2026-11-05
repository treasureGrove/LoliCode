import { installHostMcp } from "./host-mcp.mjs";

const controls = new Set(["ask_user_question", "subagent", "send_message", "list_agents", "interrupt_agent"]);
const remoteName = /^mcp_remote_(read_file|view_image|list_files|search_files|write_file|apply_patch|run_command|open_preview)$/;

export function installHostRemote(ctx, transport) {
  const register = installHostMcp(transport);
  let configured = false;
  return (agent, params) => {
    const { tools, location } = params ?? {};
    if (
      configured || !Array.isArray(tools) || tools.length === 0 ||
      tools.length > 8 ||
      tools.some(tool => !remoteName.test(tool?.function?.name)) ||
      new Set(tools.map(tool => tool.function.name)).size !== tools.length ||
      typeof location?.name !== "string" || location.name.length > 128 ||
      typeof location.root !== "string" || !location.root.startsWith("/") ||
      location.root.length > 4096
    ) {
      throw new Error("Invalid or repeated LoliCode remote workspace registration");
    }
    configured = true;
    // Each remote turn has its own SDK process. Global registration carries
    // the host tools to child agents, including cold-resumed descendants.
    const allowed = new Set(tools.map(tool => tool.function.name));
    for (const tool of ctx.tools.definitions()) {
      if (controls.has(tool.name)) allowed.add(tool.name);
    }
    ctx.tools.guard(execution => {
      if (!allowed.has(execution.name)) return "This tool is unavailable in a remote workspace";
      if (execution.name === "subagent" && execution.arguments?.cwd !== undefined &&
          execution.arguments.cwd !== ".") return "Remote subagents inherit the selected workspace";
    });
    const result = register(agent, tools, ctx);
    if (result.registered !== tools.length) throw new Error("Remote tool registration failed");
    const restrict = target => target.ctx.tools.restrict({ allow: [...allowed] });
    restrict(agent);
    ctx.on("agent/created", ({ agent: child }) => restrict(child));
    ctx.systemPrompt.section({
      name: "lolicode:remote-workspace",
      order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY"),
      interpolate: false,
      text: [
        "This is a LoliCode remote workspace. The following JSON describes its location:",
        JSON.stringify({ name: location.name, root: location.root }),
        "Use the mcp_remote_* tools for files and commands and use relative POSIX paths.",
        "Subagents inherit the remote workspace. Omit the subagent cwd argument.",
        "The desktop path is a private session identity. Do not use it for project files.",
        "For previews, use mcp_remote_open_preview on a project file.",
      ].join("\n"),
    });
    return result;
  };
}
