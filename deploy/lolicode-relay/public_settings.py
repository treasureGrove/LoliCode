"""Existing New API administrators manage the public bridge's safe settings."""
import asyncio
import hashlib
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import ipaddress
import re
import socket
import tempfile
from time import monotonic
from urllib.parse import urlsplit, urlunsplit, urlencode, urljoin
import uuid

import aiohttp
from aiohttp import web

ORIGIN = 'https://relay.lolicode.com'
MAX_BODY = 65536
MAX_MODELS = 128
FIELDS = {
    'dailyRequests': ('daily_requests', 1, 1000000, False),
    'dailyTokens': ('daily_tokens', 1, 1000000000, False),
    'globalDailyRequests': ('global_daily_requests', 1, 10000000, True),
    'globalDailyTokens': ('global_daily_tokens', 1, 100000000000, True),
    'maxConcurrentPerAccount': ('max_concurrent_per_account', 1, 100, False),
    'maxConcurrentGlobal': ('max_concurrent_global', 1, 1000, True),
    'globalRequestsPerMinute': ('global_requests_per_minute', 1, 100000, True),
    'maxOutputTokens': ('max_output_tokens', 1, 128000, False),
    'maxRequestBytes': ('max_request_bytes', 8192, 3 * 1024**2, False),
}
SETTING_KEYS = set(FIELDS) | {'revision', 'enabled', 'availabilityMode', 'availableUntil', 'modelIds'}
MODEL_FIELDS = {'id', 'name', 'contextLimit', 'contextLimits', 'outputLimit', 'supportsTools', 'inputModalities', 'protocol'}
CONTEXT_SCALARS = ('context_window', 'contextWindow', 'context_limit', 'contextLimit',
                   'context_length', 'contextLength', 'context/length', 'max_context_tokens',
                   'maxContextTokens', 'maxContextLength', 'maxContextWindowTokens',
                   'max_model_len', 'max_model_length', 'max_sequence_length', 'max_seq_len',
                   'max_position_embeddings', 'inputTokenLimit', 'maxInputTokens', 'max_input_tokens',
                   'input_token_limit', 'max_prompt_tokens', 'limits/context_length',
                   'limits/context_window', 'limits/max_context_tokens', 'limits/max_input_tokens',
                   'capabilities/limits/max_prompt_tokens', 'capabilities/limits/max_context_tokens',
                   'capabilities/limits/max_context_window_tokens', 'limit/context')
CONTEXT_ARRAYS = ('context_windows', 'contextWindows', 'context_limits', 'contextLimits',
                  'supported_context_windows', 'supported_context_lengths', 'supported_context_limits',
                  'limits/context_windows', 'capabilities/limits/context_windows',
                  'parameters/context_window/enum', 'parameters/context_length/enum')
UPSTREAM_NAME = 'LoliCode 公益 API'
UPSTREAM_MARKER = 'lolicode-public-settings-v1'
PROTOCOLS = {'openai_chat', 'openai_responses', 'anthropic', 'gemini_native'}
MAX_DISCOVERED_MODELS = 2048


def deadline(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError('invalid_deadline')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('invalid_deadline')
    return result


def valid_model_id(value):
    return (isinstance(value, str) and 0 < len(value) <= 256 and value == value.strip()
            and ',' not in value
            and all(not character.isspace() and ord(character) >= 32 and ord(character) != 127
                    for character in value))


def validate_settings(value, *, loading=False):
    if not isinstance(value, dict) or set(value) != SETTING_KEYS:
        raise ValueError('invalid_fields')
    if type(value['revision']) is not int or not 0 <= value['revision'] <= 2**53 - 2:
        raise ValueError('invalid_revision')
    if type(value['enabled']) is not bool:
        raise ValueError('invalid_enabled')
    ids = value['modelIds']
    if (not isinstance(ids, list) or len(ids) > MAX_MODELS
            or any(not valid_model_id(model) for model in ids) or len(set(ids)) != len(ids)
            or (value['enabled'] and not ids)):
        raise ValueError('invalid_models')
    if value['availabilityMode'] == 'permanent':
        if value['availableUntil'] is not None:
            raise ValueError('invalid_deadline')
    elif value['availabilityMode'] == 'until':
        end = deadline(value['availableUntil'])
        if not loading and value['enabled'] and end <= datetime.now(timezone.utc):
            raise ValueError('deadline_expired')
    else:
        raise ValueError('invalid_availability')
    for field, (_, low, high, nullable) in FIELDS.items():
        entry = value[field]
        if nullable and entry is None:
            continue
        if type(entry) is not int or not low <= entry <= high:
            raise ValueError('invalid_limit')
    return deepcopy(value)


def initial_settings(policy):
    end = policy.get('available_until')
    return {'revision': 0, 'enabled': bool(policy['models']),
            'availabilityMode': 'until' if end is not None else 'permanent',
            'availableUntil': end, 'modelIds': [model['id'] for model in policy['models']],
            **{field: policy.get(key) for field, (key, *_rest) in FIELDS.items()}}


def safe_model(model):
    return {key: deepcopy(value) for key, value in model.items() if key in MODEL_FIELDS}


def catalog_model_metadata(entry):
    """Only explicit upstream window choices; absent context defaults at publication."""
    def at(path):
        for source in (entry, entry.get('model_info'), entry.get('metadata')):
            value = source
            for part in path.split('/'):
                if not isinstance(value, dict):
                    value = None
                    break
                value = value.get(part)
            if value is not None:
                return value
        return None

    def tokens(value):
        if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 16:
            value = int(value)
        return value if type(value) is int and 0 < value <= 2**53 - 1 else None

    def scalar(value):
        return tokens(value) or (tokens(value.get('default')) if isinstance(value, dict) else None)

    default = next((limit for path in CONTEXT_SCALARS if (limit := scalar(at(path)))), None)
    windows = set()
    for path in CONTEXT_SCALARS + CONTEXT_ARRAYS:
        value = at(path)
        if isinstance(value, dict):
            value = value.get('enum', value.get('options'))
        if isinstance(value, list):
            for item in value:
                limit = tokens(item)
                if isinstance(item, dict):
                    limit = next((number for key in ('value', 'tokens', 'contextLimit', 'context_window', 'context_length')
                                  if (number := tokens(item.get(key)))), None)
                if limit:
                    windows.add(limit)
            if len(windows) > 64:
                raise ValueError('too_many_context_windows')
    # Copilot publishes prompt-budget choices as billing tiers.
    prices = at('billing/token_prices')
    if isinstance(prices, dict) and isinstance(prices.get('default'), dict):
        def tier(name):
            value = prices.get(name)
            if not isinstance(value, dict):
                return None
            limit = tokens(value.get('max_prompt_tokens')) or tokens(value.get('context_max'))
            return min(limit, default) if limit and default else limit
        standard = tier('default')
        if standard:
            long = tier('long_context') or default
            default, windows = standard, {standard, *([long] if long and long > standard else [])}
    elif windows:
        explicit = next((limit for path in CONTEXT_SCALARS[:7] if (limit := scalar(at(path)))), None)
        if explicit:
            windows.add(explicit)
        default = default if default in windows else min(windows)
    metadata = {}
    if default:
        metadata['contextLimit'] = default
    if windows:
        metadata['contextLimits'] = sorted(windows)
    output = next((limit for path in ('outputLimit', 'max_output_tokens', 'maxOutputTokens',
                                      'outputTokenLimit', 'limits/max_output_tokens', 'limit/output')
                   if (limit := tokens(at(path)))), None)
    if output:
        metadata['outputLimit'] = output
    return metadata


def channel_metadata(channel):
    remark = channel.get('remark')
    if remark == UPSTREAM_MARKER:
        return {}
    if isinstance(remark, str) and remark.startswith(UPSTREAM_MARKER + '\n'):
        try:
            value = json.loads(remark.split('\n', 1)[1])
            if (isinstance(value, dict) and set(value) <= {'name', 'protocol', 'presetId', 'modelMetadata'}
                    and all(isinstance(item, str) and len(item) <= 256 for key, item in value.items() if key != 'modelMetadata')
                    and isinstance(value.get('modelMetadata', {}), dict)
                    and len(value.get('modelMetadata', {})) <= MAX_MODELS
                    and all(valid_model_id(key) and isinstance(model, dict)
                            and set(model) <= {'name', 'contextLimit', 'contextLimits', 'outputLimit'}
                            and ('name' not in model or (isinstance(model['name'], str) and len(model['name']) <= 256))
                            and catalog_model_metadata(model) == {key: item for key, item in model.items() if key != 'name'}
                            for key, model in value.get('modelMetadata', {}).items())
                    and value.get('protocol', 'openai_chat') in PROTOCOLS):
                return value
        except ValueError:
            pass
    return None


def channel_view(channel, model_ids):
    metadata = channel_metadata(channel)
    channel_type = channel['type']
    configured_base = channel.get('base_url') or {
        1: 'https://api.openai.com', 14: 'https://api.anthropic.com',
        24: 'https://generativelanguage.googleapis.com',
    }.get(channel_type, '')
    parsed_base = urlsplit(str(configured_base).rstrip('/'))
    authority = parsed_base.netloc.rsplit('@', 1)[-1]
    base = urlunsplit((parsed_base.scheme, authority, parsed_base.path, '', ''))
    if channel_type == 8:
        base = base.removesuffix('/chat/completions')
    elif channel_type == 14:
        base += '/v1'
    elif channel_type == 24:
        base += '/v1beta'
    elif channel_type == 1 and not re.search(r'/v[0-9]+(?:[a-z]+[0-9]*)?$', urlsplit(base).path):
        base += '/v1'
    name = (metadata or {}).get('name') or channel.get('name') or '渠道'
    name = ''.join(character for character in name if ord(character) >= 32)[:256]
    protocol = (metadata or {}).get('protocol') or {14: 'anthropic', 24: 'gemini_native'}.get(channel_type, 'openai_chat')
    return {'id': channel['id'], 'name': name, 'enabled': channel.get('status') == 1,
            'status': channel.get('status'), 'managed': metadata is not None,
            'baseUrl': base, 'protocol': protocol, 'presetId': (metadata or {}).get('presetId'),
            'models': [{'id': model, 'name': model,
                        **deepcopy((metadata or {}).get('modelMetadata', {}).get(model, {}))}
                       for model in dict.fromkeys(model_ids)]}


def upstream_url(value):
    if (not isinstance(value, str) or len(value) > 2048 or '\\' in value
            or any(ord(character) < 33 for character in value)):
        raise ValueError('invalid_url')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or parsed.port not in (None, 443)):
        raise ValueError('invalid_url')
    path = parsed.path.rstrip('/')
    if path.endswith('/chat/completions'):
        pass
    elif not path:
        path = '/v1/chat/completions'
    else:
        path += '/chat/completions'
    return urlunsplit(('https', parsed.netloc, path, '', '')), parsed.hostname


def check_public_host(hostname):
    addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError('private_upstream')


def model_catalog_url(value, protocol):
    if protocol not in PROTOCOLS:
        raise ValueError('invalid_protocol')
    # Reuse strict scheme, userinfo, query, fragment and port validation.
    upstream_url(value)
    parsed = urlsplit(value)
    path = parsed.path.rstrip('/')
    for suffix in ('/chat/completions', '/responses', '/messages', '/models'):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    if not re.search(r'/v[0-9]+(?:[a-z]+[0-9]*)?$', path):
        path += '/v1beta' if protocol == 'gemini_native' else '/v1'
    base = urlunsplit(('https', parsed.netloc, path, '', ''))
    return base, base + '/models'


def native_upstream(value, protocol):
    base, _ = model_catalog_url(value, protocol)
    parsed = urlsplit(base)
    if protocol in ('openai_chat', 'openai_responses'):
        return 8, base + '/chat/completions', 'openai_chat'
    version = parsed.path.rsplit('/', 1)[-1]
    if (protocol == 'anthropic' and version != 'v1') or (protocol == 'gemini_native' and version != 'v1beta'):
        raise ValueError('unsupported_upstream_version')
    prefix = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rsplit('/', 1)[0], '', ''))
    return (14 if protocol == 'anthropic' else 24), prefix, protocol


class PublicResolver(aiohttp.abc.AbstractResolver):
    """Validate the DNS results actually used by the discovery connection."""
    def __init__(self):
        self.resolver = aiohttp.resolver.DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        result = await self.resolver.resolve(host, port, family)
        if not result or any(not ipaddress.ip_address(item['host']).is_global for item in result):
            raise OSError('private_upstream')
        return result

    async def close(self):
        await self.resolver.close()


def catalog_session():
    return aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
        connector=aiohttp.TCPConnector(resolver=PublicResolver(), ttl_dns_cache=0),
        timeout=aiohttp.ClientTimeout(total=20, connect=8))


class CatalogError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


async def discover_model_catalog(base_url, api_key, protocol):
    base, first_url = model_catalog_url(base_url, protocol)
    if api_key in base:
        raise CatalogError('invalid_upstream', 'API 地址不能包含密钥，请只在 Key 输入框填写。')
    headers = {'Accept': 'application/json', 'User-Agent': 'LoliCodeRelayModels/1.0'}
    if protocol == 'anthropic':
        headers.update({'x-api-key': api_key, 'anthropic-version': '2023-06-01'})
    elif protocol == 'gemini_native':
        headers['x-goog-api-key'] = api_key
    else:
        headers['Authorization'] = 'Bearer ' + api_key
    result, seen_urls = {}, set()
    current_url = first_url
    async with catalog_session() as session:
        for _ in range(64):
            if current_url in seen_urls:
                raise CatalogError('catalog_pagination_invalid', '模型目录分页重复，请检查上游 API。')
            seen_urls.add(current_url)
            parsed = urlsplit(current_url)
            if (parsed.scheme != 'https' or parsed.netloc != urlsplit(first_url).netloc
                    or parsed.path != urlsplit(first_url).path or parsed.fragment
                    or parsed.username is not None or api_key in current_url):
                raise CatalogError('catalog_pagination_invalid', '上游返回了不安全的模型分页地址。')
            # Literal IP URLs do not pass through aiohttp's resolver.
            try:
                if not ipaddress.ip_address(parsed.hostname).is_global:
                    raise CatalogError('invalid_upstream', '模型 API 必须使用公网 HTTPS 地址。')
            except ValueError:
                pass
            async with session.get(current_url, headers=headers, allow_redirects=False) as response:
                if 300 <= response.status < 400:
                    raise CatalogError('catalog_redirect_rejected', '模型 API 返回跳转，请填写最终 HTTPS API 地址。')
                if response.status != 200:
                    raise CatalogError('catalog_upstream_rejected', '模型目录读取失败，请检查地址、Key 和目录权限。')
                header_next = str(response.links['next']['url']) if 'next' in response.links else None
                raw = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    raw.extend(chunk)
                    if len(raw) > 2097152:
                        raise CatalogError('catalog_too_large', '模型目录响应过大，请缩小上游目录范围。')
                value = json.loads(raw)
            entries = value.get('models') if protocol == 'gemini_native' else value.get('data')
            if not isinstance(entries, list):
                raise CatalogError('catalog_invalid', '上游没有返回有效的模型目录，可手动填写模型 ID。')
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if (protocol == 'gemini_native'
                        and isinstance(entry.get('supportedGenerationMethods'), list)
                        and 'generateContent' not in entry['supportedGenerationMethods']):
                    continue
                model_id = entry.get('name') if protocol == 'gemini_native' else entry.get('id')
                if protocol == 'gemini_native' and isinstance(model_id, str):
                    model_id = model_id.removeprefix('models/')
                if not valid_model_id(model_id) or api_key in model_id:
                    continue
                name = entry.get('displayName') or entry.get('display_name') or entry.get('name') or model_id
                name = name if isinstance(name, str) else model_id
                name = ''.join(character for character in name if ord(character) >= 32)[:256]
                name = name.replace(api_key, '[redacted]')
                try:
                    metadata = catalog_model_metadata(entry)
                except ValueError:
                    raise CatalogError('catalog_context_options_invalid', '上游上下文档位超过限制，未截断保存。')
                result.setdefault(model_id, {'id': model_id, 'name': name or model_id, **metadata})
                if len(result) > MAX_DISCOVERED_MODELS:
                    raise CatalogError('catalog_too_large', '模型目录超过 2048 个，未截断保存，请缩小上游目录范围。')
            token = value.get('nextPageToken') or value.get('next_page_token')
            if token:
                if not isinstance(token, str) or len(token) > 2048:
                    raise CatalogError('catalog_pagination_invalid', '上游模型分页标识无效。')
                parameter = 'pageToken' if protocol == 'gemini_native' else 'page_token'
                current_url = first_url + '?' + urlencode({parameter: token})
            elif value.get('has_more') is True:
                last = value.get('last_id')
                if not isinstance(last, str) or not last or len(last) > 256:
                    raise CatalogError('catalog_pagination_invalid', '上游声明更多模型，但没有提供有效分页标识。')
                current_url = first_url + '?' + urlencode({'after_id' if protocol == 'anthropic' else 'after': last})
            elif (value.get('next') or (value.get('links') or {}).get('next') or header_next):
                next_page = value.get('next') or (value.get('links') or {}).get('next') or header_next
                if not isinstance(next_page, str) or len(next_page) > 4096:
                    raise CatalogError('catalog_pagination_invalid', '上游模型分页地址无效。')
                current_url = urljoin(first_url, next_page)
            else:
                if not result:
                    raise CatalogError('catalog_empty', '此 Key 未返回可选模型，可检查模型权限或手动填写。')
                return {'models': list(result.values()), 'protocol': protocol, 'baseUrl': base}
    raise CatalogError('catalog_too_large', '模型目录分页超过 64 页，未截断保存，请缩小上游目录范围。')


class PublicSettings:
    def __init__(self, policy, state_directory):
        self.policy = policy
        self.state = Path(state_directory)
        self.path = self.state / 'public-settings.json'
        self.lock = asyncio.Lock()
        self.settings = initial_settings(policy)
        self.models = {model['id']: safe_model(model) for model in policy['models']}
        self.configuration_error = False
        if self.path.exists() or self.path.is_symlink():
            try:
                if self.state.is_symlink() or self.path.is_symlink() or self.path.stat().st_size > 262144:
                    raise ValueError('invalid_path')
                stored = json.loads(self.path.read_text(encoding='utf8'))
                if stored.get('version') != 1:
                    raise ValueError('invalid_version')
                settings = validate_settings(stored['settings'], loading=True)
                models = stored['models']
                if (not isinstance(models, list) or len(models) != len(settings['modelIds'])
                        or [model.get('id') for model in models] != settings['modelIds']
                        or any(set(model) - MODEL_FIELDS or model.get('protocol') != 'openai_chat'
                               for model in models)):
                    raise ValueError('invalid_models')
                self.settings = settings
                self.models.update({model['id']: safe_model(model) for model in models})
                self.apply(settings, models)
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                self.configuration_error = True
                self.settings['enabled'] = False
                self.policy['models'] = []  # Corrupt overrides never reopen a base trial.

    def apply(self, settings, models):
        for field, (key, *_rest) in FIELDS.items():
            if settings[field] is None:
                self.policy.pop(key, None)
            else:
                self.policy[key] = settings[field]
        if settings['availabilityMode'] == 'permanent':
            self.policy.pop('available_until', None)
        else:
            self.policy['available_until'] = settings['availableUntil']
        self.policy['models'] = deepcopy(models) if settings['enabled'] else []

    def view(self, channels):
        end = self.settings['availableUntil']
        try:
            expired = self.settings['availabilityMode'] == 'until' and deadline(end) <= datetime.now(timezone.utc)
        except (ValueError, TypeError):
            expired = True
        ready = self.settings['enabled'] and bool(self.settings['modelIds']) and not expired and not self.configuration_error
        return {'settings': deepcopy(self.settings), 'channels': channels,
                'status': {'ready': ready, 'expired': expired,
                           'modelCount': len(self.settings['modelIds']) if ready else 0,
                           'configurationError': self.configuration_error}}

    def save(self, settings, channels):
        if settings['revision'] != self.settings['revision']:
            raise FileExistsError('settings_conflict')
        allowed = {model['id']: model for channel in channels for model in channel['models']}
        if any(model not in allowed and (settings['enabled'] or model not in self.models)
               for model in settings['modelIds']):
            raise ValueError('model_unavailable')
        models = []
        for model_id in settings['modelIds']:
            model = self.models.get(model_id)
            if model is None:
                model = {'id': model_id, 'name': allowed[model_id]['name'], 'contextLimit': 1000000,
                         'outputLimit': 32000, 'supportsTools': True, 'inputModalities': ['text'],
                         'protocol': 'openai_chat'}
            else:
                model = {**safe_model(model), 'protocol': 'openai_chat'}
            if model_id in allowed:
                declared = catalog_model_metadata(allowed[model_id])
                if declared:
                    # A refreshed directory supersedes cached window choices.
                    if 'contextLimit' in declared:
                        model.pop('contextLimits', None)
                    model.update(declared)
                model['name'] = allowed[model_id]['name']
            models.append(model)
        settings = {**settings, 'revision': settings['revision'] + 1}
        stored = {'version': 1, 'settings': settings, 'models': models}
        if self.state.is_symlink() or self.path.is_symlink() or not self.state.is_dir():
            raise OSError('invalid_settings_path')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', prefix='.public-settings-',
                                             dir=self.state, delete=False) as stream:
                temporary = Path(stream.name)
                temporary.chmod(0o600)
                json.dump(stored, stream, ensure_ascii=False)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()
        self.settings = settings
        self.models.update({model['id']: model for model in models})
        self.configuration_error = False
        self.apply(settings, models)


def install_public_settings(app, policy, gateway, state_directory, *, reject, read_limited):
    manager = PublicSettings(policy, state_directory)
    app['public_settings'] = manager
    catalog_cache = {}

    def catalog_fingerprint(base, key, protocol):
        canonical, _ = model_catalog_url(base, protocol)
        return hashlib.sha256(json.dumps([canonical, key, protocol]).encode()).digest()

    def cached_catalog(base, key, protocol):
        now = monotonic()
        for fingerprint, (saved, _) in list(catalog_cache.items()):
            if now - saved > 600:
                del catalog_cache[fingerprint]
        return catalog_cache.get(catalog_fingerprint(base, key, protocol), (0, {}))[1]

    async def api(request, path, method='GET', body=None, *, allow_failure=False):
        authorization = request.headers.get('Authorization', '')
        if (not authorization.startswith('Bearer ') or len(authorization) <= 7
                or len(authorization) > 8192 or any(character in authorization for character in '\r\n')):
            reject(401, 'admin_login_required', '请先登录中转站管理员后台。')
        async with app['http'].request(method, gateway + path, json=body,
                headers={'Authorization': authorization}, allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=90 if allow_failure else 15)) as response:
            raw = await read_limited(response, 2097152)
            if response.status in (401, 403):
                reject(response.status, 'admin_login_required', '管理员登录已失效或没有管理权限。')
            if response.status != 200:
                if allow_failure:
                    return {'success': False}
                reject(503, 'admin_service_unavailable', '暂时无法读取中转站后台，请稍后重试。')
            value = json.loads(raw)
            if allow_failure:
                return {'success': value.get('success') is True}
            if value.get('success') is not True:
                reject(503, 'admin_service_unavailable', '暂时无法读取中转站后台，请稍后重试。')
            return value.get('data')

    async def authenticate(request):
        user = await api(request, '/api/user/self')
        user_id = user.get('id')
        if (type(user_id) is not int or user_id <= 0 or type(user.get('role')) is not int
                or user['role'] < 10 or user.get('status') != 1):
            reject(403, 'admin_required', '此设置仅限中转站管理员。')

    async def native_channels(request):
        result, seen = [], set()
        for page in range(6):
            listing = await api(request, f'/api/channel/?p={page}&page_size=50')
            rows = listing.get('items')
            total = listing.get('total')
            if (not isinstance(rows, list) or type(total) is not int or total < 0 or total > 256
                    or len(rows) > 50):
                reject(503, 'catalog_too_large', '渠道目录超过管理界面限制，请先精简渠道。')
            for channel in rows:
                channel_id = channel.get('id')
                if type(channel_id) is not int or channel_id in seen:
                    reject(503, 'catalog_invalid', '渠道目录暂时无法读取，请刷新后重试。')
                seen.add(channel_id)
                result.append(channel)
            if len(seen) >= total:
                return result
            if not rows:
                break
        reject(503, 'catalog_invalid', '渠道分页资料不完整，请刷新后重试。')

    async def channels(request):
        result, model_ids, entries = [], set(), 0
        rows = await native_channels(request)
        for channel in sorted(rows, key=lambda row: row.get('priority', 0) if type(row.get('priority')) is int else 0):
            if channel.get('status') != 1 or channel.get('type') not in (1, 8, 14, 24):
                continue
            if 'default' not in str(channel.get('group', '')).split(','):
                continue
            if channel['type'] == 8 and not str(channel.get('base_url', '')).rstrip('/').endswith('/chat/completions'):
                continue
            ids = channel.get('models', '').split(',')
            if any(not valid_model_id(model) for model in ids):
                continue
            model_ids.update(ids)
            entries += len(ids)
            if len(model_ids) > MAX_DISCOVERED_MODELS or entries > 8192:
                reject(503, 'catalog_too_large', '渠道候选模型目录过大，请先精简渠道模型。')
            result.append(channel_view(channel, ids))
        return result

    async def get_settings(request):
        await authenticate(request)
        catalog = await channels(request)
        async with manager.lock:
            return web.json_response(manager.view(catalog))

    async def put_settings(request):
        if request.headers.get('Origin') != ORIGIN or request.content_type != 'application/json':
            reject(403, 'invalid_admin_origin', '请在中转站管理员页面保存设置。')
        await authenticate(request)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(16384):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                reject(413, 'settings_too_large', '公益设置内容过大。')
        try:
            value = json.loads(raw)
            if (isinstance(value, dict) and type(value.get('revision')) is int
                    and value['revision'] >= 0 and value['revision'] != manager.settings['revision']):
                reject(409, 'settings_conflict', '设置已在其他页面更新，请刷新后重试。')
            settings = validate_settings(value)
        except (ValueError, TypeError):
            reject(400, 'invalid_settings', '设置无效，请检查额度、模型和开放时间。')
        catalog = await channels(request)
        async with manager.lock:
            try:
                manager.save(settings, catalog)
            except FileExistsError:
                reject(409, 'settings_conflict', '设置已在其他页面更新，请刷新后重试。')
            except ValueError:
                reject(400, 'model_unavailable', '所选模型不在当前启用的 Chat 渠道中。')
            except OSError:
                reject(503, 'settings_write_failed', '设置暂时无法保存，原配置已保留。')
            return web.json_response(manager.view(catalog))

    async def add_upstream(request):
        if request.headers.get('Origin') != ORIGIN or request.content_type != 'application/json':
            reject(403, 'invalid_admin_origin', '请在中转站管理员页面保存设置。')
        await authenticate(request)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(16384):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                reject(413, 'settings_too_large', '上游设置内容过大。')
        try:
            value = json.loads(raw)
            if (not isinstance(value, dict) or set(value) - {'baseUrl', 'apiKey', 'modelIds', 'name', 'revision', 'protocol', 'presetId', 'channelId'}
                    or not isinstance(value.get('apiKey'), str) or not 1 <= len(value['apiKey']) <= 8192
                    or any(not 33 <= ord(character) <= 126 for character in value['apiKey'])
                    or ('revision' in value and (type(value['revision']) is not int or value['revision'] < 0))
                    or ('name' in value and (not isinstance(value['name'], str) or len(value['name']) > 256))
                    or ('name' in value and any(ord(character) < 32 for character in value['name']))
                    or ('channelId' in value and (type(value['channelId']) is not int or value['channelId'] <= 0))
                    or ('presetId' in value and (not isinstance(value['presetId'], str) or len(value['presetId']) > 256))
                    or not isinstance(value.get('modelIds'), list) or not 1 <= len(value['modelIds']) <= MAX_MODELS
                    or any(not valid_model_id(model) for model in value['modelIds'])
                    or len(set(value['modelIds'])) != len(value['modelIds'])):
                raise ValueError('invalid_upstream')
            protocol = value.get('protocol', 'openai_chat')
            channel_type, endpoint, effective_protocol = native_upstream(value.get('baseUrl'), protocol)
            if (value['apiKey'] in endpoint or value['apiKey'] in value.get('name', '')
                    or value['apiKey'] in value.get('presetId', '')
                    or any(value['apiKey'] in model for model in value['modelIds'])):
                raise ValueError('invalid_upstream')
            hostname = urlsplit(endpoint).hostname
            await asyncio.wait_for(asyncio.to_thread(check_public_host, hostname), timeout=10)
        except (ValueError, TypeError, OSError, asyncio.TimeoutError) as error:
            if str(error) == 'unsupported_upstream_version':
                reject(400, 'unsupported_upstream_version', '当前中转引擎的 Anthropic 使用 v1、Gemini 使用 v1beta；此版本可读取目录，但不能在简易表单发布。')
            reject(400, 'invalid_upstream', '请填写公网 HTTPS API 地址、有效密钥和模型 ID。')
        async with manager.lock:
            if value.get('revision', manager.settings['revision']) != manager.settings['revision']:
                reject(409, 'settings_conflict', '公益设置已更新，请刷新后重试。')
            rows = await native_channels(request)
            logical_name = value.get('name', '').strip()
            native_name = UPSTREAM_NAME if not logical_name or logical_name == UPSTREAM_NAME else 'LoliCode API · ' + logical_name
            old = ([channel for channel in rows if channel['id'] == value['channelId']]
                   if 'channelId' in value else [])
            if ('channelId' in value and not old) or len(old) > 1 or (old and (channel_metadata(old[0]) is None or old[0].get('type') not in (8, 14, 24))):
                reject(409, 'channel_ownership_conflict', '现有同名渠道由其他配置管理，请在高级后台检查。')
            collisions = [channel for channel in rows if channel.get('name') == native_name and channel not in old]
            if collisions:
                reject(409, 'channel_name_conflict', '已有同名渠道，请编辑该渠道或修改名称。')
            metadata = {'protocol': protocol}
            if logical_name:
                metadata['name'] = logical_name
            if value.get('presetId'):
                metadata['presetId'] = value['presetId']
            discovered = cached_catalog(value['baseUrl'], value['apiKey'], protocol)
            model_metadata = {model_id: {key: item for key, item in discovered[model_id].items() if key != 'id'}
                              for model_id in value['modelIds'] if model_id in discovered}
            if model_metadata:
                metadata['modelMetadata'] = model_metadata
            remark = UPSTREAM_MARKER + '\n' + json.dumps(metadata, ensure_ascii=False)
            draft_name = native_name + ' · draft ' + uuid.uuid4().hex[:12]
            model_ids = value['modelIds']
            matching = [channel for channel in rows if channel.get('status') == 1
                        and set(str(channel.get('models', '')).split(',')) & set(model_ids)]
            priority = max([0] + [channel.get('priority', 0) or 0 for channel in matching
                                   if type(channel.get('priority', 0) or 0) is int]) + 1
            if priority > 1000000:
                reject(409, 'channel_priority_conflict', '现有渠道优先级过高，请在高级后台检查。')
            await api(request, '/api/channel/', 'POST', {'mode': 'single', 'channel': {
                'name': draft_name, 'type': channel_type, 'status': 2, 'group': 'default',
                'key': value['apiKey'], 'base_url': endpoint, 'models': ','.join(model_ids),
                'test_model': model_ids[0], 'priority': priority, 'remark': remark}})
            matches = [channel for channel in await native_channels(request)
                       if channel.get('name') == draft_name and channel.get('remark') == remark
                       and channel.get('type') == channel_type and channel.get('status') == 2]
            if len(matches) != 1:
                reject(503, 'upstream_stage_failed', '暂存渠道未确认，请在高级后台检查；原渠道保持不变。')
            staged = matches[0]
            test_model = model_ids[0]
            query = urlencode({'model': test_model, 'endpoint_type': 'openai', 'stream': 'false'})
            try:
                test = await api(request, '/api/channel/test/' + str(staged['id']) + '?' + query,
                                 allow_failure=True)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError):
                test = {'success': False}
            if not test['success']:
                return web.json_response({'success': False,
                    'effectiveProtocol': effective_protocol,
                    'channel': channel_view(staged, model_ids),
                    'test': {'model': test_model, 'success': False},
                    'message': '连接测试未通过，暂存渠道保持停用。原渠道与已发布公益模型保持不变，请核对地址、密钥和模型 ID。'})
            try:
                await api(request, '/api/channel/', 'PUT', {
                    'id': staged['id'], 'type': channel_type, 'name': native_name, 'group': 'default',
                    'base_url': endpoint, 'models': ','.join(model_ids),
                    'test_model': test_model, 'priority': priority, 'remark': remark})
                await api(request, '/api/channel/' + str(staged['id']) + '/status', 'POST', {'status': 1})
            except Exception:
                # The previous working source has not been touched during promotion.
                try:
                    await api(request, '/api/channel/' + str(staged['id']) + '/status', 'POST', {'status': 2})
                except Exception:
                    pass
                reject(503, 'upstream_activation_failed', '测试已通过，但渠道切换未完成，请在高级后台检查。')
            archived = True
            # Only retire the previous owned source after the higher-priority replacement is enabled.
            if old:
                previous = old[0]
                try:
                    await api(request, '/api/channel/' + str(previous['id']) + '/status', 'POST', {'status': 2})
                    await api(request, '/api/channel/', 'PUT', {
                        'id': previous['id'], 'type': previous['type'],
                        'name': previous['name'] + ' · backup ' + str(previous['id']),
                        'group': previous.get('group', 'default'), 'base_url': previous['base_url'],
                        'models': previous['models'], 'remark': previous['remark']})
                except Exception:
                    archived = False  # New source still wins by priority; no old key was overwritten.
            return web.json_response({'success': True,
                'effectiveProtocol': effective_protocol,
                'channel': channel_view({**staged, 'name': native_name, 'status': 1}, model_ids),
                'test': {'model': test_model, 'success': True},
                'message': (('API 已保存，当前公益入口使用 Chat Completions，首个模型的兼容性测试已通过。'
                             if protocol == 'openai_responses' else 'API 渠道已保存，首个模型连接测试通过。')
                            + '请勾选需要开放的模型并保存公益设置。'
                            if archived else '新 API 已启用；旧渠道归档未完成，请在高级后台检查。')})

    async def discover_upstream_models(request):
        if request.headers.get('Origin') != ORIGIN or request.content_type != 'application/json':
            reject(403, 'invalid_admin_origin', '请在中转站管理员页面读取模型。')
        await authenticate(request)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(16384):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                reject(413, 'settings_too_large', '模型发现请求内容过大。')
        try:
            value = json.loads(raw)
            if (not isinstance(value, dict) or set(value) - {'baseUrl', 'apiKey', 'protocol', 'presetId'}
                    or not isinstance(value.get('apiKey'), str) or not 1 <= len(value['apiKey']) <= 8192
                    or any(not 33 <= ord(character) <= 126 for character in value['apiKey'])
                    or ('presetId' in value and (not isinstance(value['presetId'], str) or len(value['presetId']) > 256))):
                raise ValueError('invalid_upstream')
            protocol = value.get('protocol', 'openai_chat')
            base, _ = model_catalog_url(value.get('baseUrl'), protocol)
            await asyncio.wait_for(asyncio.to_thread(check_public_host, urlsplit(base).hostname), timeout=10)
            result = await discover_model_catalog(base, value['apiKey'], protocol)
            cached_catalog(base, value['apiKey'], protocol)  # Expire old entries.
            if len(catalog_cache) >= 32:
                del catalog_cache[min(catalog_cache, key=lambda fingerprint: catalog_cache[fingerprint][0])]
            catalog_cache[catalog_fingerprint(base, value['apiKey'], protocol)] = (
                monotonic(), {model['id']: model for model in result['models']})
        except CatalogError as error:
            reject(error.status, error.code, error.message)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            reject(400, 'catalog_unavailable', '无法连接模型目录，请检查 HTTPS 地址和网络后重试。')
        except (ValueError, TypeError, AttributeError):
            reject(400, 'invalid_upstream', '请填写公网 HTTPS API 地址、有效 Key 和支持的协议。')
        return web.json_response(result)

    app.router.add_get('/admin/public-settings', get_settings)
    app.router.add_put('/admin/public-settings', put_settings)
    app.router.add_post('/admin/upstream', add_upstream)
    app.router.add_post('/admin/upstream/models', discover_upstream_models)
    return manager
