#!/usr/bin/env python3
"""Stage enabled desktop API channels through SSH without exporting credentials.

Subscription/OAuth accounts and the public bridge allowlist are left untouched.
Run with --apply to create disabled channels, then --test to exercise their
OpenAI Chat endpoint using New API's bounded, administrator-only channel test.
"""
import argparse
import json
from pathlib import Path
import sqlite3

from migrate import remote


STAGE = r'''
owned()
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard
import urllib.request, urllib.error
client = Dashboard()
client.login()
manifest_path = ROOT / 'desktop-channel-import.json'
previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
existing = client.request('/api/channel/')['items']
for source in payload['channels']:
    if any(c['source_id'] == source['id'] for c in previous.get('channels', [])):
        raise RuntimeError('Selected source already imported; inspect it instead of replacing credentials')
    if any(c['name'] == 'Desktop Preview - ' + source['name'] for c in existing):
        raise RuntimeError('Selected channel name already exists; it will not be overwritten')
policy_before = (ROOT / 'bridge-policy.json').read_bytes()
if json.loads(policy_before)['models']:
    raise RuntimeError('Stage imports only while the public model catalog is closed')
prepared, missing = [], []
for source in payload['channels']:
    base = source['baseUrl'].rstrip('/')
    if base.endswith('/v1'):
        base = base[:-3]
    request = urllib.request.Request(base + '/v1/models', headers={
        'Authorization': 'Bearer ' + source['apiKey'],
        'User-Agent': 'LoliCodeRelayImport/1.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        listed = {x['id'] for x in json.load(response)['data']}
    selected, mapping = [], {}
    for model in source['models']:
        model_id = model['id']
        candidate = payload['aliases'].get(model_id)
        if model_id in listed:
            selected.append(model_id)
        elif candidate and candidate in listed:
            selected.append(model_id)
            mapping[model_id] = candidate
        else:
            missing.append({'source': source['name'], 'model': model_id,
                            'reason': 'not_listed_by_upstream'})
    if not selected:
        raise RuntimeError('No enabled model is available for a selected API source')
    prepared.append((source, base, selected, mapping))
backup = json.loads(run(['python3', str(ROOT / 'backup.py')]))
options = {o['key']: o['value'] for o in client.request('/api/option/')}
ratios = json.loads(options['ModelRatio'])
added_ratios = []
for _, _, selected, mapping in prepared:
    for model_id in selected + list(mapping.values()):
        if model_id not in ratios:
            # Private test accounting units, not a claim about upstream prices.
            ratios[model_id] = 1
            added_ratios.append(model_id)
if added_ratios:
    client.request('/api/option/', {'key': 'ModelRatio',
                   'value': json.dumps(ratios)}, 'PUT')
receipt = {**previous, 'created_at': previous.get('created_at', datetime.now(timezone.utc).isoformat()),
           'desktop_revision': payload['revision'], 'backup': backup['backup'],
           'public_catalog_open': False, 'channels': previous.get('channels', []),
           'skipped': previous.get('skipped', []) + missing,
           'internal_ratio_unit': 1,
           'added_ratio_models': previous.get('added_ratio_models', []) + added_ratios}
for source, base, selected, mapping in prepared:
    name = 'Desktop Preview - ' + source['name']
    client.request('/api/channel/', {'mode': 'single', 'channel': {
        'name': name, 'type': 1, 'key': source['apiKey'], 'status': 2,
        'models': ','.join(selected), 'group': 'default', 'base_url': base,
        'model_mapping': json.dumps(mapping), 'test_model': selected[0],
        'remark': 'Desktop preview only; public bridge closed. Ratio=internal units, not upstream price.'}})
    rows = [x for x in client.request('/api/channel/')['items'] if x['name'] == name]
    if len(rows) != 1 or rows[0]['status'] != 2:
        raise RuntimeError('Imported channel is not uniquely staged and disabled')
    receipt['channels'].append({'id': rows[0]['id'], 'name': name,
        'source_id': source['id'], 'models': selected, 'mapping': mapping,
        'status': rows[0]['status']})
    manifest_path.write_text(json.dumps(receipt, indent=2) + '\n')
    manifest_path.chmod(0o600)
assert (ROOT / 'bridge-policy.json').read_bytes() == policy_before
emit(receipt)
'''

TEST = r'''
owned()
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard, BASE
import urllib.request, urllib.parse, urllib.error, time
client = Dashboard()
client.login()
manifest_path = ROOT / 'desktop-channel-import.json'
receipt = json.loads(manifest_path.read_text())
policy_before = (ROOT / 'bridge-policy.json').read_bytes()
if json.loads(policy_before)['models']:
    raise RuntimeError('Preview checks require the public model catalog to remain closed')
tests = receipt.get('tests', [])
tested = {(t['channel_id'], t['model']) for t in tests}
for channel in receipt['channels']:
    for model_id in channel['models']:
        if (channel['id'], model_id) in tested:
            continue
        query = urllib.parse.urlencode({'model': model_id,
                                      'endpoint_type': 'openai', 'stream': 'false'})
        path = '/api/channel/test/' + str(channel['id']) + '?' + query
        request = urllib.request.Request(BASE + path, headers={
            'Authorization': 'Bearer ' + client.token,
            'User-Agent': 'LoliCodeRelayImport/1.0'})
        start = time.monotonic()
        row = {'channel_id': channel['id'], 'model': model_id}
        try:
            with client.opener.open(request, timeout=45) as response:
                result = json.load(response)
            row['success'] = result.get('success') is True
            row['error_code'] = result.get('error_code')
            if not row['success']:
                # Upstream errors may echo credentials; do not copy their text.
                message = str(result.get('message', '')).lower()
                row['error_class'] = ('unknown_model' if any(s in message for s in
                    ('not found', 'invalid model', 'not exist', 'unknown model')) else
                    'authentication' if any(s in message for s in ('unauthorized', 'authentication', 'api key')) else
                    'upstream_or_adapter_error')
        except urllib.error.HTTPError as error:
            row.update(success=False, http_status=error.code)
        except Exception as error:
            row.update(success=False, error_class=type(error).__name__)
        row['seconds'] = round(time.monotonic() - start, 2)
        tests.append(row)
        receipt['tests'] = tests
        manifest_path.write_text(json.dumps(receipt, indent=2) + '\n')
assert (ROOT / 'bridge-policy.json').read_bytes() == policy_before
emit({'tests': tests, 'public_catalog_open': False, 'channels_remain_disabled': True})
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path,
                        default=Path.home() / '.tai-switch' / 'cc-switch.db')
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--source-id', action='append', default=[],
                        help='Import only these desktop channel IDs')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--apply', action='store_true')
    action.add_argument('--test', action='store_true')
    args = parser.parse_args()
    if args.test:
        result = remote(args.host, TEST, timeout=900)
    else:
        with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
            row = db.execute("SELECT value FROM settings WHERE key='channel_center'").fetchone()
        if not row:
            raise RuntimeError('No desktop channel catalog found')
        snapshot = json.loads(row[0])
        channels = []
        for channel in snapshot['channels']:
            if args.source_id and channel['id'] not in args.source_id:
                continue
            if not channel.get('enabled') or channel.get('authKind') != 'api_key':
                continue
            if channel['protocol'] != 'openai_chat' or not channel.get('apiKey'):
                continue
            channels.append({**channel, 'models': [m for m in channel['models']
                             if m.get('enabled') is not False]})
        if not channels:
            raise RuntimeError('No enabled API-key Chat channels found')
        aliases = {'claude-gpt-6-astra': 'gpt-6-astra',
                   'claude-gpt-6.1-sol': 'gpt-6.1-sol',
                   'xiaomi/mimo-v2.6-pro': 'mimo-v2.6-pro'}
        result = remote(args.host, STAGE, {'revision': snapshot['revision'],
                        'channels': channels, 'aliases': aliases})
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
