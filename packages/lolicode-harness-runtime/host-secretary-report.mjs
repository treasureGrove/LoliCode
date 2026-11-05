import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";

export const reportToolName = "report_task";
const states = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];

// A report belongs to this assignment. No ticket or channel address is
// accepted from the model, so a worker cannot report on another assignment.
export function installSecretaryReport(agent, transport) {
  const scope = agent.ctx;
  scope.tools.register(createMcpToolDefinition(scope, {
    name: reportToolName,
    rawName: reportToolName,
    description: [
      "Report the state and concise summary of your assigned task to the secretary.",
      "Use progress for a meaningful update while working, waiting for an external trigger,",
      "ready when the result is ready for handoff, blocked when you cannot proceed,",
      "failed when execution failed, or dropped when there is no work to do.",
      "For a question use ask_user_question. Present deliverables separately with present.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: states },
        summary: { type: "string", minLength: 1, maxLength: 3000 },
      },
      required: ["state", "summary"],
      additionalProperties: false,
    },
    async call(args, execution) {
      execution.signal.throwIfAborted();
      if (execution.agent !== agent || !states.includes(args.state) ||
          typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 3000) {
        throw new Error("Invalid task report");
      }
      const summary = args.summary.trim();
      transport.notify("lolicode/secretary.report", {
        sessionId: agent.session.id,
        state: args.state,
        summary,
      });
      return { content: [{ type: "text", text: `Task report recorded: ${args.state}` }] };
    },
  }));
  scope.systemPrompt.section({
    name: "lolicode:secretary-report",
    order: scope.systemPrompt.getSectionOrder("TEAM_POLICY"),
    text: "Report significant progress and the outcome of your assignment using report_task. Report ready after presenting verified deliverables. Use ask_user_question for a specific question and report blocked if a prerequisite is missing.",
    interpolate: false,
  });
}
