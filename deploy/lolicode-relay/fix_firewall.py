#!/usr/bin/env python3
"""Stop treating the legitimate Flarum/New API token route as an exploit probe."""
import argparse
from migrate import remote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='lolicode')
    args = parser.parse_args()
    print(remote(args.host, r'''
owned()
client_ip = os.environ.get('SSH_CONNECTION', '').split()[0]
import ipaddress
ipaddress.ip_address(client_ip)
target = pathlib.Path('/etc/fail2ban/filter.d/nginx-exploit.conf')
if target.is_symlink():
    raise RuntimeError('Unexpected exploit filter path')
original = target.read_text()
branch = r'|/api/token\b'
if original.count(branch) not in (0, 1):
    raise RuntimeError('Ambiguous token-route rule')
updated = original.replace(branch, '').replace('\u3001/api/token', '')
if branch in original:
    updated += '\n# /api/token is used by Flarum login and New API key management.\n# Authentication failures there are not evidence of an exploit scan.\n'
good = [('/api/token/', 200), ('/api/token/?p=0', 200), ('/api/token/1/key', 401),
        ('/api/token', 200), ('/api/user/self', 200), ('/security', 200)]
bad = [('/.env', 404), ('/.git/config', 404), ('/wp-admin/', 200),
       ('/api/.git/config', 403), ('/config.php', 404)]
fixture = ROOT / 'firewall-regression.log'
candidate = ROOT / 'nginx-exploit.fixed.conf'
for path in (fixture, candidate):
    if path.is_symlink():
        raise RuntimeError('Unexpected firewall fixture symlink')
candidate.write_text(updated)
candidate.chmod(0o600)
stamp = datetime.now().astimezone().strftime('%d/%b/%Y:%H:%M:%S %z')
def matches(rows):
    fixture.write_text(''.join('203.0.113.20 - - [' + stamp + '] "GET ' + path +
                             ' HTTP/1.1" ' + str(status) + ' 100 "-" "LoliCode regression"\n'
                             for path, status in rows))
    fixture.chmod(0o600)
    result = run(['fail2ban-regex', str(fixture), str(candidate)]).decode()
    match = re.search(r'Lines:\s*\d+ lines,\s*\d+ ignored,\s*(\d+) matched,', result)
    if not match:
        raise RuntimeError('Could not read fail2ban regression results')
    return int(match.group(1))
if matches(good) != 0 or matches(bad) != len(bad):
    raise RuntimeError('Firewall regression failed; live rule unchanged')
if updated != original:
    backup = ROOT / ('nginx-exploit.pre-relay-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.conf')
    with backup.open('x') as output:
        output.write(original)
    backup.chmod(0o600)
    target.write_text(updated)
    try:
        run(['fail2ban-client', '-t'])
        run(['fail2ban-client', 'reload', 'nginx-exploit'])
    except Exception:
        target.write_text(original)
        run(['fail2ban-client', 'reload', 'nginx-exploit'])
        raise
status = run(['fail2ban-client', 'status', 'nginx-exploit']).decode()
match = re.search(r'Banned IP list:\s*(.*)', status)
banned = match.group(1).split() if match else []
was_banned = client_ip in banned
if was_banned:
    run(['fail2ban-client', 'set', 'nginx-exploit', 'unbanip', client_ip])
status = run(['fail2ban-client', 'status', 'nginx-exploit']).decode()
match = re.search(r'Banned IP list:\s*(.*)', status)
if match and client_ip in match.group(1).split():
    raise RuntimeError('Current administrator is still blocked')
emit({'legitimate_route_false_positives': 0, 'scanner_cases_blocked': len(bad),
      'current_client_unbanned': was_banned, 'other_bans_retained': len([ip for ip in banned if ip != client_ip]),
      'fail2ban_enabled': True, 'filter_changed': updated != original})
'''))


if __name__ == '__main__':
    main()
