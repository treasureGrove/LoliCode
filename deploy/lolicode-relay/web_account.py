"""Browser sessions validate the existing forum account; never accept them for inference."""
import hashlib
import json
import re
import secrets
import time

import aiohttp
from aiohttp import web

ORIGIN = 'https://relay.lolicode.com'
COOKIE = '__Host-lolicode_relay'
TTL = 55 * 60  # Shorter than Flarum's one-hour session token.
SESSION = re.compile(r'[A-Za-z0-9_-]{43}\Z')


class WebSessions:
    def __init__(self, ledger):
        self.ledger = ledger
        with ledger.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS web_sessions (
                digest TEXT PRIMARY KEY, forum_id TEXT NOT NULL,
                forum_token TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS web_session_expiry ON web_sessions(expires_at)')

    def create(self, user_id, token):
        session = secrets.token_urlsafe(32)
        now = time.time()
        with self.ledger.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM web_sessions WHERE expires_at<=?', (now,))
            db.execute('''DELETE FROM web_sessions WHERE forum_id=? AND digest NOT IN
                (SELECT digest FROM web_sessions WHERE forum_id=? ORDER BY created_at DESC LIMIT 4)''',
                (user_id, user_id))
            db.execute('INSERT INTO web_sessions VALUES(?,?,?,?,?)',
                (hashlib.sha256(session.encode()).hexdigest(), user_id, token, now, now + TTL))
        return session

    def get(self, session):
        if not SESSION.fullmatch(session):
            return None
        with self.ledger.connect() as db:
            row = db.execute('SELECT forum_id,forum_token FROM web_sessions WHERE digest=? AND expires_at>?',
                (hashlib.sha256(session.encode()).hexdigest(), time.time())).fetchone()
        return dict(row) if row else None

    def delete(self, session):
        if SESSION.fullmatch(session):
            with self.ledger.connect() as db:
                db.execute('DELETE FROM web_sessions WHERE digest=?',
                    (hashlib.sha256(session.encode()).hexdigest(),))


def install_web_account(app, authenticate, account_status, forum, *, reject, read_limited, rejection_type):
    sessions = WebSessions(app['ledger'])
    app['web_sessions'] = sessions

    def same_origin(request, mutation=False):
        origin = request.headers.get('Origin')
        if ((mutation and origin != ORIGIN) or (origin is not None and origin != ORIGIN)
                or request.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site')):
            reject(403, 'origin_rejected', '请在中转站页面中操作。')
        if mutation and request.content_type != 'application/json':
            reject(415, 'json_required', '请使用网页表单登录。')

    async def login(request):
        same_origin(request, mutation=True)
        if request.content_length is not None and request.content_length > 8192:
            reject(400, 'invalid_login', '账号或密码长度超出限制。')
        raw = await read_limited(request, 8192)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            reject(400, 'invalid_login', '请输入账号和密码。')
        if not isinstance(value, dict):
            reject(400, 'invalid_login', '请输入账号和密码。')
        name, password = value.get('identification'), value.get('password')
        if (not isinstance(name, str) or not name.strip() or len(name) > 512
                or not isinstance(password, str) or not password or len(password.encode()) > 4096):
            reject(400, 'invalid_login', '请输入有效的账号和密码。')
        # Password is forwarded once over HTTPS, never persisted or logged.
        async with app['http'].post(forum + '/api/token',
                json={'identification': name.strip(), 'password': password, 'remember': False},
                headers={'Accept': 'application/json'}, allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=15)) as upstream:
            raw = await read_limited(upstream, 16384)
            if upstream.status in (400, 401, 403, 422):
                reject(401, 'invalid_credentials', 'LoliCode 用户名、邮箱或密码不正确。请使用社区账号，不是本机配置名称。')
            if upstream.status == 429:
                reject(429, 'login_rate_limited', '登录尝试过于频繁，请稍后重试。', 60)
            if upstream.status != 200:
                reject(503, 'identity_unavailable', '暂时无法连接 LoliCode 账号服务。')
            credential = json.loads(raw)
        if not isinstance(credential, dict):
            reject(503, 'identity_unavailable', '账号服务返回无效，请稍后重试。')
        user_id, token = str(credential.get('userId', '')), credential.get('token', '')
        if (not re.fullmatch(r'[1-9][0-9]{0,16}', user_id) or not isinstance(token, str)
                or not re.fullmatch(r'[A-Za-z0-9]{40}', token)):
            reject(503, 'identity_unavailable', '账号服务返回无效，请稍后重试。')
        user = await authenticate('Bearer lc1.' + user_id + '.' + token)
        status = await account_status(user)
        session = sessions.create(user_id, token)
        sessions.delete(request.cookies.get(COOKIE, ''))
        response = web.json_response(status)
        response.set_cookie(COOKIE, session, max_age=TTL, secure=True, httponly=True,
                            samesite='Lax', path='/')
        return response

    async def account(request):
        same_origin(request)
        session = request.cookies.get(COOKIE, '')
        credential = sessions.get(session)
        if credential is None:
            reject(401, 'login_required', '请登录原有 LoliCode 账号。')
        try:
            user = await authenticate('Bearer lc1.' + credential['forum_id'] + '.' + credential['forum_token'])
            return web.json_response(await account_status(user))
        except rejection_type as exc:
            if exc.status in (401, 403):
                sessions.delete(session)
            raise

    async def logout(request):
        same_origin(request, mutation=True)
        sessions.delete(request.cookies.get(COOKIE, ''))
        response = web.json_response({'ok': True})
        response.set_cookie(COOKIE, '', max_age=0, expires='Thu, 01 Jan 1970 00:00:00 GMT',
                            path='/', secure=True, httponly=True, samesite='Lax')
        return response

    app.router.add_post('/web/login', login)
    app.router.add_get('/web/account', account)
    app.router.add_post('/web/logout', logout)
