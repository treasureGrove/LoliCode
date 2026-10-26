#!/usr/bin/env python3
"""Open only GLM Flash through forum auth with strict shared trial ceilings."""
import json

from migrate import remote


OPEN = r'''
owned()
sys.path.insert(0, str(ROOT))
from bootstrap import Dashboard
import time, urllib.request
from datetime import timedelta
client = Dashboard()
client.login()
activation = ROOT / 'glm-trial-activation.json'
if activation.exists():
    raise RuntimeError('A trial activation exists; inspect the live policy before changing it')
source = json.loads((ROOT / 'desktop-subscription-preview.json').read_text())
glm = next(c for c in source['channels'] if c['kind'] == 'glm')
expiry = datetime.fromisoformat(glm['expires_at'])
deadline = expiry - timedelta(seconds=330)
if deadline <= datetime.now(timezone.utc) + timedelta(minutes=10):
    raise RuntimeError('Trial authorization is too close to expiry; obtain a fresh token first')
channels = client.request('/api/channel/')['items']
channel = next(c for c in channels if c['id'] == glm['id'])
if channel['type'] != 8 or channel['status'] != 2 or any(c['status'] == 1 for c in channels):
    raise RuntimeError('Expected only disabled preview channels before opening this trial')
if channel['base_url'] != 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions':
    raise RuntimeError('Unexpected GLM upstream endpoint')
policy_path = ROOT / 'bridge-policy.json'
old_policy = policy_path.read_bytes()
policy = json.loads(old_policy)
if policy['models']:
    raise RuntimeError('Another model catalog is already open')
if 'service_daily_tokens_exhausted' not in (ROOT / 'bridge.py').read_text():
    raise RuntimeError('Deploy the bridge with global accounting before opening the trial')
backup = json.loads(run(['python3', str(ROOT / 'backup.py')]))
policy.update({'daily_requests': 20, 'daily_tokens': 100000, 'max_output_tokens': 4096,
    'max_request_bytes': 131072, 'max_concurrent_per_account': 1,
    'max_concurrent_global': 1, 'global_requests_per_minute': 6,
    'global_daily_requests': 200, 'global_daily_tokens': 1000000,
    'available_until': deadline.isoformat(), 'models': [{
        'id': 'glm-5.3-flash', 'name': 'GLM 5.3 Flash（公益试用）',
        'contextLimit': 32768, 'outputLimit': 4096,
        'supportsTools': True, 'inputModalities': ['text'], 'protocol': 'openai_chat'}]})
patch = {'id': channel['id'], 'type': channel['type'], 'name': channel['name'],
         'group': channel['group'], 'base_url': channel['base_url'],
         'models': 'glm-5.3-flash', 'test_model': 'glm-5.3-flash',
         'remark': 'Forum-authenticated Flash trial only; shared daily and concurrency ceilings in bridge.'}
def save_policy(value):
    temporary = ROOT / '.bridge-policy.trial.tmp'
    temporary.write_bytes(value)
    temporary.chmod(0o600)
    os.replace(temporary, policy_path)
try:
    client.request('/api/channel/', patch, 'PUT')
    client.request('/api/channel/' + str(channel['id']) + '/status', {'status': 1}, 'POST')
    save_policy((json.dumps(policy, indent=2, ensure_ascii=False) + '\n').encode())
    run(['systemctl', 'restart', 'lolicode-relay-bridge'])
    for attempt in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:13001/public/status', timeout=2) as response:
                status = json.load(response)
            if status['ready'] and status['modelCount'] == 1:
                break
        except OSError:
            pass
        if attempt == 19:
            raise RuntimeError('Trial bridge did not become healthy')
        time.sleep(0.5)
except Exception:
    client.request('/api/channel/' + str(channel['id']) + '/status', {'status': 2}, 'POST')
    client.request('/api/channel/', {**patch, 'models': channel['models'],
                   'remark': channel.get('remark', '')}, 'PUT')
    save_policy(old_policy)
    run(['systemctl', 'restart', 'lolicode-relay-bridge'])
    raise
receipt = {'activated_at': datetime.now(timezone.utc).isoformat(),
    'backup': backup['backup'], 'channel_id': channel['id'],
    'model': 'glm-5.3-flash', 'policy': policy,
    'upstream_authorization_expires_at': glm['expires_at'], 'status': status}
activation.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n')
activation.chmod(0o600)
emit(receipt)
'''


if __name__ == '__main__':
    print(json.dumps(remote('lolicode', OPEN), ensure_ascii=True))
