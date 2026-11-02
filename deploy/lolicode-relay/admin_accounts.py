"""Root-only, same-origin management of existing forum accounts' allowances."""
import json
import re

from aiohttp import web

MAX_BODY = 8192
MAX_PAGE_SIZE = 100
ACCOUNT_ID = re.compile(r'[1-9][0-9]{0,16}\Z')


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate_account_setting')
        value[key] = item
    return value


def install_admin_accounts(app, policy, *, authenticate, origin, reject):
    ledger = app['ledger']

    def same_origin(request, *, mutation=False):
        supplied = request.headers.get('Origin')
        if ((mutation and supplied != origin) or (supplied is not None and supplied != origin)
                or request.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site')):
            reject(403, 'invalid_admin_origin', '请在中转站管理员页面操作。')
        if mutation and request.content_type != 'application/json':
            reject(415, 'json_required', '请使用 JSON 保存账户设置。')

    async def get_accounts(request):
        same_origin(request)
        await authenticate(request, minimum_role=100)
        try:
            if (set(request.query) - {'page', 'pageSize', 'q'}
                    or any(len(request.query.getall(key)) != 1 for key in request.query)):
                raise ValueError('invalid_pagination')
            def number(key, default, maximum):
                raw = request.query.get(key, str(default))
                if not re.fullmatch(r'[1-9][0-9]{0,6}', raw) or int(raw) > maximum:
                    raise ValueError('invalid_pagination')
                return int(raw)
            page = number('page', 1, 1000000)
            page_size = number('pageSize', 50, MAX_PAGE_SIZE)
            query = request.query.get('q', '').strip()
            if len(query) > 256 or any(ord(character) < 32 or ord(character) == 127 for character in query):
                raise ValueError('invalid_query')
        except ValueError:
            reject(400, 'invalid_account_query', '请检查页码、每页数量和搜索词。')
        return web.json_response(ledger.admin_accounts(policy, page=page, page_size=page_size, query=query))

    async def put_account(request):
        same_origin(request, mutation=True)
        await authenticate(request, minimum_role=100)
        forum_id = request.match_info['forum_id']
        if not ACCOUNT_ID.fullmatch(forum_id):
            reject(400, 'invalid_account_id', '账户 ID 无效。')
        raw = bytearray()
        async for chunk in request.content.iter_chunked(4096):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                reject(413, 'account_settings_too_large', '账户设置内容过大。')
        try:
            value = json.loads(raw, object_pairs_hook=_unique_object)
            if not isinstance(value, dict) or set(value) != {'revision', 'dailyCreditsOverride', 'disabled'}:
                raise ValueError('invalid_account_controls')
            account = ledger.update_account_controls(forum_id, value['revision'], value['dailyCreditsOverride'],
                                                     value['disabled'], policy)
        except (ValueError, TypeError):
            reject(400, 'invalid_account_settings', '请填写有效额度、版本和启用状态；留空额度可恢复默认。')
        return web.json_response({'account': account})

    app.router.add_get('/admin/accounts', get_accounts)
    app.router.add_put('/admin/accounts/{forum_id}', put_account)
