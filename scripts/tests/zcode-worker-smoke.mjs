import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(tmpdir(), 'lolicode-native-smoke-'));
const workspace = path.join(directory, 'project'); await mkdir(workspace);
await writeFile(path.join(workspace, 'README.md'), 'Temporary offline runtime fixture.');
const runtime = path.resolve('src-tauri/resources/zcode-runtime');
const token = randomUUID() + randomUUID();
const child = spawn(path.join(runtime, 'node.exe'), [path.join(runtime, 'worker.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOLICODE_RUNTIME_DIAGNOSTICS: '1' } });
let errors = '', stdout = '';
child.stderr.on('data', (data) => { errors += String(data).slice(0, 2000); });
child.stdout.on('data', (data) => { stdout += String(data); });
child.stdin.write(JSON.stringify({ token, privateRoot: path.join(directory, 'private') }) + '\n');
const deadline = Date.now() + 30_000;
while (!stdout.includes('\n') && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
if (!stdout.includes('\n')) { child.kill(); throw new Error(`Worker bootstrap failed (exit ${child.exitCode}): ${errors}`); }
const ready = JSON.parse(stdout.split('\n')[0]); assert.equal(ready.event, 'ready');
const url = `http://127.0.0.1:${ready.port}/rpc`;
const rpc = async (method, args = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.error}`);
  return result.result;
};
let modelRequests = 0;
const requestedModels = [];
const model = createServer(async (request, response) => {
  let data = ''; for await (const chunk of request) data += chunk;
  const input = JSON.parse(data || '{}'); modelRequests++;
  assert.ok(['test-model', 'new-model'].includes(input.model));
  requestedModels.push(input.model);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'LOLICODE_NATIVE_FIXTURE_OK' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
try {
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await rpc('status')).available, true);
  const catalog = { revision: 1, models: [{ id: 'fixture/test-model', providerId: 'fixture', modelId: 'test-model', name: 'Fixture model', channelName: 'Offline fixture', contextLimit: 16000, outputLimit: 1000 }], defaultModel: 'fixture/test-model', excludedSources: [] };
  const project = await rpc('openProject', { path: workspace, catalog, gateway: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: 'local-fixture-token-no-upstream-key' } }).catch(async (error) => {
    console.error(JSON.stringify(await rpc('capability', { service: 'IProviderSettingsService', method: 'getView', args: [] })));
    throw error;
  });
  assert.equal(project.workspace.path, workspace);
  const session = await rpc('createSession', { modelId: catalog.defaultModel, mode: 'build', permissionMode: 'auto', title: 'Offline fixture' });
  assert.ok(session.id.startsWith('zc:'));
  const requestId = randomUUID();
  await rpc('sendMessage', { sessionId: session.id, text: 'Reply with the fixture token only.', requestId });
  let snapshot;
  const completedBy = Date.now() + 60_000;
  do {
    snapshot = await rpc('getSession', { sessionId: session.id });
    if (snapshot.messages.some((message) => message.parts.some((part) => part.text?.includes('LOLICODE_NATIVE_FIXTURE_OK'))) && snapshot.status === 'idle') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < completedBy);
  assert.equal(snapshot.status, 'idle', JSON.stringify(snapshot));
  assert.ok(snapshot.messages.some((message) => message.parts.some((part) => part.text?.includes('LOLICODE_NATIVE_FIXTURE_OK'))), JSON.stringify(snapshot));
  // Native ZCode can also ask the model to generate a session title. Wait for
  // that helper before measuring whether a retried command repeats execution.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(modelRequests >= 1);
  const baselineRequests = modelRequests;
  await rpc('sendMessage', { sessionId: session.id, text: 'Reply with the fixture token only.', requestId });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(modelRequests, baselineRequests, 'same command ID must not repeat model execution');
  assert.equal(await rpc('busy'), false);
  await rpc('beginUpdate');
  await assert.rejects(rpc('createSession', { modelId: catalog.defaultModel, mode: 'build', permissionMode: 'ask' }), /正在准备更新/);
  await rpc('endUpdate');
  const refreshed = { ...catalog, revision: 2, models: [...catalog.models, { ...catalog.models[0], id: 'fixture/new-model', modelId: 'new-model', name: 'New model' }] };
  await rpc('openProject', { path: workspace, catalog: refreshed, gateway: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: 'local-fixture-token-no-upstream-key' } });
  const added = await rpc('createSession', { modelId: 'fixture/new-model', mode: 'build', permissionMode: 'auto' });
  assert.equal(added.model.modelId, 'new-model');
  await rpc('sendMessage', { sessionId: added.id, text: 'Reply with the fixture token only.', requestId: randomUUID() });
  const refreshedBy = Date.now() + 30_000;
  do {
    snapshot = await rpc('getSession', { sessionId: added.id });
    if (snapshot.status === 'idle' && snapshot.messages.some((message) => message.parts.some((part) => part.text?.includes('LOLICODE_NATIVE_FIXTURE_OK')))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < refreshedBy);
  assert.equal(snapshot.status, 'idle');
  assert.ok(requestedModels.includes('new-model'), 'hot-reloaded model must reach the native SDK');
  const proof = { success: true, sourceRevision: 'aac4755666d09fdcd70272fcf063c077a639015f', nativeVersion: '3.15.1', modelRequests, paidCalls: 0, sessionPrefix: 'zc:', authenticatedTransport: true, updateBarrier: true, modelHotReload: true };
  await writeFile(path.join(tmpdir(), 'lolicode-native-worker-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(errors);
  throw error;
} finally {
  model.closeAllConnections(); model.close();
  child.stdin.end();
  let timeout;
  const exitCode = await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => { timeout = setTimeout(() => { child.kill(); resolve(-1); }, 12_000); })]);
  clearTimeout(timeout);
  assert.equal(exitCode, 0, errors);
}
