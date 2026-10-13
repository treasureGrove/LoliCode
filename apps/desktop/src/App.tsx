import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Activity, ArrowUpRight, Check, CheckCircle2, ChevronRight, Copy, Globe2, KeyRound, Layers3, Link2, Loader2, LockKeyhole, Pencil, Plus, Radio, ShieldCheck, Trash2, X } from 'lucide-react';

type Channel = { id: string; name: string; providerId: string; baseUrl: string; model: string; enabled: boolean; confirmedFree: boolean; keyPresent: boolean };
type Status = { running: boolean; baseUrl: string; version: string; error: string | null };
type Probe = { nonStream: boolean; stream: boolean; durationMs: number; verifiedAt: number };
type Log = { timestamp: number; channelId: string; model: string; status: number; durationMs: number; result: string };
type Draft = { id?: string; name: string; providerId: string; baseUrl: string; model: string; enabled: boolean; confirmedFree: boolean; apiKey: string };
const presets = [
  { id: 'zhipu-bigmodel', name: '智谱 BigModel', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', note: '模型与接口来自官方文档，免费条件请核对你的账户。' },
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', model: '', note: '请在供应商控制台确认当前免费模型与限额。' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: '', note: '仅添加你的账户套餐中已确认免费的模型。' },
  { id: 'custom', name: '自定义渠道', url: '', model: '', note: '填写 OpenAI Chat Completions 兼容接口和模型。' },
];
const emptyDraft = (): Draft => ({ name: presets[0].name, providerId: presets[0].id, baseUrl: presets[0].url, model: presets[0].model, enabled: true, confirmedFree: false, apiKey: '' });
const errorText = (error: unknown) => typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '操作没有完成，请稍后重试。';

export default function App() {
  const desktop = isTauri();
  const [page, setPage] = useState<'channels' | 'connect' | 'logs'>('channels');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<Status>({ running: false, baseUrl: 'http://127.0.0.1:4310/v1', version: '0.1.0', error: null });
  const [logs, setLogs] = useState<Log[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const dialog = useRef<HTMLDialogElement>(null);

  async function refresh() {
    if (!desktop) return;
    try {
      const [nextStatus, nextChannels, nextLogs] = await Promise.all([invoke<Status>('gateway_status'), invoke<Channel[]>('list_channels'), invoke<Log[]>('request_logs')]);
      setStatus(nextStatus); setChannels(nextChannels); setLogs(nextLogs);
    } catch (e) { setNotice({ text: errorText(e), error: true }); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [desktop]);
  useEffect(() => { if (draft && dialog.current && !dialog.current.open) dialog.current.showModal(); if (!draft) dialog.current?.close(); }, [draft]);

  async function action(key: string, fn: () => Promise<unknown>, message?: string) {
    if (!desktop || busy) return;
    setBusy(key); setNotice(null);
    try { await fn(); if (message) setNotice({ text: message }); await refresh(); }
    catch (e) { setNotice({ text: errorText(e), error: true }); }
    finally { setBusy(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    const input = { ...draft, id: draft.id ?? null, apiKey: draft.apiKey || null };
    await action('save', async () => { await invoke('save_channel', { input }); setDraft(null); }, '渠道已保存。可以测试连接，然后接入你的客户端。');
  }
  const active = channels.filter(c => c.enabled).length;
  const copy = (kind: string, id?: string) => action(`copy-${kind}`, () => invoke('copy_connection', { kind, id: id ?? null }), kind === 'token' ? '本地令牌已复制。请粘贴到客户端的 API Key 字段。' : '已复制。');
  const currentPreset = presets.find(p => p.id === draft?.providerId);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Layers3 size={23}/></span><span>FreeHub<small>让模型连接更简单</small></span></div>
      <div className="nav-caption">工作台</div>
      <nav aria-label="主要导航">
        <button className={page === 'channels' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('channels')}><Globe2 size={18}/>我的渠道<span className="nav-count">{channels.length}</span></button>
        <button className={page === 'connect' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('connect')}><Link2 size={18}/>接入客户端</button>
        <button className={page === 'logs' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('logs')}><Activity size={18}/>调用记录</button>
      </nav>
      <div className="sidebar-bottom"><ShieldCheck size={18}/><div>密钥留在你的电脑<small>对话直接连接模型供应商</small></div></div>
      <div className="version">FreeHub {status.version}<button className="text-button" disabled={!desktop || !!busy} onClick={() => void action('quit', () => invoke('quit_app'))}>退出</button></div>
    </aside>
    <main>
      <header className="topbar"><span>你的本地模型连接中心</span><span className={`status-pill ${status.running ? 'online' : ''}`}><span className="status-dot"/>{status.running ? '本地网关运行中' : desktop ? '网关未就绪' : '桌面界面预览'}</span></header>
      <div className="content">
        {!desktop && <div className="notice warning">这是界面预览。添加密钥与调用模型请使用 Windows 桌面应用。</div>}
        {status.error && <div className="notice error" role="alert">{status.error}<button className="text-button" disabled={!!busy} onClick={() => void action('retry', () => invoke('retry_gateway'))}>重新启动网关</button></div>}
        {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <Radio size={17}/> : <CheckCircle2 size={17}/>}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16}/></button></div>}
        {page === 'channels' && <>
          <div className="page-heading"><div><div className="eyebrow">全部连接 · {active} 个已启用</div><h1>我的渠道</h1><p>把自己的模型渠道连接到一起，在喜欢的客户端里使用。</p></div><button className="primary" disabled={!desktop || !!busy} onClick={() => setDraft(emptyDraft())}><Plus size={17}/>添加渠道</button></div>
          <section className="connection-strip" aria-label="本地接入点"><div className="connection-icon"><Link2 size={21}/></div><div><span className="label">统一接入地址</span><code>{status.baseUrl}</code></div><button className="icon-button" aria-label="复制接入地址" disabled={!desktop || !!busy} onClick={() => void copy('url')}><Copy size={17}/></button><span className="strip-divider"/><div className="key-summary"><LockKeyhole size={16}/><span>用本地令牌连接客户端</span></div><button className="secondary compact" disabled={!desktop || !!busy} onClick={() => setPage('connect')}>查看配置<ChevronRight size={15}/></button></section>
          {channels.length === 0 ? <section className="welcome"><div className="welcome-graphic"><Globe2 size={43}/><span className="small-shield"><ShieldCheck size={19}/></span></div><h2>从你的第一个渠道开始</h2><p>你已经有智谱 Key 了？选择智谱，粘贴密钥，<br/>测试连接后就可以在 Cherry Studio 使用。</p><button className="primary" disabled={!desktop || !!busy} onClick={() => setDraft(emptyDraft())}><Plus size={17}/>连接智谱 BigModel</button><div className="welcome-foot"><LockKeyhole size={14}/>Key 保存到 Windows 系统凭据库</div></section> : <div className="channel-list">{channels.map(c => <article className="channel-card" key={c.id}>
            <div className="channel-top"><span className="provider-icon"><Globe2 size={22}/></span><div className="channel-title"><h2>{c.name}</h2><span>{c.providerId === 'zhipu-bigmodel' ? '智谱开放平台' : c.providerId === 'custom' ? '自定义渠道' : c.providerId}</span></div><span className={`badge ${c.enabled ? 'enabled' : ''}`}>{c.enabled ? '已启用' : '已停用'}</span><button className="icon-button" aria-label={`编辑 ${c.name}`} disabled={!!busy} onClick={() => setDraft({ ...c, apiKey: '' })}><Pencil size={16}/></button></div>
            <div className="channel-model"><span>上游模型</span><code>{c.model}</code></div><div className="channel-meta"><span><KeyRound size={14}/>{c.keyPresent ? '密钥已安全保存' : '需要补充密钥'}</span><span>{probes[c.id] ? <><CheckCircle2 size={14}/>本次会话测试通过</> : <><Radio size={14}/>连接待测试</>}</span></div>
            <div className="channel-bottom"><code>{c.baseUrl}</code><button className="secondary compact" disabled={!!busy || !c.enabled} onClick={() => void action(`test-${c.id}`, async () => { const result = await invoke<Probe>('test_channel', { id: c.id }); setProbes(p => ({ ...p, [c.id]: result })); }, '普通调用和流式调用均已通过。')} >{busy === `test-${c.id}` ? <Loader2 className="spin" size={15}/> : <Activity size={15}/>}测试连接</button><button className="icon-button danger" aria-label={`删除 ${c.name}`} disabled={!!busy} onClick={() => { if (window.confirm(`删除“${c.name}”及其系统凭据？`)) void action(`delete-${c.id}`, () => invoke('delete_channel', { id: c.id }), '渠道及其密钥已删除。'); }}><Trash2 size={16}/></button></div>
          </article>)}</div>}
          <div className="privacy-note"><ShieldCheck size={18}/><div><strong>由你掌握连接和密钥</strong><p>FreeHub 使用你自己的渠道账户。测试连接会发送两次简短请求并使用供应商配额。</p></div></div>
        </>}
        {page === 'connect' && <>
          <div className="page-heading"><div><div className="eyebrow">一次配置，连接本机渠道</div><h1>接入客户端</h1><p>当前版本以 Cherry Studio 的 OpenAI 兼容连接为目标。</p></div><Link2 size={30} className="heading-icon"/></div>
          <section className="setup-panel"><h2>在 Cherry Studio 添加供应商</h2><ol className="setup-steps"><li><span className="step-number">1</span><div><strong>选择 OpenAI 兼容类型</strong><p>在客户端的供应商设置中添加一个连接，名称可填写 FreeHub。</p></div></li><li><span className="step-number">2</span><div><strong>填写 API 地址</strong><div className="copy-field"><code>{status.baseUrl}</code><button className="secondary compact" disabled={!desktop || !!busy} onClick={() => void copy('url')}><Copy size={15}/>复制地址</button></div></div></li><li><span className="step-number">3</span><div><strong>填写本地 API Key</strong><p>复制本地令牌，粘贴到客户端。你的真实智谱 Key 继续保存在系统凭据库中。</p><button className="secondary" disabled={!desktop || !!busy} onClick={() => void copy('token')}><KeyRound size={16}/>复制本地令牌</button></div></li><li><span className="step-number">4</span><div><strong>获取或添加模型</strong><p>使用客户端“获取模型”功能，或复制下面的网关模型 ID。</p>{channels.filter(c => c.enabled).map(c => <div className="copy-field" key={c.id}><code>{c.id}/{c.model}</code><button className="icon-button" aria-label={`复制 ${c.name} 模型 ID`} disabled={!!busy} onClick={() => void copy('model', c.id)}><Copy size={16}/></button></div>)}{active === 0 && <button className="text-button" onClick={() => setPage('channels')}>先添加并测试一个渠道<ChevronRight size={15}/></button>}</div></li></ol></section>
          <div className="token-tools"><div><strong>需要更换本地令牌？</strong><p>更换后，所有客户端都需要重新粘贴新令牌。</p></div><button className="secondary" disabled={!desktop || !!busy} onClick={() => { if (window.confirm('更换本地令牌？已有客户端的旧令牌将立即失效。')) void action('rotate', () => invoke('rotate_token'), '本地令牌已更换，请重新配置客户端。'); }}>更换令牌</button></div>
          <p className="support-note">Codex Responses 和 Claude Code Messages 适配尚未完成。完整兼容结果将在实际客户端验收后公布。</p>
        </>}
        {page === 'logs' && <>
          <div className="page-heading"><div><div className="eyebrow">仅保存调用元数据</div><h1>调用记录</h1><p>最近 30 次请求。自动清理超过 30 天的记录，对话正文始终不落盘。</p></div><button className="secondary" disabled={!desktop || !!busy} onClick={() => void refresh()}><Activity size={16}/>刷新</button></div>
          <div className="logs-table"><table><thead><tr><th>时间</th><th>模型</th><th>结果</th><th>耗时</th></tr></thead><tbody>{logs.map((l, i) => <tr key={`${l.timestamp}-${i}`}><td>{new Date(l.timestamp * 1000).toLocaleTimeString('zh-CN')}</td><td><code>{l.model}</code></td><td><span className={l.status === 200 ? 'result-ok' : 'result-error'}>{l.status === 200 ? '完成' : `${l.status} · ${l.result}`}</span></td><td>{l.durationMs.toLocaleString()} ms</td></tr>)}</tbody></table>{logs.length === 0 && <div className="empty-logs"><Activity size={28}/><p>还没有调用记录</p><span>测试连接或从客户端调用模型后，记录会显示在这里。</span></div>}</div>
        </>}
      </div>
    </main>
    <dialog ref={dialog} className="channel-dialog" onCancel={event => { if (busy) event.preventDefault(); else setDraft(null); }} onClick={e => { if (e.target === e.currentTarget && !busy) setDraft(null); }}>
      {draft && <form onSubmit={event => void save(event)}><div className="dialog-heading"><div><div className="eyebrow">自己的账户，自己的密钥</div><h2>{draft.id ? '编辑渠道' : '添加模型渠道'}</h2></div><button type="button" className="icon-button" disabled={!!busy} aria-label="关闭添加渠道" onClick={() => setDraft(null)}><X size={19}/></button></div>
        {notice?.error && <div className="notice error" role="alert">{notice.text}</div>}
        <label>渠道<select value={draft.providerId} disabled={!!draft.id || !!busy} onChange={e => { const p = presets.find(p => p.id === e.target.value)!; setDraft({ ...emptyDraft(), name: p.name, providerId: p.id, baseUrl: p.url, model: p.model }); }}>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="provider-help"><span>{currentPreset?.note}</span>{draft.providerId !== 'custom' && <button type="button" className="text-button" onClick={() => void action('signup', () => invoke('open_provider', { providerId: draft.providerId }))}>打开控制台<ArrowUpRight size={13}/></button>}</div>
        <label>显示名称<input required maxLength={120} value={draft.name} disabled={!!busy} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
        <label>API 地址<input required type="url" placeholder="https://…/v1" value={draft.baseUrl} disabled={!!busy} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}/></label>
        <label>模型 ID<input required maxLength={200} placeholder="供应商控制台中的精确模型名称" value={draft.model} disabled={!!busy} onChange={e => setDraft({ ...draft, model: e.target.value })}/></label>
        <label>API Key<span className="field-hint">{draft.id ? '留空保留已有密钥' : '只保存到 Windows 凭据库'}</span><input required={!draft.id} type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={!!busy} placeholder={draft.id ? '如需更换，请粘贴新 Key' : '粘贴你自己的渠道 Key'} onChange={e => setDraft({ ...draft, apiKey: e.target.value })}/></label>
        <label className="check-field"><input type="checkbox" checked={draft.confirmedFree} disabled={!!busy} onChange={e => setDraft({ ...draft, confirmedFree: e.target.checked })}/><span>我已确认此模型在我的账户套餐中免费</span></label>
        <label className="check-field"><input type="checkbox" checked={draft.enabled} disabled={!!busy} onChange={e => setDraft({ ...draft, enabled: e.target.checked })}/><span>启用此渠道</span></label>
        <div className="dialog-footer"><span><ShieldCheck size={15}/>Key 不会上传到 FreeHub 服务器</span><button className="primary" type="submit" disabled={!!busy || !desktop || (draft.enabled && !draft.confirmedFree)}>{busy === 'save' ? <Loader2 className="spin" size={16}/> : <Check size={16}/>}保存渠道</button></div>
      </form>}
    </dialog>
  </div>;
}
