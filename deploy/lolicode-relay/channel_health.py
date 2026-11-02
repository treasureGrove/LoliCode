#!/usr/bin/env python3
"""Hourly, bounded channel probes. Never change channels or member Credit balances.

Pinned native behavior is verified against New API v1.0.0-rc.45:
https://raw.githubusercontent.com/QuantumNous/new-api/v1.0.0-rc.45/controller/channel-test.go
Explicit TestChannel only updates response time. endpoint_type=openai sends
one 'hi' message with max_tokens=16; it does not use automatic channel disabling.
"""
import argparse
import asyncio
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import time
from urllib.parse import urlencode

import aiohttp

from bootstrap import Dashboard, ROOT, BASE
from public_settings import PublicSettings, valid_model_id

INTERVAL = 3600
MAX_CHANNELS = 256
MAX_HISTORY = 168
MAX_STATE_BYTES = 1024 * 1024
MAX_RUNTIME = 3000
PROBE_TIMEOUT = 90
PROBE_GAP = 11
REASONS = {
    'healthy': '渠道连接正常。',
    'failed': '渠道连通性测试失败，请检查上游配置。',
    'timeout': '渠道测试超时，结果尚未确认。',
    'network': '测试连接中断，结果尚未确认。',
    'invalid_response': '测试未返回有效结果，结果尚未确认。',
    'inactive': '公益模型未开放或已到期，本轮未发送测试。',
    'not_public': '渠道未启用或没有已开放的模型，本轮未发送测试。',
    'busy': '当前并发或请求频率已满，本轮跳过测试。',
    'budget': '本轮巡检时间预算已用完，未发送测试。',
    'pending': '本小时已发起测试，结果待确认。',
    'metadata': '暂时无法读取渠道配置，本轮未发送测试。',
    'overrides': '渠道覆盖参数可能改变最小测试预算，本轮未发送测试。',
    'unknown': '尚无当前渠道的巡检结果。',
    'changed': '渠道配置或代表模型已变化，等待下次巡检。',
    'stale': '巡检结果已过期，等待下次巡检。',
}
STORED_STATUSES = {'healthy', 'failed', 'timeout', 'skipped'}


def utc_now():
    return datetime.now(timezone.utc)


def timestamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds')


def parse_time(value):
    try:
        if not isinstance(value, str) or len(value) > 64:
            return None
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo is not None else None
    except ValueError:
        return None


def hour_key(now):
    return timestamp(now.replace(minute=0, second=0, microsecond=0))


def next_hour(now):
    return timestamp(now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))


def channel_id(channel):
    value = channel.get('id') if isinstance(channel, dict) else None
    return value if type(value) is int and 0 < value <= 2**53 - 1 else None


def channel_models(channel):
    entries = channel.get('models', '')
    if isinstance(entries, str):
        entries = entries.split(',')
    elif isinstance(entries, list):
        entries = [entry.get('id') if isinstance(entry, dict) else entry for entry in entries]
    else:
        return []
    if len(entries) > 2048 or any(not valid_model_id(model) for model in entries):
        return []
    return list(dict.fromkeys(entries))


def channel_fingerprint(channel):
    """Hash configuration only; never persist credentials, names or upstream text."""
    fields = ('id', 'type', 'status', 'group', 'base_url', 'models', 'test_model',
              'model_mapping', 'param_override', 'header_override', 'setting',
              'settings', 'openai_organization', 'status_code_mapping',
              'other', 'other_info', 'remark', 'key')
    value = {key: channel.get(key) for key in fields}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                     separators=(',', ':')).encode()).hexdigest()


def selected_model(channel, public_model_ids):
    if (channel_id(channel) is None or channel.get('status') != 1
            or channel.get('type') not in (1, 8, 14, 24)
            or 'default' not in str(channel.get('group', '')).split(',')):
        return None
    if channel.get('type') == 8 and not str(channel.get('base_url', '')).rstrip('/').endswith('/chat/completions'):
        return None
    eligible = [model for model in channel_models(channel) if model in public_model_ids]
    preferred = channel.get('test_model')
    return preferred if preferred in eligible else eligible[0] if eligible else None


def safe_probe_config(channel):
    value = channel.get('param_override')
    if value is None or value == '':
        return True
    try:
        return (json.loads(value) if isinstance(value, str) else value) == {}
    except (ValueError, TypeError):
        return False


def load_policy(root):
    path = Path(root) / 'bridge-policy.json'
    if path.is_symlink() or path.stat().st_size > MAX_STATE_BYTES:
        raise ValueError('invalid_policy_path')
    policy = json.loads(path.read_text(encoding='utf8'))
    manager = PublicSettings(deepcopy(policy), Path(root) / 'bridge-state')
    return manager.policy


def public_models(policy, now):
    from bridge import active_models
    return {model['id'] for model in active_models(policy, now) if valid_model_id(model.get('id'))}


def empty_state():
    return {'version': 1, 'intervalSeconds': INTERVAL, 'lastRunAt': None,
            'nextRunAt': None, 'results': [], 'history': [], 'attempts': []}


def read_state(state_directory):
    state_directory = Path(state_directory)
    path = state_directory / 'channel-health.json'
    if state_directory.is_symlink() or path.is_symlink():
        raise OSError('invalid_health_path')
    if not path.exists():
        return empty_state()
    if path.stat().st_size > MAX_STATE_BYTES:
        raise ValueError('health_state_too_large')
    value = json.loads(path.read_text(encoding='utf8'))
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ValueError('invalid_health_state')
    return value


def write_state(state_directory, value):
    state_directory = Path(state_directory)
    path = state_directory / 'channel-health.json'
    if state_directory.is_symlink() or path.is_symlink() or not state_directory.is_dir():
        raise OSError('invalid_health_path')
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
    if len(raw.encode()) > MAX_STATE_BYTES:
        raise ValueError('health_state_too_large')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=state_directory,
                                         prefix='.channel-health-', delete=False) as stream:
            temporary = Path(stream.name)
            temporary.chmod(0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != 'nt':
            descriptor = os.open(state_directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


class AlreadyRunning(Exception):
    pass


@contextmanager
def round_lock(state_directory):
    path = Path(state_directory) / 'channel-health.lock'
    if Path(state_directory).is_symlink() or path.is_symlink():
        raise OSError('invalid_health_lock')
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'0')
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError:
                raise AlreadyRunning() from None
        else:
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise AlreadyRunning() from None
        yield
    finally:
        os.close(descriptor)


def safe_result(value):
    if not isinstance(value, dict) or channel_id({'id': value.get('channelId')}) is None:
        return None
    model = value.get('model')
    checked = parse_time(value.get('checkedAt'))
    if model is not None and not valid_model_id(model):
        return None
    status = value.get('status')
    fingerprint = value.get('fingerprint')
    if (status not in STORED_STATUSES or checked is None or not isinstance(fingerprint, str)
            or not re.fullmatch('[0-9a-f]{64}', fingerprint)):
        return None
    number = lambda value, maximum: value if type(value) is int and 0 <= value <= maximum else 0
    result = {'channelId': value['channelId'], 'model': model, 'status': status,
              'checkedAt': timestamp(checked), 'latencyMs': number(value.get('latencyMs'), 3600000),
              'reason': value['reason'] if value.get('reason') in REASONS.values() else REASONS[status if status != 'skipped' else 'unknown'],
              'consecutiveFailures': number(value.get('consecutiveFailures'), 1000000),
              'fingerprint': fingerprint}
    http_status = value.get('httpStatus')
    result['httpStatus'] = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
    return result


def safe_history(values, now):
    result = []
    for value in values[-MAX_HISTORY:] if isinstance(values, list) else []:
        checked = parse_time(value.get('runAt')) if isinstance(value, dict) else None
        if checked is None or not now - timedelta(days=7) <= checked <= now + timedelta(minutes=5):
            continue
        result.append({'runAt': timestamp(checked), **{status: min(MAX_CHANNELS, max(0, value.get(status, 0)))
            if type(value.get(status, 0)) is int else 0 for status in STORED_STATUSES}})
    return result


def current_attempts(values, now):
    if not isinstance(values, list):
        return []
    hour = now.replace(minute=0, second=0, microsecond=0)
    return [{'channelId': entry['channelId'], 'hour': timestamp(hour)}
            for entry in values if isinstance(entry, dict)
            and channel_id({'id': entry.get('channelId')}) is not None
            and parse_time(entry.get('hour')) == hour][:512]


def health_view(state_directory, channels, *, now=None, public_model_ids=None):
    """Read-only admin projection. Pass native channels, never upstream response data."""
    now = now or utc_now()
    try:
        stored = read_state(state_directory)
    except (OSError, ValueError, TypeError):
        stored = empty_state()
    results = {result['channelId']: result for value in stored.get('results', [])[:MAX_CHANNELS]
               if (result := safe_result(value)) is not None} if isinstance(stored.get('results'), list) else {}
    output = []
    for channel in list(channels)[:MAX_CHANNELS]:
        identity = channel_id(channel)
        if identity is None:
            continue
        current = results.get(identity)
        model = selected_model(channel, set(public_model_ids)) if public_model_ids is not None else None
        if current is None:
            current = {'channelId': identity, 'model': model, 'status': 'unknown', 'checkedAt': None,
                       'latencyMs': None, 'httpStatus': None, 'reason': REASONS['unknown'], 'consecutiveFailures': 0}
        elif (current['fingerprint'] != channel_fingerprint(channel)
              or (public_model_ids is not None and current['model'] != model)):
            current = {**current, 'status': 'stale', 'reason': REASONS['changed']}
        elif not now - timedelta(seconds=2 * INTERVAL) <= parse_time(current['checkedAt']) <= now + timedelta(minutes=5):
            current = {**current, 'status': 'stale', 'reason': REASONS['stale']}
        if public_model_ids is not None and model is None:
            current = {**current, 'status': 'skipped', 'reason': REASONS['not_public']}
        output.append(current)
    last = parse_time(stored.get('lastRunAt'))
    following = parse_time(stored.get('nextRunAt'))
    return {'version': 1, 'intervalSeconds': INTERVAL,
            'lastRunAt': timestamp(last) if last else None,
            'nextRunAt': timestamp(following) if following else next_hour(now),
            'results': output, 'history': safe_history(stored.get('history'), now)}


def list_channels(client):
    result, seen = [], set()
    for page in range(1, 7):
        value = client.request('/api/channel/?' + urlencode({'p': page, 'page_size': 50}))
        rows = value.get('items') if isinstance(value, dict) else None
        total = value.get('total') if isinstance(value, dict) else None
        if (not isinstance(rows, list) or type(total) is not int or not 0 <= total <= MAX_CHANNELS
                or len(rows) > 50):
            raise ValueError('invalid_channel_catalog')
        for row in rows:
            identity = channel_id(row)
            if identity is None or identity in seen:
                raise ValueError('invalid_channel_catalog')
            seen.add(identity)
            result.append(row)
        if len(result) == total:
            return result
        if not rows or len(result) > total:
            break
    raise ValueError('invalid_channel_catalog')


def channel_test(client, identity, model, *, timeout=PROBE_TIMEOUT):
    """Use the authenticated native test endpoint; raw errors never leave this function."""
    query = urlencode({'model': model, 'endpoint_type': 'openai', 'stream': 'false'})
    async def fetch():
        headers = {'Authorization': 'Bearer ' + client.token, 'Accept': 'application/json',
                   'User-Agent': 'LoliCodeRelayHealth/1.0'}
        async with aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
                timeout=aiohttp.ClientTimeout(total=min(PROBE_TIMEOUT, timeout), connect=10),
                headers=headers) as session:
            async with session.get(BASE + '/api/channel/test/' + str(identity) + '?' + query,
                                   allow_redirects=False) as response:
                status = response.status
                if status != 200:
                    return {'status': 'failed', 'httpStatus': status, 'reason': REASONS['failed'], 'uncertain': False}
                raw = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    raw.extend(chunk)
                    if len(raw) > MAX_STATE_BYTES:
                        raise ValueError('invalid_probe_response')
                value = json.loads(raw)
                if not isinstance(value, dict) or type(value.get('success')) is not bool:
                    raise ValueError('invalid_probe_response')
                healthy = value['success']
                return {'status': 'healthy' if healthy else 'failed', 'httpStatus': status,
                        'reason': REASONS['healthy' if healthy else 'failed'], 'uncertain': False}
    try:
        return asyncio.run(fetch())
    except (TimeoutError, socket.timeout):
        return {'status': 'timeout', 'httpStatus': None, 'reason': REASONS['timeout'], 'uncertain': True}
    except aiohttp.ClientError:
        return {'status': 'failed', 'httpStatus': None, 'reason': REASONS['network'], 'uncertain': True}
    except (ValueError, OSError):
        return {'status': 'failed', 'httpStatus': None, 'reason': REASONS['invalid_response'], 'uncertain': True}


def run_checks(root=ROOT, *, dry_run=False, client_factory=Dashboard, ledger_factory=None,
               test_fn=channel_test, sleep=time.sleep, monotonic=time.monotonic, clock=utc_now):
    root = Path(root)
    state_directory = root / 'bridge-state'
    if state_directory.is_symlink():
        raise OSError('invalid_health_path')
    if not dry_run:
        state_directory.mkdir(mode=0o700, exist_ok=True)
    started, deadline = clock(), monotonic() + MAX_RUNTIME
    policy = load_policy(root)
    public = public_models(policy, started)
    if not public:
        if not dry_run:
            with round_lock(state_directory):
                try:
                    old = read_state(state_directory)
                except (ValueError, TypeError):
                    old = empty_state()
                results = [result for entry in old.get('results', [])[:MAX_CHANNELS]
                           if (result := safe_result(entry)) is not None] if isinstance(old.get('results'), list) else []
                results = [{**result, 'status': 'skipped', 'reason': REASONS['inactive']} for result in results]
                attempts = current_attempts(old.get('attempts'), started)
                state = {**empty_state(), 'lastRunAt': timestamp(started), 'nextRunAt': next_hour(started),
                         'results': results, 'attempts': attempts,
                         'history': safe_history([*safe_history(old.get('history'), started),
                             {'runAt': timestamp(started), 'skipped': len(results)}], started)}
                write_state(state_directory, state)
        return {'ok': True, 'dryRun': dry_run, 'candidateCount': 0, 'tested': 0,
                'reason': REASONS['inactive']}
    client = client_factory()

    def execute():
        client.login()
        channels = list_channels(client)
        candidates = [(channel, selected_model(channel, public)) for channel in channels]
        candidates = [(channel, model) for channel, model in candidates if model is not None]
        if dry_run:
            return {'ok': True, 'dryRun': True, 'candidateCount': len(candidates), 'tested': 0,
                    'candidates': [{'channelId': channel['id'], 'model': model} for channel, model in candidates]}
        from bridge import Ledger, Rejected
        ledger = (ledger_factory or Ledger)(state_directory / 'bridge.sqlite3')
        try:
            old = read_state(state_directory)
        except (ValueError, TypeError):
            old = empty_state()
        state = {**empty_state(), 'lastRunAt': timestamp(started), 'nextRunAt': next_hour(started),
                 'history': safe_history(old.get('history'), started)}
        previous = {result['channelId']: result for entry in old.get('results', [])[:MAX_CHANNELS]
                    if (result := safe_result(entry)) is not None} if isinstance(old.get('results'), list) else {}
        attempts = current_attempts(old.get('attempts'), started)
        state['attempts'] = attempts
        results, current_round, last_finished, tested = dict(previous), [], None, 0

        def save(result):
            results[result['channelId']] = result
            state['results'] = [results[channel['id']] for channel in channels if channel['id'] in results][:MAX_CHANNELS]
            write_state(state_directory, state)

        for initial, initial_model in candidates:
            identity = initial['id']
            same_hour = any(entry['channelId'] == identity for entry in attempts)
            if same_hour:
                continue  # The pre-request marker also survives a killed worker.
            prior = previous.get(identity)
            fingerprint, model = channel_fingerprint(initial), initial_model
            result = {'channelId': identity, 'model': model, 'status': 'skipped',
                      'checkedAt': timestamp(clock()), 'latencyMs': 0, 'httpStatus': None,
                      'reason': REASONS['budget'], 'consecutiveFailures': 0, 'fingerprint': fingerprint}
            if last_finished is not None:
                delay = max(0, PROBE_GAP - (monotonic() - last_finished))
                if monotonic() + delay + PROBE_TIMEOUT <= deadline:
                    sleep(delay)
            if monotonic() + PROBE_TIMEOUT > deadline:
                save(result)
                current_round.append(result)
                continue
            try:
                # Recheck channel status and current publication after the delay.
                channel = client.request('/api/channel/' + str(identity))
                if channel_id(channel) != identity:
                    raise ValueError('invalid_channel')
                policy = load_policy(root)
                model = selected_model(channel, public_models(policy, clock()))
                fingerprint = channel_fingerprint(channel)
                result.update(model=model, fingerprint=fingerprint, checkedAt=timestamp(clock()), reason=REASONS['not_public'])
            except (OSError, ValueError, RuntimeError):
                result['reason'] = REASONS['metadata']
                save(result)
                current_round.append(result)
                continue
            if model is None:
                save(result)
                current_round.append(result)
                continue
            if not safe_probe_config(channel):
                result['reason'] = REASONS['overrides']
                save(result)
                current_round.append(result)
                continue
            if monotonic() + PROBE_TIMEOUT > deadline:
                result['reason'] = REASONS['budget']
                save(result)
                current_round.append(result)
                continue
            if prior and prior['fingerprint'] == fingerprint:
                result['consecutiveFailures'] = prior['consecutiveFailures']
            if len(attempts) >= 512:
                save(result)
                current_round.append(result)
                continue
            try:
                lease = ledger.acquire_probe(policy)
            except Rejected:
                result['reason'] = REASONS['busy']
                save(result)
                current_round.append(result)
                continue
            attempts.append({'channelId': identity, 'hour': hour_key(clock())})
            result['reason'] = REASONS['pending']
            # Persist the attempt before sending inference; no retry after a crash.
            try:
                save(result)
            except BaseException:
                ledger.finish_probe(lease)
                raise
            uncertain = True
            before = monotonic()
            try:
                outcome = test_fn(client, identity, model, timeout=PROBE_TIMEOUT)
                uncertain = outcome.get('uncertain', True) is not False
                if (outcome.get('status') not in ('healthy', 'failed', 'timeout')
                        or outcome.get('reason') not in REASONS.values()):
                    uncertain = True
                    raise ValueError('invalid_probe_result')
                result.update(status=outcome['status'], reason=outcome['reason'],
                              httpStatus=outcome.get('httpStatus'))
            except (TimeoutError, socket.timeout):
                result.update(status='timeout', reason=REASONS['timeout'])
            except (OSError, ValueError, RuntimeError):
                result.update(status='failed', reason=REASONS['network'])
            finally:
                ledger.finish_probe(lease, uncertain=uncertain)
                last_finished = monotonic()
            tested += 1
            result['checkedAt'] = timestamp(clock())
            result['latencyMs'] = min(3600000, max(0, round((monotonic() - before) * 1000)))
            if result['status'] == 'healthy':
                result['consecutiveFailures'] = 0
            elif result['status'] in ('failed', 'timeout'):
                result['consecutiveFailures'] = min(1000000, result['consecutiveFailures'] + 1)
            save(result)
            current_round.append(result)
        if not current_round and old.get('lastRunAt'):
            return {'ok': True, 'dryRun': False, 'candidateCount': len(candidates), 'tested': 0}
        state['history'] = safe_history([*state['history'], {'runAt': timestamp(started),
            **{status: sum(result['status'] == status for result in current_round) for status in STORED_STATUSES}}], clock())
        state['results'] = [results[channel['id']] for channel in channels if channel['id'] in results][:MAX_CHANNELS]
        write_state(state_directory, state)
        return {'ok': True, 'dryRun': False, 'candidateCount': len(candidates), 'tested': tested}

    try:
        if dry_run:
            return execute()
        with round_lock(state_directory):
            return execute()
    finally:
        client.logout()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Read eligible channels without sending inference or changing state')
    args = parser.parse_args()
    try:
        result = run_checks(dry_run=args.dry_run)
    except AlreadyRunning:
        result = {'ok': True, 'skipped': True, 'reason': '已有巡检正在运行。'}
    except Exception:
        # Native failures can include upstream credentials. Never print exceptions.
        print(json.dumps({'ok': False, 'reason': '渠道巡检未完成，请检查本地服务状态。'}, ensure_ascii=False))
        raise SystemExit(1) from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
