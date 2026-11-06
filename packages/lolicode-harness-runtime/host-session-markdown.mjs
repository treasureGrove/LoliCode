import path from "node:path";
import { formatSessionMarkdown } from "@deepseek-ai/dsh-session-log-export";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";

export const logMissing = "LOLICODE_SESSION_LOG_MISSING";
export const logCold = "LOLICODE_SESSION_LOG_COLD";
export const markdownTooLarge = "LOLICODE_SESSION_MARKDOWN_TOO_LARGE";
export const logUnreadable = "LOLICODE_SESSION_LOG_UNREADABLE";

export function formatBoundedSessionMarkdown(events, sourcePath) {
  const markdown = formatSessionMarkdown(events, sourcePath);
  if (Buffer.byteLength(markdown, "utf8") > 8 * 1024 * 1024 ||
      Buffer.byteLength(JSON.stringify(markdown), "utf8") >= 31 * 1024 * 1024) {
    throw new Error(markdownTooLarge);
  }
  return markdown;
}

export async function materializedSessionPath(persistence, sessionId) {
  const metadata = await persistence.stat(sessionId);
  if (metadata) return metadata.location?.path;

  // JSONL stat may omit a malformed header. Let its read handle distinguish
  // a missing log from a corrupt one before allowing a missing-log fallback.
  const handle = await persistence.open(sessionId, "read");
  await handle.close();
  const current = await persistence.stat(sessionId);
  if (!current) throw new Error(logUnreadable);
  return current.location?.path;
}

export function sessionMarkdownError(error) {
  if (error instanceof SessionPersistenceNotFoundError || error?.code === "SESSION_QUERY_SESSION_NOT_FOUND" ||
      error?.message === logMissing) return logMissing;
  if (error?.message === markdownTooLarge) return markdownTooLarge;
  return logUnreadable;
}

async function readColdMarkdown(sessions, sessionId) {
  if (!sessions || !path.isAbsolute(sessions) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId ?? "")) {
    throw new Error(logUnreadable);
  }

  // Mount only the upstream read backend. A read handle acquires no write
  // lease and leaves historical generations on disk unchanged.
  const [{ Context }, { apply }, { readColdSessionLog }] = await Promise.all([
    import("@deepseek-ai/cordis"),
    import("@deepseek-ai/dsh-session-persistence-jsonl"),
    import("@deepseek-ai/dsh-session-query"),
  ]);
  const ctx = new Context();
  try {
    await ctx.plugin(apply, { root: sessions }).await();
    const { events } = await readColdSessionLog(ctx.sessionPersistence, sessionId);
    const sourcePath = (await ctx.sessionPersistence.stat(sessionId))?.location?.path;
    if (!sourcePath) throw new Error(logUnreadable);
    return formatBoundedSessionMarkdown(events, sourcePath);
  } finally {
    await ctx.root.fiber.dispose();
  }
}

if (import.meta.main) {
  try {
    const [, , sessions, sessionId] = process.argv;
    process.stdout.write(await readColdMarkdown(sessions, sessionId));
  } catch (error) {
    const message = sessionMarkdownError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = message === logMissing ? 2 : message === markdownTooLarge ? 3 : 1;
  }
}
