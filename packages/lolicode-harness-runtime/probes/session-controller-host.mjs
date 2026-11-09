// Test-only IPC access to real official Host services. Never loaded by production.
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "lolicode-session-controller-probe";
export const inject = ["sessionController", "sessionProjections", "sessionQuery", "sessionPersistence", "sessions", "agents"];

export function apply(ctx) {
  if (!process.send || !process.env.LOLICODE_SESSION_REUSE_PROBE) {
    throw new Error("The session controller probe requires an isolated IPC child");
  }
  const sessionId = "session-controller-reuse-fixture";
  const address = { kind: "session", sessionId };

  async function operation(method) {
    if (method === "seed") {
      const session = ctx.sessions.create(sessionId, { meta: { cwd: process.cwd() } });
      for (const turn of [1, 2, 3]) {
        session.append("turn/start", { turn });
        session.append("user/message", createUserMessage({
          content: [{ type: "text", text: `Fixture turn ${turn}` }],
          source: { kind: "user", rpcId: `fixture-${turn}` },
        }), { surfaceOp: "append" });
        session.append("step/start", { turn, step: 1 });
        session.append("step/end", { turn, step: 1 });
        session.append("turn/end", { turn, reason: { kind: turn === 3 ? "max-tokens" : "completed" } });
      }
      // A bare Session has no Agent persistence owner. Explicitly write this
      // fixture through the real backend, then release the single-writer lease.
      const stored = await ctx.sessionPersistence.create(session.header);
      try {
        // Include events from real domain plugins too, e.g. the fallback title.
        const { events } = await ctx.sessionQuery.readSession(sessionId);
        await stored.append(events);
        await stored.flush();
      } finally {
        await stored.close();
      }
      return { sessionId, path: (await ctx.sessionPersistence.stat(sessionId)).location.path };
    }
    if (method !== "read") throw new Error("Unknown probe operation");
    const signal = AbortSignal.timeout(10_000);
    const agentsBefore = ctx.agents.list().length;
    const canonical = await ctx.sessionQuery.readSession(sessionId);
    const pages = [];
    let beforeSeq;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await ctx.sessionController.events({ address, maxMessages: 1, beforeSeq }, signal);
      pages.push(page);
      if (!page.hasMore) break;
      const oldest = page.records[0]?.event.seq;
      if (!Number.isInteger(oldest) || (beforeSeq !== undefined && oldest >= beforeSeq)) {
        throw new Error("Official history paging made no progress");
      }
      beforeSeq = oldest;
    }
    if (pages.at(-1).hasMore) throw new Error("Probe page limit exceeded");
    const projections = await ctx.sessionController.projections({ sessionId }, signal);
    const state = await ctx.sessionController.state({ sessionId }, signal);
    const followAbort = new AbortController();
    const follow = ctx.sessionController.follow({ address, assistantStream: true, maxMessages: 1 }, followAbort.signal);
    let opening;
    try {
      opening = (await follow.next()).value;
    } finally {
      followAbort.abort();
      await follow.return();
    }
    return {
      canonical: canonical.events,
      pages,
      projections,
      state,
      opening,
      agentsBefore,
      agentsAfter: ctx.agents.list().length,
      httpServerStarted: ctx.get("webServer") !== undefined,
    };
  }

  const onMessage = ({ id, method } = {}) => {
    operation(method).then(
      (result) => process.send?.({ id, result }),
      (error) => process.send?.({ id, error: { message: error.message, stack: error.stack } }),
    );
  };
  ctx.effect(() => {
    process.on("message", onMessage);
    return () => { process.off("message", onMessage); };
  });
  process.send({ ready: true });
}
