import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";

// The Rust host owns configured transports and credentials. The upstream MCP
// adapter owns model schemas, results, errors, and attachment projection.
export function installHostMcp(
  transport,
  {
    acceptsName = name => /^mcp_[A-Za-z0-9_-]{1,60}$/.test(name),
    onRegistered = () => {},
    workspacePolicy = () => undefined,
  } = {},
) {
  const configured = new WeakSet();
  return (agent, tools, scope = agent.ctx) => {
    if (!Array.isArray(tools) || tools.length > 512 || configured.has(agent)) {
      throw new Error("Invalid or repeated LoliCode MCP registration");
    }
    configured.add(agent);
    let registered = 0;
    for (const entry of tools) {
      const tool = entry?.function;
      if (!tool || typeof tool.name !== "string" || !acceptsName(tool.name) ||
          tool.parameters === null || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) continue;
      try {
        scope.tools.register(createMcpToolDefinition(scope, {
          name: tool.name,
          rawName: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.parameters,
          async call(args, execution) {
            execution.signal.throwIfAborted();
            const scope = execution.agent;
            if (!scope) throw new Error("LoliCode MCP requires a live agent session");
            const sessionId = String(scope.session.id);
            const callId = String(execution.callId);
            const abort = () => transport.notify("lolicode/mcp.cancelled", { sessionId, callId });
            execution.signal.addEventListener("abort", abort, { once: true });
            try {
              return await transport.request("lolicode/mcp/approve-and-call", {
                sessionId, callId, toolName: tool.name, arguments: args,
                workspacePolicy: workspacePolicy(scope),
              }, execution.signal);
            } finally {
              execution.signal.removeEventListener("abort", abort);
            }
          },
        }));
        onRegistered(tool.name);
        registered++;
      } catch {
        // A server's unsupported schema must not prevent other tools or the
        // Agent turn from running. Do not print untrusted schema details.
      }
    }
    return { registered };
  };
}
