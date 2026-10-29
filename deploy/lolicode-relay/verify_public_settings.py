#!/usr/bin/env python3
"""Verify public management isolation without saving settings or calling models."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from bootstrap import Dashboard, ROOT


ORIGIN = 'https://relay.lolicode.com'
SETTINGS_ROUTE = '/admin-api/public-settings'
UPSTREAM_ROUTE = '/admin-api/upstream'
MODELS_ROUTE = '/admin-api/upstream/models'
MAX_RESPONSE = 2 * 1024 * 1024
SETTING_FIELDS = {
    'revision', 'enabled', 'availabilityMode', 'availableUntil', 'modelIds',
    'dailyRequests', 'dailyTokens', 'globalDailyRequests', 'globalDailyTokens',
    'maxConcurrentPerAccount', 'maxConcurrentGlobal', 'globalRequestsPerMinute',
    'maxOutputTokens', 'maxRequestBytes',
}
LIMIT_FIELDS = {
    'maxOutputTokens', 'maxRequestBytes', 'maxConcurrentPerAccount',
    'maxConcurrentGlobal', 'globalRequestsPerMinute', 'globalDailyRequests',
    'globalDailyTokens',
}
NULLABLE_LIMITS = {
    'maxConcurrentGlobal', 'globalRequestsPerMinute', 'globalDailyRequests',
    'globalDailyTokens',
}
SECRET_FIELDS = {
    'key', 'apikey', 'gatewaykey', 'upstreamkey', 'token', 'accesstoken',
    'refreshtoken', 'forumtoken', 'password', 'secret', 'clientsecret',
    'authorization', 'cookie', 'credential', 'credentials',
}
CHANNEL_FIELDS = {'id', 'name', 'enabled', 'status', 'models', 'baseUrl', 'protocol', 'presetId', 'managed'}
PROTOCOLS = {'openai_chat', 'openai_responses', 'anthropic', 'gemini_native'}


class VerificationError(Exception):
    """Carries only a fixed check name, never an HTTP response or credential."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, check):
    if not condition:
        raise VerificationError(check)


def file_fingerprint(path):
    require(not path.is_symlink() and not path.parent.is_symlink(),
            'settings_path_is_regular')
    if not path.exists():
        return None
    require(path.is_file(), 'settings_path_is_regular')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def no_credentials(value, token=None):
    if isinstance(value, dict):
        for key, entry in value.items():
            normalized = ''.join(character for character in key.lower() if character.isalnum())
            require(normalized not in SECRET_FIELDS, 'response_has_no_credential_fields')
            no_credentials(entry, token)
    elif isinstance(value, list):
        for entry in value:
            no_credentials(entry, token)
    elif isinstance(value, str) and token:
        require(token not in value, 'response_has_no_admin_credential')


def validate_view(value, token):
    require(isinstance(value, dict) and set(value) == {'settings', 'channels', 'status'},
            'admin_view_shape')
    no_credentials(value, token)
    settings, channels, status = value['settings'], value['channels'], value['status']
    require(isinstance(settings, dict) and set(settings) == SETTING_FIELDS,
            'settings_shape')
    require(type(settings['revision']) is int and 0 <= settings['revision'] <= 2**53 - 2,
            'revision_shape')
    require(type(settings['enabled']) is bool, 'enabled_shape')
    require(settings['availabilityMode'] in ('permanent', 'until'), 'availability_shape')
    end = settings['availableUntil']
    if settings['availabilityMode'] == 'permanent':
        require(end is None, 'availability_shape')
    else:
        require(isinstance(end, str), 'availability_shape')
        try:
            parsed = datetime.fromisoformat(end.replace('Z', '+00:00'))
        except ValueError:
            raise VerificationError('availability_shape') from None
        require(parsed.tzinfo is not None, 'availability_shape')
    require(isinstance(settings['modelIds'], list)
            and all(isinstance(model, str) and model for model in settings['modelIds']),
            'selected_models_shape')
    for field in LIMIT_FIELDS | {'dailyRequests', 'dailyTokens'}:
        limit = settings[field]
        require((field in NULLABLE_LIMITS and limit is None)
                or (type(limit) is int and limit > 0), 'limit_shape')
    require(isinstance(channels, list), 'channel_catalog_shape')
    for channel in channels:
        require(isinstance(channel, dict)
                and set(channel) == CHANNEL_FIELDS
                and type(channel['id']) is int and channel['id'] > 0
                and isinstance(channel['name'], str)
                and channel['enabled'] is True and channel['status'] == 1
                and type(channel['managed']) is bool
                and isinstance(channel['baseUrl'], str)
                and channel['protocol'] in PROTOCOLS
                and (channel['presetId'] is None or isinstance(channel['presetId'], str))
                and isinstance(channel['models'], list), 'channel_catalog_shape')
        if channel['baseUrl']:
            endpoint = urllib.parse.urlsplit(channel['baseUrl'])
            require(endpoint.scheme in ('https', 'http') and bool(endpoint.hostname)
                    and endpoint.username is None and endpoint.password is None
                    and not endpoint.query and not endpoint.fragment, 'channel_endpoint_has_no_credentials')
        for model in channel['models']:
            require(isinstance(model, dict) and set(model) == {'id', 'name'}
                    and isinstance(model['id'], str) and bool(model['id'])
                    and isinstance(model['name'], str), 'channel_catalog_shape')
    require(isinstance(status, dict)
            and {'ready', 'expired', 'modelCount'} <= set(status)
            and set(status) <= {'ready', 'expired', 'modelCount', 'configurationError'}
            and type(status['ready']) is bool and type(status['expired']) is bool
            and type(status['modelCount']) is int and status['modelCount'] >= 0,
            'management_status_shape')
    if 'configurationError' in status:
        require(type(status['configurationError']) is bool, 'management_status_shape')


def validate_public_status(value):
    require(isinstance(value, dict)
            and {'ready', 'modelCount', 'dailyRequests', 'dailyTokens', 'timezone',
                 'resetsAt', 'limits', 'trialEndsAt'} <= set(value),
            'community_status_legacy_fields')
    no_credentials(value)
    require(type(value['ready']) is bool and type(value['modelCount']) is int
            and value['modelCount'] >= 0, 'community_status_types')
    require(value['timezone'] == 'Asia/Singapore' and isinstance(value['resetsAt'], str),
            'community_status_types')
    for field in ('dailyRequests', 'dailyTokens'):
        require(type(value[field]) is int and value[field] > 0, 'community_status_types')
    require(value['trialEndsAt'] is None or isinstance(value['trialEndsAt'], str),
            'community_status_types')
    require(isinstance(value['limits'], dict)
            and LIMIT_FIELDS <= set(value['limits']), 'community_status_legacy_limits')
    for field in LIMIT_FIELDS:
        entry = value['limits'][field]
        require((field in NULLABLE_LIMITS and entry is None)
                or (type(entry) is int and entry > 0), 'community_status_legacy_limits')


def verify(report):
    marker = ROOT / '.lolicode-relay-admin-public-owned'
    require(not ROOT.is_symlink() and not marker.is_symlink()
            and marker.read_text().strip() == 'lolicode-relay-admin-public-v1',
            'owned_public_admin_deployment')
    override = ROOT / 'bridge-state/public-settings.json'
    policy = ROOT / 'bridge-policy.json'
    initial_files = (file_fingerprint(override), file_fingerprint(policy))
    report['override_initially_present'] = initial_files[0] is not None
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    dashboard = Dashboard()
    checks = report['checks']
    next_admin_request = 0.0

    def unchanged(check):
        require((file_fingerprint(override), file_fingerprint(policy)) == initial_files, check)

    def request(method, path, *, body=None, token=None, origin=None, base=ORIGIN):
        nonlocal next_admin_request
        if base == ORIGIN and (path.startswith('/admin-api/') or path == '/community-status'):
            # Stay inside the existing 120/minute protection and its short burst.
            delay = next_admin_request - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            next_admin_request = time.monotonic() + 0.55
        headers = {'Accept': 'application/json', 'User-Agent': 'LoliCodePublicSettingsAcceptance/1.0'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if origin is not None:
            headers['Origin'] = origin
        req = urllib.request.Request(base + path,
                data=None if body is None else json.dumps(body).encode(),
                headers=headers, method=method)
        try:
            response = opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(MAX_RESPONSE + 1)
            require(len(raw) <= MAX_RESPONSE, 'response_size')
            if token:
                require(token.encode() not in raw, 'response_has_no_admin_credential')
            value = None
            if raw and 'application/json' in response.headers.get('Content-Type', '').lower():
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise VerificationError('json_response_shape') from None
            return response.status, value, response.headers

    def rejected(method, path, expected, check, **kwargs):
        code, value, _ = request(method, path, **kwargs)
        require(code in expected if isinstance(expected, tuple) else code == expected, check)
        if value is not None:
            no_credentials(value, dashboard.token)
        unchanged(check + '_preserves_files')
        checks[check] = True

    try:
        for path in ('/admin', '/admin/'):
            code, _, headers = request('GET', path)
            require(code == 302 and urllib.parse.urljoin(ORIGIN, headers.get('Location', ''))
                    == ORIGIN + '/public-models-admin', 'stable_admin_entry')
        checks['stable_admin_entry'] = True
        code, _, headers = request('GET', '/public-models-admin')
        require(code == 200 and 'text/html' in headers.get('Content-Type', '').lower(),
                'anonymous_shell_is_available')
        checks['anonymous_shell_is_available'] = True
        rejected('GET', SETTINGS_ROUTE, 401, 'anonymous_settings_rejected')
        rejected('GET', SETTINGS_ROUTE, (401, 403), 'forum_bearer_format_rejected',
                 token='lc1.1.' + '0' * 40)
        rejected('POST', UPSTREAM_ROUTE, 401, 'anonymous_upstream_rejected',
                 body={}, origin=ORIGIN)
        rejected('POST', MODELS_ROUTE, 401, 'anonymous_model_discovery_rejected',
                 body={}, origin=ORIGIN)
        dashboard.login()
        require(isinstance(dashboard.token, str) and bool(dashboard.token), 'existing_admin_login')
        checks['existing_admin_login'] = True
        code, before, headers = request('GET', SETTINGS_ROUTE, token=dashboard.token)
        require(code == 200, 'admin_settings_read')
        validate_view(before, dashboard.token)
        require('no-store' in headers.get('Cache-Control', ''), 'settings_not_cached')
        checks['admin_read_has_only_safe_fields'] = True
        settings = before['settings']
        rejected('PUT', SETTINGS_ROUTE, 403, 'foreign_origin_settings_rejected',
                 body=deepcopy(settings), token=dashboard.token,
                 origin='https://untrusted.example.invalid')
        rejected('POST', UPSTREAM_ROUTE, 403, 'foreign_origin_upstream_rejected',
                 body={}, token=dashboard.token, origin='https://untrusted.example.invalid')
        rejected('POST', MODELS_ROUTE, 403, 'foreign_origin_model_discovery_rejected',
                 body={}, token=dashboard.token, origin='https://untrusted.example.invalid')
        stale = deepcopy(settings)
        # A lower revision remains stale during concurrent saves. At revision zero,
        # use the largest legal value so the next ordinary save cannot match it.
        stale['revision'] = settings['revision'] - 1 if settings['revision'] else 2**53 - 2
        rejected('PUT', SETTINGS_ROUTE, 409, 'stale_revision_rejected',
                 body=stale, token=dashboard.token, origin=ORIGIN)
        occupied = set(settings['modelIds']) | {
            model['id'] for channel in before['channels'] for model in channel['models']}
        candidate, suffix = 'lolicode-verification-unavailable-model', 0
        while candidate in occupied:
            suffix += 1
            candidate = 'lolicode-verification-unavailable-model-' + str(suffix)
        invalid = deepcopy(settings)
        invalid['modelIds'] = settings['modelIds'][:127] + [candidate]
        rejected('PUT', SETTINGS_ROUTE, 400, 'unavailable_model_rejected',
                 body=invalid, token=dashboard.token, origin=ORIGIN)
        code, after, _ = request('GET', SETTINGS_ROUTE, token=dashboard.token)
        require(code == 200, 'admin_settings_reread')
        validate_view(after, dashboard.token)
        require(after['settings'] == before['settings'], 'live_settings_unchanged')
        require(after['channels'] == before['channels'], 'live_channel_catalog_unchanged')
        unchanged('rejected_writes_preserve_override_and_policy')
        checks['live_settings_unchanged'] = True
        checks['live_channel_catalog_unchanged'] = True
        checks['rejected_writes_preserve_override_and_policy'] = True
        rejected('GET', '/relay/admin/public-settings', 404,
                 'forum_host_does_not_expose_admin_settings', base='https://lolicode.com')
        rejected('GET', '/v1/models', 404, 'direct_inference_remains_closed',
                 token=dashboard.token)
        code, public, _ = request('GET', '/community-status')
        require(code == 200, 'community_status_available')
        validate_public_status(public)
        require(public['dailyRequests'] == settings['dailyRequests']
                and public['dailyTokens'] == settings['dailyTokens']
                and all(public['limits'][field] == settings[field] for field in LIMIT_FIELDS)
                and public['trialEndsAt'] == settings['availableUntil'],
                'community_status_matches_current_settings')
        checks['community_status_legacy_compatible'] = True
    finally:
        dashboard.logout()
        unchanged('verification_preserves_override_and_policy')


def write_receipt(report):
    destination = ROOT / 'public-settings-verification.json'
    require(not ROOT.is_symlink() and not destination.is_symlink(), 'receipt_path_is_regular')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8',
                prefix='.public-settings-verification-', dir=ROOT, delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            json.dump(report, stream, ensure_ascii=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'url': ORIGIN,
              'ok': False, 'checks': {}, 'valid_settings_writes': 0,
              'upstream_test_calls': 0, 'created_accounts': 0, 'quota_records_modified': 0}
    try:
        verify(report)
        report['ok'] = True
    except VerificationError as error:
        report['failed_check'] = str(error)
    except Exception:
        # HTTP bodies, login errors and exception messages can contain credentials.
        report['failed_check'] = 'verification_failed_without_exposing_response'
    try:
        write_receipt(report)
    except Exception:
        report['ok'] = False
        report['receipt_saved'] = False
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
