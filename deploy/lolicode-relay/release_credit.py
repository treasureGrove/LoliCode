#!/usr/bin/env python3
"""Stage, test and selectively publish Credit without replacing live account data."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

from migrate import remote

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SOURCES = ('bridge.py', 'credit_meter.py', 'public_settings.py', 'web_account.py',
           'manage_quota.py', 'backup.py', 'verify_public_settings.py', 'test_credit_meter.py',
           'test_credit_bridge.py', 'test_bridge.py', 'test_web_account.py', 'test_public_settings.py')
PORTAL = ('account.css', 'account.html', 'account.js', 'index.html', 'portal.js',
          'public-settings.css', 'public-settings.html', 'public-settings.js')
TESTS = ('test_credit_meter', 'test_credit_bridge', 'test_bridge', 'test_web_account', 'test_public_settings')


PREPARE = r'''
owned()
import fcntl, sqlite3
lock = (ROOT / '.credit-release.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
release = ROOT / 'credit-releases' / payload['release']
if release.exists() or release.is_symlink() or release.parent.is_symlink():
    raise RuntimeError('Release already exists or path is unsafe')
release.parent.mkdir(mode=0o700, exist_ok=True)
release.mkdir(mode=0o700)
stage = release / 'candidate'
previous = release / 'previous'
stage.mkdir(mode=0o700)
previous.mkdir(mode=0o700)
web = pathlib.Path('/var/www/lolicode-relay-public')
if web.is_symlink() or (ROOT / 'portal-source').is_symlink():
    raise RuntimeError('Unexpected portal path')
if (ROOT / '.lolicode-relay-portal-owned').read_text().strip() != 'lolicode-relay-portal-v1':
    raise RuntimeError('Portal ownership is required')
manifest = {'release': payload['release'], 'targets': {}, 'tests': payload['tests']}
for relative, entry in payload['files'].items():
    target = (web / relative[7:] if relative.startswith('public/') else
              pathlib.Path('/etc/systemd/system') / relative[8:] if relative.startswith('systemd/') else
              pathlib.Path('/etc/nginx/sites-available/lolicode-relay-admin.conf') if relative == 'nginx/relay.conf' else ROOT / relative)
    if target.is_symlink():
        raise RuntimeError('Unexpected target symlink: ' + relative)
    exists = target.is_file()
    old = target.read_text() if exists else None
    if (hashlib.sha256(old.encode()).hexdigest() if exists else None) != entry['baseline']:
        raise RuntimeError('Live source differs from reviewed baseline: ' + relative)
    candidate = stage / relative
    candidate.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    candidate.write_text(entry['content'])
    candidate.chmod(0o600)
    if exists:
        saved = previous / relative
        saved.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(target, saved)
    manifest['targets'][relative] = {
        'path': str(target), 'before': hashlib.sha256(target.read_bytes()).hexdigest() if exists else None,
        'after': hashlib.sha256(candidate.read_bytes()).hexdigest()}
settings = ROOT / 'bridge-state/public-settings.json'
manifest['settings_before'] = hashlib.sha256(settings.read_bytes()).hexdigest() if settings.exists() else None
manifest['policy_before'] = hashlib.sha256((ROOT / 'bridge-policy.json').read_bytes()).hexdigest()
run(['python3', '-W', 'ignore', '-m', 'unittest', '-q', *payload['tests']], cwd=stage)
if payload.get('health_units'):
    run(['systemd-analyze', 'verify', str(stage / 'systemd/lolicode-relay-health.service'),
         str(stage / 'systemd/lolicode-relay-health.timer')])
    manifest['health_dry_run'] = json.loads(run(['python3', str(stage / 'channel_health.py'), '--dry-run'], cwd=stage))
if payload.get('nginx'):
    main = pathlib.Path('/etc/nginx/nginx.conf').read_text()
    needle = 'include /etc/nginx/sites-enabled/*;'
    if main.count(needle) != 1:
        raise RuntimeError('Unexpected Nginx site include; preserve configuration')
    preview = release / 'nginx-preview.conf'
    preview.write_text(main.replace(needle, 'include ' + str(stage / 'nginx/relay.conf') + ';'))
    run(['nginx', '-t', '-c', str(preview)])
database = ROOT / 'bridge-state/bridge.sqlite3'
snapshot = release / 'migration-check.sqlite3'
with sqlite3.connect(database) as source, sqlite3.connect(snapshot) as destination:
    source.backup(destination)
probe = """
import json, sqlite3, sys
from bridge import Ledger, active_models
from public_settings import PublicSettings
from credit_meter import credit_value, daily_credit_units
path=sys.argv[1]
with sqlite3.connect(path) as db:
    before=db.execute('SELECT id,forum_id,day,reserved,charged,state,model,created_at FROM requests ORDER BY id').fetchall()
    columns={r[1] for r in db.execute('PRAGMA table_info(requests)')}
    history_columns=sorted(columns-{'credit_reserved','credit_charged'})
    history_query='SELECT '+','.join('"'+column.replace('"','""')+'"' for column in history_columns)+' FROM requests ORDER BY id'
    history_before=db.execute(history_query).fetchall()
    account_columns=[r[1] for r in db.execute('PRAGMA table_info(accounts)')]
    account_query='SELECT '+','.join('"'+column.replace('"','""')+'"' for column in account_columns)+' FROM accounts ORDER BY forum_id'
    accounts_before=db.execute(account_query).fetchall()
    if 'credit_charged' in columns:
        credit_before=db.execute('SELECT id,coalesce(credit_reserved,reserved*1000),coalesce(credit_charged,charged*1000) FROM requests ORDER BY id').fetchall()
    else:
        credit_before=[(r[0],r[3]*1000,r[4]*1000) for r in before]
Ledger(path)
Ledger(path)
with sqlite3.connect(path) as db:
    assert before==db.execute('SELECT id,forum_id,day,reserved,charged,state,model,created_at FROM requests ORDER BY id').fetchall()
    assert credit_before==db.execute('SELECT id,credit_reserved,credit_charged FROM requests ORDER BY id').fetchall()
    assert history_before==db.execute(history_query).fetchall()
    assert accounts_before==db.execute(account_query).fetchall()
    assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
policy=json.load(open(sys.argv[2], encoding='utf8'))
manager=PublicSettings(policy, sys.argv[3])
assert not manager.configuration_error
global_units=daily_credit_units(policy,global_pool=True)
print(json.dumps({'records':len(before),'dailyCredits':credit_value(daily_credit_units(policy)),
                 'globalDailyCredits':credit_value(global_units) if global_units is not None else None,
                 'ready':bool(active_models(policy)), 'modelCount':len(active_models(policy)),
                 'models':manager.settings['modelIds'],'history_columns_preserved':history_columns,
                 'accounts_preserved':len(accounts_before)}))
"""
validated = json.loads(run(['python3', '-c', probe, str(snapshot), str(ROOT / 'bridge-policy.json'),
                            str(settings.parent)], cwd=stage))
manifest['migration'] = validated
(release / 'manifest.json').write_text(json.dumps(manifest, indent=2))
emit({'prepared': True, 'release': payload['release'], 'isolated_tests_passed': True,
      'migration_verified': validated, 'live_data_changed': False})
'''


APPLY = r'''
owned()
import fcntl, sqlite3, time, urllib.request, urllib.error
lock = (ROOT / '.credit-release.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
release = ROOT / 'credit-releases' / payload['release']
if release.is_symlink() or release.parent.is_symlink():
    raise RuntimeError('Unexpected release path')
manifest = json.loads((release / 'manifest.json').read_text())
if (release / 'applied.json').exists():
    raise RuntimeError('This release was already applied')
stage = release / 'candidate'
state = ROOT / 'bridge-state'
settings = state / 'public-settings.json'
database = state / 'bridge.sqlite3'
def digest(path):
    if path.is_symlink(): raise RuntimeError('Unexpected target symlink')
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
def preflight():
    for relative, item in manifest['targets'].items():
        if digest(pathlib.Path(item['path'])) != item['before'] or digest(stage / relative) != item['after']:
            raise RuntimeError('Source changed after isolated validation: ' + relative)
    if digest(settings) != manifest['settings_before']:
        raise RuntimeError('Operator settings changed; prepare a fresh release')
    if digest(ROOT / 'bridge-policy.json') != manifest['policy_before']:
        raise RuntimeError('Operator base policy changed; prepare a fresh release')
    with sqlite3.connect(database) as db:
        if db.execute("SELECT count(*) FROM requests WHERE state='pending'").fetchone()[0]:
            raise RuntimeError('Active inference exists; retry after it completes')
        if db.execute("SELECT count(*) FROM sqlite_master WHERE name='channel_probes'").fetchone()[0]:
            if db.execute("SELECT count(*) FROM channel_probes WHERE state='pending' AND expires_at>?", (time.time(),)).fetchone()[0]:
                raise RuntimeError('An active connectivity probe exists; retry after completion')
preflight()
if run(['systemctl', 'is-active', 'lolicode-relay-bridge.service']).strip() != b'active':
    raise RuntimeError('The existing bridge must be healthy before replacement')
backup = json.loads(run(['python3', str(ROOT / 'backup.py')]))
preflight()
mutated = []
stopped = False
def publish(path, data, mode):
    # New owned modules may introduce nested attribution/source directories.
    # Create only ancestors inside ROOT and reject any symlink at each level.
    if path.is_relative_to(ROOT):
        parent = ROOT
        for component in path.relative_to(ROOT).parts[:-1]:
            parent = parent / component
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                raise RuntimeError('Unexpected publish parent: ' + str(parent))
            parent.mkdir(mode=0o700, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.credit-new')
    if temporary.exists() or temporary.is_symlink(): raise RuntimeError('Unexpected staging file')
    try:
        with temporary.open('xb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary.is_file() and not temporary.is_symlink(): temporary.unlink()
def http(url, token=None):
    headers = {'User-Agent': 'LoliCodeCreditAcceptance/1.0'}
    if token: headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()
try:
    run(['systemctl', 'stop', 'lolicode-relay-bridge.service'])
    stopped = True
    preflight()
    for relative, item in manifest['targets'].items():
        path = pathlib.Path(item['path'])
        publish(path, (stage / relative).read_bytes(), 0o644 if relative.startswith(('public/', 'systemd/', 'nginx/')) else 0o600)
        mutated.append(relative)
    if payload.get('health_units'):
        run(['systemctl', 'daemon-reload'])
    if payload.get('nginx'):
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    run(['systemctl', 'start', 'lolicode-relay-bridge.service'])
    stopped = False
    for attempt in range(30):
        try:
            if json.loads(http('http://127.0.0.1:13001/health')).get('ok') is True: break
        except (OSError, ValueError):
            if attempt == 29: raise RuntimeError('Credit bridge did not become healthy') from None
            time.sleep(0.25)
    else:
        raise RuntimeError('Credit bridge did not become healthy')
    public = json.loads(http('https://relay.lolicode.com/community-status'))
    if public.get('creditUnit') != 'Credit' or public.get('dailyCredits') != manifest['migration']['dailyCredits']:
        raise RuntimeError('Public Credit configuration differs from validated settings')
    if (public.get('limits', {}).get('globalDailyCredits') != manifest['migration']['globalDailyCredits']
            or public.get('ready') != manifest['migration']['ready']
            or public.get('modelCount') != manifest['migration']['modelCount']):
        raise RuntimeError('Global Credit allowance or model availability changed')
    for relative, item in manifest['targets'].items():
        if digest(pathlib.Path(item['path'])) != item['after']:
            raise RuntimeError('Published source mismatch')
        if relative.startswith('public/'):
            served = http('https://relay.lolicode.com/relay-assets/' + relative[7:] + '?credit=' + item['after'][:12])
            if hashlib.sha256(served).hexdigest() != item['after']:
                raise RuntimeError('Public Credit asset mismatch: ' + relative)
    with sqlite3.connect(database) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok': raise RuntimeError('Ledger quick_check failed')
        count = db.execute('SELECT count(*) FROM requests').fetchone()[0]
    if digest(settings) != manifest['settings_before']:
        raise RuntimeError('Settings changed during deployment; preserve operator changes')
    receipt = {'release': payload['release'], 'deployed': True, 'backup': backup['backup'],
               'isolated_tests_passed': True, 'ledger_records': count, 'creditUnit': 'Credit',
               'dailyCredits': public['dailyCredits'], 'models': manifest['migration']['models'],
               'real_model_calls': 0, 'settings_preserved': True, 'nginx_unchanged': not payload.get('nginx', False),
               'health_units_installed': payload.get('health_units', False),
               'published_files': len(manifest['targets'])}
    (release / 'applied.json').write_text(json.dumps(receipt, indent=2))
    (ROOT / 'credit-release-verification.json').write_text(json.dumps(receipt, indent=2))
    emit(receipt)
except Exception:
    # Never restore a database. The additive columns do not remove legacy data.
    # Refuse a configuration rollback over a concurrent administrator edit.
    if digest(settings) != manifest['settings_before']:
        if stopped and not mutated:
            run(['systemctl', 'start', 'lolicode-relay-bridge.service'])
        raise RuntimeError('Deployment requires attention; administrator settings preserved, no data rollback') from None
    if mutated:
        run(['systemctl', 'stop', 'lolicode-relay-bridge.service'])
        stopped = True
        for relative in reversed(mutated):
            item = manifest['targets'][relative]
            path = pathlib.Path(item['path'])
            if digest(path) != item['after']:
                raise RuntimeError('Concurrent source change preserved; automatic restore refused') from None
            saved = release / 'previous' / relative
            if item['before'] is None:
                path.unlink()
            else:
                publish(path, saved.read_bytes(), 0o644 if relative.startswith(('public/', 'systemd/', 'nginx/')) else 0o600)
        if payload.get('health_units'):
            run(['systemctl', 'daemon-reload'])
        if payload.get('nginx'):
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
    if stopped:
        run(['systemctl', 'start', 'lolicode-relay-bridge.service'])
    raise
'''


def baseline(relative):
    result = subprocess.run(['git', 'show', 'HEAD:deploy/lolicode-relay/' + relative],
                            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return None if result.returncode else hashlib.sha256(
        result.stdout.decode('utf8').replace('\r\n', '\n').encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply'))
    parser.add_argument('--host', default='lolicode')
    parser.add_argument('--release', default='credit-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    args = parser.parse_args()
    if not re.fullmatch(r'credit-\d{8}T\d{6}Z', args.release):
        parser.error('Use the fixed credit-YYYYMMDDTHHMMSSZ release identifier')
    payload = {'release': args.release}
    if args.action == 'prepare':
        files = {}
        for name in SOURCES:
            files[name] = {'content': (HERE / name).read_text(encoding='utf8'), 'baseline': baseline(name)}
        for name in PORTAL:
            entry = {'content': (HERE / 'portal' / name).read_text(encoding='utf8'),
                     'baseline': baseline('portal/' + name)}
            files['public/' + name] = entry
            files['portal-source/' + name] = entry
        payload.update(files=files, tests=TESTS)
    result = remote(args.host, PREPARE if args.action == 'prepare' else APPLY, payload, timeout=600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
