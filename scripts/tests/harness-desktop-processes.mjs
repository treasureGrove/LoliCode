import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const normalized = (value) => String(value).replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");

export function fixtureSdkProcesses(rows, profile) {
  const root = normalized(profile);
  assert.match(root, /(?:^|\/)lolicode-harness-desktop-[^/]+\/\.lolicode-dev$/,
    "Process observation requires a disposable desktop acceptance profile");
  const prefix = `${root}/agent/harness-desktop/`;
  return rows.flatMap((row) => {
    const command = normalized(row.commandLine ?? "");
    const offset = command.indexOf(prefix);
    if (offset < 0 || !command.includes("/node_modules/@deepseek-ai/dsh/lib/bin.js") ||
        !/--profile\s+"?sdk(?:"|\s|$)/.test(command) ||
        !command.includes("/host-operations.cordis.patch.yml")) return [];
    const session = command.slice(offset + prefix.length)
      .match(/^([a-f0-9-]{36})\/channel-[^/"\s]+\.cordis\.patch\.yml(?:"|\s|$)/);
    if (!session) return [];
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 &&
      typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)),
    "The isolated SDK process is missing its PID or creation time");
    return [{ pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt,
      sessionId: `lc:${session[1]}` }];
  }).sort((left, right) => left.pid - right.pid);
}

function processQuery(profile) {
  // Keep the path in an environment value: it is never interpolated as shell code.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:LOLICODE_ACCEPTANCE_PROCESS_ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |",
    "  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; commandLine = $_.CommandLine; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress",
  ].join("\n");
  return {
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    options: {
      env: { ...process.env, LOLICODE_ACCEPTANCE_PROCESS_ROOT: profile },
      windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    },
  };
}

function processResult(stdout, profile) {
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return fixtureSdkProcesses(value == null ? [] : Array.isArray(value) ? value : [value], profile);
}

export function readFixtureSdkProcesses(profile) {
  const { args, options } = processQuery(profile);
  const result = spawnSync("powershell.exe", args, options);
  assert.equal(result.status, 0, result.error?.message || result.stderr || "Cannot observe fixture SDK processes");
  return processResult(result.stdout, profile);
}

export async function readFixtureSdkProcessesAsync(profile, run = execFileAsync) {
  const { args, options } = processQuery(profile);
  const startedAt = performance.now();
  const { stdout } = await run("powershell.exe", args, options);
  return { processes: processResult(stdout, profile),
    processQueryMs: Math.round(performance.now() - startedAt) };
}
