import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = resolve('artifacts/ui-acceptance');
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1120, height: 768 } });
// This fixture tests React behavior only. Vault and network behavior are tested in Rust.
await context.addInitScript(() => {
  let channels = [];
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
    switch (cmd) {
      case 'gateway_status': return { running: true, baseUrl: 'http://127.0.0.1:4310/v1', version: '0.1.0', error: null };
      case 'list_channels': return channels.map(c => ({ ...c }));
      case 'request_logs': return [];
      case 'save_channel': {
        const { apiKey, ...metadata } = args.input;
        const channel = { ...metadata, id: metadata.id || 'ui-fixture-channel', keyPresent: true };
        channels = [...channels.filter(c => c.id !== channel.id), channel];
        return channel;
      }
      case 'delete_channel': channels = channels.filter(c => c.id !== args.id); return;
      case 'copy_connection': case 'rotate_token': case 'open_provider': return;
      default: throw { code: 'unimplemented_fixture', message: '此界面测试未模拟这个操作。' };
    }
  }};
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const checks = [];
try {
  await page.goto('http://127.0.0.1:1420');
  await expect(page.getByRole('heading', { name: '从你的第一个渠道开始' })).toBeVisible();
  await page.screenshot({ path: resolve(dir, 'channels-empty.png') });
  await page.getByRole('button', { name: '添加渠道', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('API Key', { exact: false }).fill('SYNTHETIC-UI-FIXTURE-NOT-A-REAL-KEY');
  await expect(dialog.getByRole('button', { name: '保存渠道', exact: true })).toBeDisabled();
  await dialog.getByLabel('我已确认此模型在我的账户套餐中免费').check();
  await dialog.getByRole('button', { name: '保存渠道', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '智谱 BigModel', exact: true })).toBeVisible();
  checks.push('channel form, free confirmation and save flow');
  await page.screenshot({ path: resolve(dir, 'channel-fixture.png') });
  await page.getByRole('button', { name: '编辑 智谱 BigModel', exact: true }).click();
  await expect(dialog.getByLabel('API Key', { exact: false })).toHaveValue('');
  await dialog.getByLabel('显示名称', { exact: true }).fill('智谱 · 工作渠道');
  await dialog.getByRole('button', { name: '保存渠道', exact: true }).click();
  await expect(page.getByRole('heading', { name: '智谱 · 工作渠道' })).toBeVisible();
  checks.push('edit form never refills upstream secret');
  await page.getByRole('button', { name: '接入客户端', exact: true }).click();
  await expect(page.getByRole('heading', { name: '在 Cherry Studio 添加供应商' })).toBeVisible();
  await expect(page.getByText('ui-fixture-channel/glm-4.7-flash', { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(dir, 'client-setup.png') });
  checks.push('client setup shows actual configured public model ID');
  await page.getByRole('button', { name: /我的渠道/ }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: '删除 智谱 · 工作渠道', exact: true }).click();
  await expect(page.getByRole('heading', { name: '从你的第一个渠道开始' })).toBeVisible();
  checks.push('channel removal and empty state');
  await page.getByRole('button', { name: '调用记录', exact: true }).click();
  await expect(page.getByText('还没有调用记录', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow || errors.length) throw new Error('UI overflow or browser runtime errors');
  const report = { passed: true, kind: 'React UI with synthetic IPC fixture', checks, nativeIPC: 'not verified by this test' };
  await writeFile(resolve(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
