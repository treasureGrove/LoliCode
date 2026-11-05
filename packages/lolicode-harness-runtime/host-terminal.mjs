import { Context } from "@deepseek-ai/cordis";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import path from "node:path";
import readline from "node:readline";

const context = new Context();
await context.plugin(LocalSubprocessRuntime);
const subprocess = context.subprocess;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let terminal;
let closing;

async function send(event) {
  await new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(event) + "\n", (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function close(code) {
  closing ??= (async () => {
    input.close();
    process.stdin.destroy();
    await terminal?.terminate().catch(() => {});
    await send({ type: "exit", code }).catch(() => {});
    process.exit(0);
  })();
  return closing;
}

async function forwardOutput(handle) {
  for await (const data of handle.output.setEncoding("utf8")) {
    // Bound a single JSON frame even when the provider coalesces a burst.
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(data.length, offset + 16_384);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end -= 1;
      await send({ type: "output", data: data.slice(offset, end) });
      offset = end;
    }
  }
}

try {
  for await (const line of input) {
    const message = JSON.parse(line);
    if (message.type === "start" && !terminal) {
      const environment = await subprocess.terminalEnvironment();
      const windows = environment.platform === "windows";
      const shell = windows
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : environment.defaultShell || "/bin/sh";
      const executable = await subprocess.resolveExecutable(shell);
      terminal = await subprocess.spawnTerminal({
        argv: [executable, ...(windows ? ["-NoLogo", "-NoProfile"] : ["-i"])],
        cwd: message.cwd,
        cols: message.cols,
        rows: message.rows,
        terminalType: "xterm-256color",
        graceMs: 250,
      });
      const handle = terminal;
      const ready = send({ type: "ready" });
      void Promise.all([handle.done, ready.then(() => forwardOutput(handle))])
        .then(([outcome]) => close(outcome.exitCode ?? 1), () => close(1));
      await ready;
    } else if (terminal && message.type === "input") {
      await terminal.write(message.data);
    } else if (terminal && message.type === "resize") {
      await terminal.resize(message.cols, message.rows);
    }
  }
  await close(0);
} catch {
  await close(1);
}
