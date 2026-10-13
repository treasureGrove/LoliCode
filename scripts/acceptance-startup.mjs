import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
const dir = resolve('artifacts/startup-acceptance');
await mkdir(dir, { recursive: true });
let child;
try {
  child = spawn(resolve('target/debug/freehub.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, FREEHUB_ACCEPTANCE_DATA_DIR: resolve(dir, 'data') } });
  child.on('error', () => {});
  const deadline = Date.now() + 20000;
  while (true) {
    try { const r = await fetch('http://127.0.0.1:4310/health', { signal: AbortSignal.timeout(500) }); if (r.ok) break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Bundled desktop gateway did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  const health = await (await fetch('http://127.0.0.1:4310/health')).json();
  if (health.protocol !== 'openai-chat-completions') throw new Error('Wrong gateway protocol');
  const unauthorized = await fetch('http://127.0.0.1:4310/v1/models');
  if (unauthorized.status !== 401) throw new Error('Bundled desktop gateway lacks authentication');
  const second = spawn(resolve('target/debug/freehub.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, FREEHUB_ACCEPTANCE_DATA_DIR: resolve(dir, 'data') } });
  await Promise.race([once(second, 'exit'), new Promise((_, reject) => setTimeout(() => { second.kill(); reject(new Error('Single-instance check failed')); }, 5000))]);
  const report = { passed: true, checks: ['bundled Windows executable starts its gateway', 'model queries require authentication', 'duplicate instance exits'], realProvider: 'pending user key', nativeUI: 'pending manual acceptance' };
  await writeFile(resolve(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { if (child && child.exitCode === null) child.kill(); }
