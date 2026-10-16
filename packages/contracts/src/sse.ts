/** A bounded incremental SSE decoder shared by the browser client and Node engine adapter. */
export async function* readSse(response: Response): AsyncGenerator<{ id?: string; event: string; data: string }> {
  if (!response.body) throw new Error("Event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: string[] = [];
  let frameLength = 0;
  const decode = (lines: string[]) => {
    const result: { id?: string; event: string; data: string } = { event: "message", data: "" };
    const data: string[] = [];
    for (const line of lines) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "data") data.push(value);
      if (field === "event") result.event = value;
      if (field === "id" && !value.includes("\0")) result.id = value;
    }
    result.data = data.join("\n");
    return result;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Event line exceeds limit");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          const value = decode(frame); frame = []; frameLength = 0;
          if (value.data) yield value;
        } else if (!line.startsWith(":")) {
          frameLength += line.length;
          if (frameLength > 4 * 1024 * 1024) throw new Error("Event frame exceeds limit");
          frame.push(line);
        }
      }
    }
    // An unfinished frame is not committed. A reconnect must recover from a snapshot/cursor.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
