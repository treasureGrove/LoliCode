#!/usr/bin/env python3
"""Link public registration to Flarum's existing native sign-up dialog."""
import json
from pathlib import Path

from migrate import remote


INSTALL = r"""
owned()
marker = ROOT / '.lolicode-forum-account-entry-owned'
asset = pathlib.Path('/var/www/forum/public/assets/lolicode-account-entry.js')
if marker.is_symlink() or asset.is_symlink() or asset.parent.is_symlink():
    raise RuntimeError('Unexpected account-entry path')
if not asset.parent.is_dir() or asset.parent.resolve() != pathlib.Path('/var/www/forum/public/assets'):
    raise RuntimeError('Expected existing forum asset directory')
if asset.exists() and not marker.exists():
    raise RuntimeError('Preserve the existing unowned account-entry script')
if marker.exists() and marker.read_text().strip() != 'lolicode-forum-account-entry-v1':
    raise RuntimeError('Unrecognized account-entry ownership')
php = r'''
$input=json_decode(stream_get_contents(STDIN),true,32,JSON_THROW_ON_ERROR);
$site=require '/var/www/forum/site.php';$site->bootApp();
$settings=resolve('flarum.settings');$header=(string)$settings->get('custom_header','');
if($input['action']==='read'){
 echo json_encode(['header'=>$header,'signup_enabled'=>$settings->get('allow_sign_up')]);
}elseif($input['action']==='write'){
 if(hash('sha256',$header)!==$input['expected_sha256']){throw new RuntimeException('Header changed concurrently');}
 $settings->set('custom_header',$input['header']);echo json_encode(['ok'=>true]);
}else{throw new RuntimeException('Unknown action');}
'''
def setting(action, **data):
    result = subprocess.run(['runuser','-u','www-data','--','php','-r',php],
        input=json.dumps({'action':action,**data}).encode(), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,timeout=30)
    if result.returncode:
        raise RuntimeError('Forum account-entry setting update failed; no credentials printed')
    return json.loads(result.stdout)
state = setting('read')
if str(state['signup_enabled']) != '1':
    raise RuntimeError('Community registration is disabled; do not enable it implicitly')
original = state['header']
tag = '<!-- lolicode-forum-account-entry-v1 -->'
addition = tag + '\n<script src="/assets/lolicode-account-entry.js?v=20261021-2"></script>'
if tag in original:
    updated = original.replace('/assets/lolicode-account-entry.js?v=20261021-1',
                               '/assets/lolicode-account-entry.js?v=20261021-2')
    if '/assets/lolicode-account-entry.js?v=20261021-2' not in updated:
        raise RuntimeError('Preserve operator changes to the forum account-entry header')
else:
    updated = original + '\n' + addition + '\n'
backup = json.loads(run(['python3',str(ROOT/'backup.py')]))
original_backup = ROOT/'forum-custom-header.pre-account-entry.html'
if original_backup.is_symlink():
    raise RuntimeError('Unexpected forum header backup path')
if not original_backup.exists():
    original_backup.write_text(original);original_backup.chmod(0o600)
previous_asset = asset.read_bytes() if asset.exists() else None
changed = False
try:
    asset.write_text(payload['source']);asset.chmod(0o644)
    if updated != original:
        setting('write',expected_sha256=hashlib.sha256(original.encode()).hexdigest(),header=updated)
        changed = True
    import urllib.request
    with urllib.request.urlopen('https://lolicode.com/all?account=register',timeout=20) as response:
        html=response.read().decode()
    if '/assets/lolicode-account-entry.js?v=20261021-2' not in html:
        raise RuntimeError('Community page does not expose the managed account-entry script')
    with urllib.request.urlopen('https://lolicode.com/assets/lolicode-account-entry.js?v=20261021-2',timeout=10) as response:
        if response.read().decode()!=payload['source']:
            raise RuntimeError('Community account-entry asset mismatch')
except Exception:
    if changed:
        current=setting('read')['header']
        if current==updated:
            setting('write',expected_sha256=hashlib.sha256(current.encode()).hexdigest(),header=original)
    if previous_asset is None:
        if asset.is_file():asset.unlink()
    else:
        asset.write_bytes(previous_asset)
    raise
(ROOT/'forum-account-entry.js').write_text(payload['source'])
(ROOT/'forum-account-entry.js').chmod(0o600)
marker.write_text('lolicode-forum-account-entry-v1\n');marker.chmod(0o600)
emit({'installed':True,'community_registration_enabled':True,
      'entry':'https://lolicode.com/all?account=register','existing_identity_preserved':True,
      'no_signup_submitted':True,'backup':backup['backup']})
"""


if __name__ == '__main__':
    source = (Path(__file__).resolve().parent / 'forum-account-entry.js').read_text(encoding='utf-8')
    print(json.dumps(remote('lolicode', INSTALL, {'source': source}), ensure_ascii=True))
