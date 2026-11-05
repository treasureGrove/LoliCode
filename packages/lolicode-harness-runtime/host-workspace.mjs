import { isSkillName } from "@deepseek-ai/dsh-skill";

const readTools = new Set([
  "read", "read_image", "grep", "glob", "list_directory", "list_files", "search_files",
  "skill", "ask_user_question", "todo", "list_agents", "session_query", "exit_plan_mode", "get_goal",
]);
const coordinationTools = new Set(["subagent", "present", "wait_agent", "send_input", "close_agent", "create_goal", "update_goal"]);
const escalationTools = new Set(["write", "edit", "apply_patch", "bash", "pwsh"]);
export const workspacePolicies = ["workspace", "review", "full", "plan"];

export function applyWorkspacePreset(ctx, agent, policy) {
  ctx.permissionPresets.set(agent.session, policy === "full" ? "danger-full-access" : "workspace-write");
}

export function installWorkspacePolicy(ctx, policyFor, isHostTool) {
  requireToolReview(ctx, execution => policyFor(execution.agent) === "review" && !isHostTool(execution.name));
  ctx.tools.guard(execution => policyFor(execution.agent) !== "plan" || readTools.has(execution.name) ||
    /^mcp_remote_(read_file|view_image|list_files|search_files|open_preview)$/.test(execution.name) ||
    isHostTool(execution.name)
    ? undefined : "Plan mode allows read-only tools");
}

export function requireToolReview(ctx, shouldReview = () => true) {
  ctx.on("tools/pre-execute", async (execution, next) => {
    const decision = await next();
    if (decision.kind !== "allow" || readTools.has(execution.name) ||
        coordinationTools.has(execution.name) || execution.name.startsWith("mcp_") ||
        !shouldReview(execution)) {
      return decision;
    }
    // These upstream tools request approval for this exact escalation before
    // execution. Let that request carry the justification to the desktop.
    if (escalationTools.has(execution.name) &&
        execution.arguments?.sandbox_permissions === "danger-full-access" &&
        typeof execution.arguments.justification === "string" && execution.arguments.justification.trim()) {
      return decision;
    }
    return { kind: "ask", reason: "The selected approval mode requires confirmation before changing files or running a potentially mutating operation." };
  });
}

export function configureWorkspace(ctx, agent, options) {
  const { policy, skills, memory } = options;
  if (!workspacePolicies.includes(policy) ||
      !Array.isArray(skills) || skills.length > 64 ||
      typeof memory !== "string" || memory.length > 5000) {
    throw new Error("Invalid LoliCode workspace options");
  }

  // Reapply the host-selected preset after resume. A previous automation with
  // Full access cannot leave that preset behind for a normal desktop turn.
  applyWorkspacePreset(ctx, agent, policy);

  const registered = new Set();
  for (const skill of skills) {
    const name = isSkillName(skill?.name) ? skill.name : skill?.id?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (typeof name !== "string" || !isSkillName(name) || registered.has(name) ||
        typeof skill.description !== "string" || typeof skill.content !== "string") continue;
    ctx.skills.register({ name, source: "bundled", description: skill.description, content: skill.content });
    registered.add(name);
  }
  if (memory.trim()) {
    agent.ctx.systemPrompt.section({
      name: "lolicode:memory",
      order: agent.ctx.systemPrompt.getSectionOrder("TEAM_POLICY"),
      text: memory,
      interpolate: false,
    });
  }
  return { registered: registered.size };
}
