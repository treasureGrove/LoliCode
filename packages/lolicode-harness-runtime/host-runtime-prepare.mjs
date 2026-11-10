import { prepareNativeSession } from "./host-session-native.mjs";

const preparations = new WeakMap();

/** Prepare observation and adapter code without creating an Agent or a call. */
export async function prepareRuntime(ctx) {
  const host = ctx.root;
  let ready = preparations.get(host);
  if (!ready) {
    ready = Promise.all([
      prepareNativeSession(host),
      // This official public module is otherwise imported by pi-ai's first
      // stream call. Importing it creates no model request or provider client.
      import("@earendil-works/pi-ai/api/openai-completions"),
    ]).then(() => {});
    preparations.set(host, ready);
  }
  try {
    await ready;
  } catch (error) {
    if (preparations.get(host) === ready) preparations.delete(host);
    throw error;
  }
}
