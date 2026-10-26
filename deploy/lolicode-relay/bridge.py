#!/usr/bin/env python3
"""Forum-authenticated inference with atomic daily reservations; no public API keys."""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid
from zoneinfo import ZoneInfo

import aiohttp
from aiohttp import web

ROOT = Path('/opt/lolicode-relay')
TZ = ZoneInfo('Asia/Singapore')
AUTH = re.compile(r'Bearer lc1\.([1-9][0-9]{0,16})\.([a-zA-Z0-9]{40})\Z')


class Rejected(Exception):
    def __init__(self, status, code, message, retry_after=None):
        self.status, self.code, self.message = status, code, message
        self.retry_after = retry_after


def reject(status, code, message, retry_after=None):
    raise Rejected(status, code, message, retry_after)


async def read_limited(response, limit):
    data = bytearray()
    async for chunk in response.content.iter_chunked(16384):
        if len(data) + len(chunk) > limit:
            reject(503, 'response_too_large', '服务返回内容超过限制。')
        data.extend(chunk)
    return bytes(data)


def calendar(now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(TZ)
    reset = (current + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return current.date().isoformat(), reset.isoformat()


def active_models(policy, now=None):
    end = policy.get('available_until')
    if end is not None:
        try:
            deadline = datetime.fromisoformat(end.replace('Z', '+00:00'))
            if deadline.tzinfo is None or (now or datetime.now(timezone.utc)) >= deadline:
                return []
        except (ValueError, TypeError, AttributeError):
            return []  # An invalid trial deadline must fail closed.
    return policy['models']


def public_limits(policy):
    return {'maxOutputTokens': policy['max_output_tokens'],
            'maxRequestBytes': policy['max_request_bytes'],
            'maxConcurrentPerAccount': policy['max_concurrent_per_account'],
            'maxConcurrentGlobal': policy.get('max_concurrent_global'),
            'globalRequestsPerMinute': policy.get('global_requests_per_minute'),
            'globalDailyRequests': policy.get('global_daily_requests'),
            'globalDailyTokens': policy.get('global_daily_tokens')}


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS accounts (
                    forum_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
                    gateway_id INTEGER UNIQUE, gateway_password TEXT NOT NULL, gateway_key TEXT,
                    disabled INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, forum_id TEXT NOT NULL, day TEXT NOT NULL,
                    reserved INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL, model TEXT NOT NULL, created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS request_account_day ON requests(forum_id,day,state);
                CREATE INDEX IF NOT EXISTS request_day_state ON requests(day,state);
                CREATE INDEX IF NOT EXISTS request_created_at ON requests(created_at);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        # The service runs one process. After a crash, unfinished calls cannot
        # receive a free retry: retain their reservation as conservative usage.
        with self.connect() as db:
            db.execute("UPDATE requests SET charged=reserved,state='uncertain' WHERE state='pending'")

    def account(self, identity):
        with self.connect() as db:
            db.execute('''INSERT INTO accounts(forum_id,username,display_name,gateway_password,updated_at)
                VALUES(?,?,?,?,?) ON CONFLICT(forum_id) DO UPDATE SET
                username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at''',
                (identity['id'], identity['username'], identity['displayName'], secrets.token_urlsafe(28), time.time()))
            row = dict(db.execute('SELECT * FROM accounts WHERE forum_id=?', (identity['id'],)).fetchone())
        if row['disabled']:
            reject(403, 'account_disabled', '此账号的公益模型权限已停用。')
        return row

    def material(self, identity, gateway_id, key):
        with self.connect() as db:
            db.execute('UPDATE accounts SET gateway_id=?,gateway_key=? WHERE forum_id=?',
                       (gateway_id, key, identity['id']))

    def summary(self, forum_id, policy, now=None, db=None):
        day, reset = calendar(now)
        if db is None:
            with self.connect() as connection:
                return self.summary(forum_id, policy, now, connection)
        row = db.execute('''SELECT count(*) AS requests,
                coalesce(sum(charged),0) AS used,
                coalesce(sum(CASE WHEN state='pending' THEN reserved ELSE 0 END),0) AS reserved
                FROM requests WHERE forum_id=? AND day=? AND state!='released' ''', (forum_id, day)).fetchone()
        return {'day': day, 'timezone': 'Asia/Singapore', 'resetsAt': reset,
                    'requestLimit': policy['daily_requests'], 'tokenLimit': policy['daily_tokens'],
                    'requestsUsed': row['requests'], 'tokensUsed': row['used'], 'tokensReserved': row['reserved'],
                    'requestsRemaining': max(0, policy['daily_requests'] - row['requests']),
                    'tokensRemaining': max(0, policy['daily_tokens'] - row['used'] - row['reserved'])}

    def reserve(self, forum_id, model, input_bound, output, policy, now=None):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not active_models(policy, now):
                reject(503, 'trial_unavailable', '本轮公益试用已结束或暂未开放，请等待管理员续期。')
            summary = self.summary(forum_id, policy, now, db)
            if summary['requestsRemaining'] <= 0:
                reject(429, 'daily_requests_exhausted', '今日公益请求次数已用完，零点后恢复。')
            active = db.execute("SELECT count(*) FROM requests WHERE forum_id=? AND state='pending'", (forum_id,)).fetchone()[0]
            if active >= policy['max_concurrent_per_account']:
                reject(429, 'account_busy', '同一账号正在处理其他请求，请稍后重试。')
            global_concurrent = policy.get('max_concurrent_global')
            if global_concurrent is not None:
                running = db.execute("SELECT count(*) FROM requests WHERE state='pending'").fetchone()[0]
                if running >= global_concurrent:
                    reject(429, 'service_busy', '公益模型正在处理其他请求，请稍后重试。', 2)
            timestamp = (now or datetime.now(timezone.utc)).timestamp()
            rpm = policy.get('global_requests_per_minute')
            if rpm is not None:
                recent = db.execute('SELECT count(*),min(created_at) FROM requests WHERE created_at>?',
                                    (timestamp - 60,)).fetchone()
                if recent[0] >= rpm:
                    # Attempts reaching the upstream count here even if later refunded.
                    retry = max(1, int(recent[1] + 60 - timestamp) + 1)
                    reject(429, 'service_rate_limited', '公益模型本分钟请求较多，请稍后重试。', retry)
            pool = db.execute('''SELECT count(*) AS requests,coalesce(sum(charged),0) AS used,
                coalesce(sum(CASE WHEN state='pending' THEN reserved ELSE 0 END),0) AS reserved
                FROM requests WHERE day=? AND state!='released' ''', (summary['day'],)).fetchone()
            global_requests = policy.get('global_daily_requests')
            if global_requests is not None and pool['requests'] >= global_requests:
                reject(429, 'service_daily_requests_exhausted', '今日公益请求总额度已用完，零点后恢复。')
            output = min(output, summary['tokensRemaining'] - input_bound)
            if output < 1:
                reject(429, 'daily_tokens_exhausted', '今日剩余 token 不足以处理当前上下文，请缩短内容或明日再试。')
            global_tokens = policy.get('global_daily_tokens')
            if global_tokens is not None:
                output = min(output, global_tokens - pool['used'] - pool['reserved'] - input_bound)
                if output < 1:
                    reject(429, 'service_daily_tokens_exhausted', '今日公益 token 总额度已用完，零点后恢复。')
            request_id = uuid.uuid4().hex
            db.execute('INSERT INTO requests(id,forum_id,day,reserved,state,model,created_at) VALUES(?,?,?,?,?,?,?)',
                       (request_id, forum_id, summary['day'], input_bound + output, 'pending', model, timestamp))
        return request_id, output

    def finish(self, request_id, usage=None, release=False):
        with self.connect() as db:
            row = db.execute('SELECT reserved,state FROM requests WHERE id=?', (request_id,)).fetchone()
            if row is None or row['state'] != 'pending':
                return
            charged = 0 if release else usage if usage is not None else row['reserved']
            db.execute('UPDATE requests SET charged=?,state=? WHERE id=?',
                       (charged, 'released' if release else 'charged' if usage is not None else 'uncertain', request_id))


def parse_identity(value, expected_id, policy):
    user = value.get('data', {})
    attrs = user.get('attributes', {})
    # Invalid Flarum tokens can still receive public profile JSON with HTTP 200.
    # These three fields are emitted only by CurrentUserSerializer for self.
    if (user.get('type') != 'users' or str(user.get('id')) != expected_id
            or not isinstance(attrs.get('isEmailConfirmed'), bool)
            or not isinstance(attrs.get('email'), str) or not isinstance(attrs.get('isAdmin'), bool)):
        reject(401, 'login_expired', 'LoliCode 登录已失效，请重新登录。')
    if 'suspendedUntil' not in attrs:
        reject(503, 'identity_unavailable', '暂时无法确认账号状态，请稍后重试。')
    suspended = attrs['suspendedUntil']
    if suspended is not None:
        try:
            until = datetime.fromisoformat(suspended.replace('Z', '+00:00'))
            if until.tzinfo is None:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            reject(503, 'identity_unavailable', '暂时无法确认账号状态，请稍后重试。')
        if until > datetime.now(timezone.utc):
            reject(403, 'forum_suspended', '此 LoliCode 账号已被封禁，暂时无法使用公益模型。')
    if policy.get('require_confirmed_email', True) and not attrs['isEmailConfirmed']:
        reject(403, 'email_unconfirmed', '请先在 LoliCode 社区完成邮箱验证。')
    name = attrs.get('username')
    display = attrs.get('displayName') or attrs.get('nickname') or name
    if not isinstance(name, str) or not isinstance(display, str) or not name or len(name) > 512 or len(display) > 512:
        reject(503, 'identity_unavailable', '账户资料暂时无法读取。')
    return {'id': expected_id, 'username': name, 'displayName': display}


class Gateway:
    """Internal New API identities. Passwords/keys never leave the server."""
    def __init__(self, session, ledger, credentials, base):
        self.session, self.ledger, self.credentials, self.base = session, ledger, credentials, base
        self.token = None
        self.lock = asyncio.Lock()
        self.names = {}

    async def call(self, method, path, data=None, token=None):
        async with self.session.request(method, self.base + path, json=data,
                headers={'Authorization': 'Bearer ' + token} if token else {},
                allow_redirects=False, timeout=aiohttp.ClientTimeout(total=15)) as response:
            raw = await read_limited(response, 1048576)
            if response.status in (401, 403) and token:
                reject(503, 'gateway_auth_expired', '公益模型服务暂时不可用。')
            if response.status != 200 or len(raw) > 1048576:
                reject(503, 'gateway_unavailable', '公益模型服务暂时不可用。')
            value = json.loads(raw)
            if value.get('success') is not True:
                reject(503, 'gateway_unavailable', '公益模型服务暂时不可用。')
            return value.get('data')

    async def admin(self, method, path, data=None):
        if self.credentials.get('access_token'):
            # A scoped machine token must fail closed, never fall back to a
            # password login with the service account's broader role.
            return await self.call(method, path, data, self.credentials['access_token'])
        if self.token is None:
            self.token = (await self.call('POST', '/api/user/login', self.credentials))['access_token']
        try:
            return await self.call(method, path, data, self.token)
        except Rejected as error:
            if error.code != 'gateway_auth_expired':
                raise
            self.token = (await self.call('POST', '/api/user/login', self.credentials))['access_token']
            return await self.call(method, path, data, self.token)

    async def material(self, identity):
        async with self.lock:
            row = self.ledger.account(identity)
            username = 'lc_' + identity['id']
            display = identity['displayName'][:20]
            if row['gateway_id'] is None or row['gateway_key'] is None:
                results = await self.admin('GET', '/api/user/search?keyword=' + username)
                matches = [u for u in results['items'] if u['username'] == username]
                if not matches:
                    await self.admin('POST', '/api/user/', {'username': username,
                        'password': row['gateway_password'], 'display_name': display, 'role': 1})
                login = await self.call('POST', '/api/user/login',
                                        {'username': username, 'password': row['gateway_password']})
                gateway_id, token = login['user']['id'], login['access_token']
                user = await self.admin('GET', '/api/user/' + str(gateway_id))
                if user['role'] != 1 or user['username'] != username:
                    reject(503, 'mapping_conflict', '账号映射需要管理员检查。')
                self.ledger.material(identity, gateway_id, None)
                # The bridge owns the strict daily limits; this local balance is
                # a separate New API billing ceiling, never sent to the client.
                metadata = {field: user.get(field, '') for field in ('id', 'username', 'group', 'remark')}
                await self.admin('PUT', '/api/user/', {**metadata, 'display_name': display})
                await self.admin('POST', '/api/user/manage', {'id': gateway_id, 'action': 'add_quota',
                                                           'mode': 'override', 'value': 50000000})
                tokens = await self.call('GET', '/api/token/?page_size=100', token=token)
                matches = [t for t in tokens['items'] if t['name'] == 'lolicode-bridge-internal']
                if not matches:
                    await self.call('POST', '/api/token/', {'name': 'lolicode-bridge-internal',
                        'expired_time': -1, 'unlimited_quota': True, 'model_limits_enabled': False}, token)
                    tokens = await self.call('GET', '/api/token/?page_size=100', token=token)
                    matches = [t for t in tokens['items'] if t['name'] == 'lolicode-bridge-internal']
                if len(matches) != 1:
                    reject(503, 'mapping_conflict', '账号映射需要管理员检查。')
                key = (await self.call('POST', '/api/token/' + str(matches[0]['id']) + '/key', {}, token))['key']
                self.ledger.material(identity, gateway_id, key)
                row = self.ledger.account(identity)
                self.names[identity['id']] = display
            elif self.names.get(identity['id']) != display:
                user = await self.admin('GET', '/api/user/' + str(row['gateway_id']))
                if user['role'] != 1 or user['username'] != username:
                    reject(503, 'mapping_conflict', '账号映射需要管理员检查。')
                if user['display_name'] != display:
                    metadata = {field: user.get(field, '') for field in ('id', 'username', 'group', 'remark')}
                    await self.admin('PUT', '/api/user/', {**metadata, 'display_name': display})
                self.names[identity['id']] = display
            return row['gateway_key']


def usage_tokens(value):
    usage = value.get('usage') if isinstance(value, dict) else None
    if not isinstance(usage, dict):
        return None
    total = usage.get('total_tokens')
    prompt, completion = usage.get('prompt_tokens'), usage.get('completion_tokens')
    valid = lambda n: type(n) is int and 0 <= n <= 10000000
    if valid(prompt) and valid(completion):
        return max(prompt + completion, total if valid(total) else 0)
    return total if valid(total) else None


def prepare_payload(value, policy):
    if not isinstance(value, dict):
        reject(400, 'invalid_request', '请求必须是 JSON 对象。')
    models = {model['id']: model for model in active_models(policy)}
    if not models:
        reject(503, 'trial_unavailable', '本轮公益试用已结束或暂未开放，请等待管理员续期。')
    if not isinstance(value.get('model'), str) or value['model'] not in models:
        reject(403, 'model_not_allowed', '此模型尚未开放公益使用。')
    messages = value.get('messages')
    if not isinstance(messages, list) or not 1 <= len(messages) <= 512:
        reject(400, 'invalid_request', '消息列表无效或过长。')
    for message in messages:
        if not isinstance(message, dict) or message.get('role') not in ('system', 'developer', 'user', 'assistant', 'tool'):
            reject(400, 'invalid_request', '消息格式无效。')
        content = message.get('content')
        if content is not None and not isinstance(content, str):
            if not isinstance(content, list) or any(not isinstance(p, dict) or p.get('type') != 'text'
                    or not isinstance(p.get('text'), str) for p in content):
                reject(400, 'text_only', '公益模型目前支持文字和工具调用。')
    allowed = {'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature',
               'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'response_format', 'seed',
               'prompt_cache_key', 'prompt_cache_retention'}
    cache_key = value.get('prompt_cache_key')
    if cache_key is not None and (not isinstance(cache_key, str) or not cache_key
                                  or len(cache_key.encode('utf-8')) > 512):
        reject(400, 'invalid_cache_settings', '缓存路由标识必须是有效的短字符串。')
    retention = value.get('prompt_cache_retention')
    if retention is not None and retention not in ('in_memory', '24h'):
        reject(400, 'invalid_cache_settings', '缓存保留选项无效，请按模型支持情况设置。')
    if value.get('prompt_cache_options') is not None:
        # This pinned New API version models the newer options only on Responses.
        # Failing explicitly is safer than silently pretending the option worked.
        reject(400, 'unsupported_cache_options', '当前公益入口尚未支持此模型的新缓存选项。')
    payload = {key: value[key] for key in allowed if key in value}
    message_keys = {'role', 'content', 'name', 'tool_calls', 'tool_call_id'}
    payload['messages'] = [{key: item for key, item in message.items() if key in message_keys} for message in messages]
    if 'tools' in payload and (not isinstance(payload['tools'], list) or any(
            not isinstance(tool, dict) or tool.get('type') != 'function' or not isinstance(tool.get('function'), dict)
            for tool in payload['tools'])):
        reject(400, 'invalid_tools', '公益模型仅支持客户端执行的函数工具。')
    if 'n' in value and value['n'] != 1:
        reject(400, 'invalid_request', '每次请求仅支持一个结果。')
    if 'stream' in value and type(value['stream']) is not bool:
        reject(400, 'invalid_request', 'stream 参数无效。')
    payload['stream'] = value.get('stream', False)
    if payload['stream']:
        payload['stream_options'] = {'include_usage': True}
    output = value.get('max_completion_tokens', value.get('max_tokens', policy['max_output_tokens']))
    if type(output) is not int or output < 1:
        reject(400, 'invalid_request', '输出 token 上限必须为正整数。')
    model = models[value['model']]
    output = min(output, policy['max_output_tokens'], model.get('outputLimit', policy['max_output_tokens']))
    # Text/tool requests only. Count every UTF-8 JSON byte plus a fixed framing
    # allowance as a conservative input reservation; settle using upstream usage.
    bound = len(json.dumps(payload, ensure_ascii=False).encode()) + 4096 + 32 * len(messages)
    if bound + output > model.get('contextLimit', 32768):
        reject(400, 'context_too_long', '当前上下文超过公益模型限制，请缩短对话。')
    return payload, bound, output


@web.middleware
async def errors(request, handler):
    try:
        response = await handler(request)
    except Rejected as exc:
        response = web.json_response({'error': {'code': exc.code, 'message': exc.message}}, status=exc.status)
        if exc.status == 429:
            reset = datetime.fromisoformat(calendar()[1])
            response.headers['Retry-After'] = (str(exc.retry_after) if exc.retry_after is not None else
                '2' if exc.code in ('account_busy', 'service_busy') else
                str(max(1, int((reset - datetime.now(timezone.utc)).total_seconds()))))
    except web.HTTPException as exc:
        response = web.json_response({'error': {'code': 'invalid_request', 'message': '请求路径或内容无效。'}}, status=exc.status)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError, sqlite3.Error):
        response = web.json_response({'error': {'code': 'service_unavailable', 'message': '公益服务暂时不可用，请稍后重试。'}}, status=503)
    response.headers['Cache-Control'] = 'no-store'
    return response


def create_app(policy, database, *, forum='https://lolicode.com', gateway='http://127.0.0.1:13000',
               credentials=None, material_factory=None):
    ledger = Ledger(database)
    ledger.recover()
    app = web.Application(client_max_size=policy['max_request_bytes'], middlewares=[errors])
    app['ledger'], app['policy'] = ledger, policy

    async def startup(app):
        app['http'] = aiohttp.ClientSession(trust_env=False, auto_decompress=True,
                cookie_jar=aiohttp.DummyCookieJar(),
                headers={'Accept-Encoding': 'identity'},
                timeout=aiohttp.ClientTimeout(total=320, connect=8, sock_read=300))
        app['gateway'] = (material_factory(app['http'], ledger) if material_factory else
                          Gateway(app['http'], ledger, credentials, gateway))

    async def cleanup(app):
        await app['http'].close()

    async def authenticate(authorization):
        match = AUTH.fullmatch(authorization)
        if match is None:
            reject(401, 'login_required', '请先登录原有 LoliCode 账号。')
        user_id, token = match.groups()
        async with app['http'].get(forum + '/api/users/' + user_id,
                headers={'Authorization': 'Token ' + token, 'Accept': 'application/json'},
                allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10)) as response:
            raw = await read_limited(response, 131072)
            if response.status in (401, 403, 404):
                reject(401, 'login_expired', 'LoliCode 登录已失效，请重新登录。')
            if response.status != 200 or len(raw) > 131072:
                reject(503, 'identity_unavailable', '暂时无法验证 LoliCode 账号，请稍后重试。')
            value = parse_identity(json.loads(raw), user_id, policy)
        ledger.account(value)
        return value

    async def identity(request):
        return await authenticate(request.headers.get('Authorization', ''))

    async def account_status(user):
        await app['gateway'].material(user)
        return {'account': user, 'quota': ledger.summary(user['id'], policy),
                                  'models': active_models(policy), 'ready': bool(active_models(policy)),
                                  'limits': public_limits(policy), 'trialEndsAt': policy.get('available_until')}

    async def account(request):
        return web.json_response(await account_status(await identity(request)))

    async def models(request):
        user = await identity(request)
        await app['gateway'].material(user)
        return web.json_response({'object': 'list', 'data': [
            {'id': model['id'], 'object': 'model', 'owned_by': 'lolicode', **model} for model in active_models(policy)]})

    async def chat(request):
        user = await identity(request)
        try:
            value = await request.json()
        except (ValueError, UnicodeError):
            reject(400, 'invalid_request', '请求必须为有效 JSON。')
        payload, input_bound, output = prepare_payload(value, policy)
        key = await app['gateway'].material(user)
        request_id, output = ledger.reserve(user['id'], payload['model'], input_bound, output, policy)
        payload['max_tokens'] = output
        sent, usage, release = False, None, False
        try:
            sent = True
            async with app['http'].post(gateway + '/v1/chat/completions', json=payload,
                    headers={'Authorization': 'Bearer ' + key, 'Accept-Encoding': 'identity'},
                    allow_redirects=False) as upstream:
                if upstream.status != 200:
                    release = True
                    reject(503, 'upstream_unavailable', '模型暂时不可用，本次未扣除每日额度。')
                if payload['stream']:
                    if 'text/event-stream' not in upstream.headers.get('Content-Type', ''):
                        reject(502, 'invalid_stream', '模型返回了无效的流式响应。')
                    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream',
                                                           'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})
                    await response.prepare(request)
                    pending = b''
                    output_buffer = b''
                    secret = key.encode()
                    async for chunk in upstream.content.iter_chunked(16384):
                        pending += chunk
                        if len(pending) > 1048576:
                            raise ValueError('Oversize SSE event')
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
                                parsed = json.loads(line[6:])
                                count = usage_tokens(parsed)
                                if count is not None:
                                    usage = count
                        output_buffer = (output_buffer + chunk).replace(secret, b'[redacted]')
                        keep = max(0, len(secret) - 1)
                        if len(output_buffer) > keep:
                            await response.write(output_buffer[:-keep] if keep else output_buffer)
                            output_buffer = output_buffer[-keep:] if keep else b''
                    if output_buffer:
                        await response.write(output_buffer.replace(secret, b'[redacted]'))
                    await response.write_eof()
                    return response
                raw = await read_limited(upstream, 4 * 1024**2)
                if len(raw) > 4 * 1024**2:
                    raise ValueError('Oversize response')
                result = json.loads(raw.replace(key.encode(), b'[redacted]'))
                usage = usage_tokens(result)
                return web.json_response(result)
        finally:
            # Includes cancellation/disconnection, missing usage and exceptions.
            ledger.finish(request_id, usage, release=release or not sent)

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    app.router.add_get('/health', lambda request: web.json_response({'ok': True}))
    app.router.add_get('/public/status', lambda request: web.json_response({
        'ready': bool(active_models(policy)), 'modelCount': len(active_models(policy)),
        'dailyRequests': policy['daily_requests'], 'dailyTokens': policy['daily_tokens'],
        'timezone': 'Asia/Singapore', 'resetsAt': calendar()[1],
        'limits': public_limits(policy), 'trialEndsAt': policy.get('available_until')}))
    app.router.add_get('/account', account)
    app.router.add_get('/v1/models', models)
    app.router.add_post('/v1/chat/completions', chat)
    from web_account import install_web_account
    install_web_account(app, authenticate, account_status, forum,
                        reject=reject, read_limited=read_limited, rejection_type=Rejected)
    return app


if __name__ == '__main__':
    import fcntl
    os.umask(0o077)
    state = ROOT / 'bridge-state'
    state.mkdir(mode=0o700, exist_ok=True)
    instance_lock = (state / '.bridge.lock').open('a')
    fcntl.flock(instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    policy = json.loads((ROOT / 'bridge-policy.json').read_text())
    credentials = json.loads((ROOT / 'bridge-service-credentials.json').read_text())
    web.run_app(create_app(policy, state / 'bridge.sqlite3', credentials=credentials),
                host='127.0.0.1', port=13001, access_log=None, print=None)
