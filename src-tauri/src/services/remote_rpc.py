"""LoliCode's bounded POSIX tool protocol, executed through SSH/WSL stdin.

No model credentials, Agent runtime, persistent daemon or network listener.
The desktop owns tool approval. File operations stay within an opened directory
and reject symlinks; shell commands retain the authenticated user's privileges.
"""
import base64
import contextlib
import errno
import fcntl
import hashlib
import json
import os
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

MAX_REQUEST = 8 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_OUTPUT = 128 * 1024
MAX_IMAGE = 5 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_RESPONSE = 8 * 1024 * 1024
SIGNALLED = False
SKIP = {'.git', 'node_modules', 'target', '.venv', '__pycache__'}
MARKER = b'LOLICODE_REMOTE_RPC_V1:'


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


def reject(code):
    raise Rejected(code)


def exact_input(length):
    result = bytearray()
    while len(result) < length:
        chunk = os.read(0, min(length - len(result), 65536))
        if not chunk:
            reject('INVALID_REQUEST')
        result.extend(chunk)
    return bytes(result)


def text(value, maximum=MAX_FILE, nonempty=False):
    if not isinstance(value, str) or '\0' in value:
        reject('INVALID_REQUEST')
    try:
        size = len(value.encode('utf-8'))
    except UnicodeError:
        reject('INVALID_REQUEST')
    if size > maximum or (nonempty and not value):
        reject('INVALID_REQUEST')
    return value


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        reject('INVALID_REQUEST')


def integer(value, default, maximum):
    if value is None:
        return default
    if type(value) is not int or not 1 <= value <= maximum:
        reject('INVALID_REQUEST')
    return value


def boolean(value, default=False):
    if value is None:
        return default
    if type(value) is not bool:
        reject('INVALID_REQUEST')
    return value


def cancelled():
    # The desktop keeps stdin open until a receipt arrives. EOF/disconnection or
    # a cancellation byte stops command groups, including on a lost SSH channel.
    if SIGNALLED:
        return True
    import select
    ready, _, _ = select.select([0], [], [], 0)
    if ready:
        os.read(0, 1)
        return True
    return False


def checkpoint():
    if cancelled():
        reject('CANCELLED')


def path_parts(path):
    path = text(path, 4096)
    if path.startswith('/') or '\\' in path or any(ord(ch) < 32 for ch in path):
        reject('PATH_OUTSIDE_PROJECT')
    parts = [part for part in path.split('/') if part not in ('', '.')]
    if '..' in parts:
        reject('PATH_OUTSIDE_PROJECT')
    return parts


def directory(root_fd, parts):
    fd = os.dup(root_fd)
    try:
        for part in parts:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


@contextlib.contextmanager
def parent(root_fd, parts):
    if not parts:
        reject('INVALID_REQUEST')
    fd = directory(root_fd, parts[:-1])
    try:
        yield fd, parts[-1]
    finally:
        os.close(fd)


def file_bytes(fd, name, limit=MAX_FILE, absent=False):
    try:
        opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        if absent:
            return None, None
        raise
    try:
        before = os.fstat(opened)
        if not stat.S_ISREG(before.st_mode):
            reject('NOT_REGULAR_FILE')
        if before.st_size > limit:
            reject('FILE_TOO_LARGE')
        chunks = bytearray()
        while len(chunks) <= limit:
            chunk = os.read(opened, min(65536, limit + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(opened)
        if len(chunks) > limit:
            reject('FILE_TOO_LARGE')
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            reject('CONFLICT')
        return bytes(chunks), stat.S_IMODE(before.st_mode) & 0o777
    finally:
        os.close(opened)


def utf8(data):
    try:
        value = data.decode('utf-8')
    except UnicodeError:
        reject('NOT_UTF8')
    if '\0' in value:
        reject('NOT_UTF8')
    return value


def bounded(value):
    data = value.encode('utf-8')
    if len(data) <= MAX_OUTPUT:
        return value, False
    return data[:MAX_OUTPUT].decode('utf-8', errors='ignore') + '\n[output truncated]', True


@contextlib.contextmanager
def write_lock(root, parts):
    # Lock identity survives atomic file replacement. This directory contains
    # only private lock files; no source content or credentials are written here.
    folder = os.path.join(tempfile.gettempdir(), 'lolicode-rpc-' + str(os.getuid()))
    try:
        os.mkdir(folder, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(folder)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        reject('LOCK_UNAVAILABLE')
    lock_dir = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    identity = hashlib.sha256((root + '/' + '/'.join(parts)).encode('utf-8')).hexdigest()
    lock_fd = None
    try:
        lock_fd = os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=lock_dir)
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            reject('LOCK_UNAVAILABLE')
        deadline = time.monotonic() + 10
        while True:
            checkpoint()
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    reject('CONFLICT')
                time.sleep(0.05)
        yield
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(lock_dir)


def replace_file(root, root_fd, parts, operation, args):
    with write_lock(root, parts), parent(root_fd, parts) as (fd, name):
        before_bytes, mode = file_bytes(fd, name, absent=True)
        before = utf8(before_bytes) if before_bytes is not None else None
        if operation == 'write_file':
            expected = args['expected_content']
            if expected is not None:
                text(expected)
            if before != expected:
                reject('CONFLICT')
            after = text(args['content'])
        else:
            if before is None:
                reject('NOT_FOUND')
            old = text(args['old_text'], nonempty=True)
            if before.count(old) != 1:
                reject('CONFLICT')
            after = before.replace(old, text(args['new_text']), 1)
            text(after)
        checkpoint()
        changes = [{'path': '/'.join(parts), 'before': before, 'after': after}]
        if len(json.dumps(changes, ensure_ascii=True).encode('ascii')) > MAX_RESPONSE - 4096:
            reject('FILE_TOO_LARGE')
        temporary = '.lolicode-' + uuid.uuid4().hex + '.tmp'
        created = None
        try:
            created = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(created, 'wb') as stream:
                created = None
                stream.write(after.encode('utf-8'))
                stream.flush()
                if mode is None:
                    mask = os.umask(0)
                    os.umask(mask)
                    mode = 0o666 & ~mask
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            checkpoint()
            current, _ = file_bytes(fd, name, absent=True)
            if current != before_bytes:
                reject('CONFLICT')
            if before_bytes is None:
                os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                os.unlink(temporary, dir_fd=fd)
            else:
                os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            if created is not None:
                os.close(created)
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass
        return {'text': 'Updated ' + '/'.join(parts), 'fileChanges': changes}


def stop_group(process):
    for sig, wait in [(signal.SIGTERM, 0.5), (signal.SIGKILL, 3)]:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
    if process.poll() is None:
        reject('CLEANUP_UNCERTAIN')


def command(root_fd, args):
    work = directory(root_fd, path_parts(args.get('workdir', '.')))
    process = None
    selector = selectors.DefaultSelector()
    output = bytearray()
    truncated = False
    try:
        os.fchdir(work)
        checkpoint()
        process = subprocess.Popen(['/bin/sh', '-c', text(args['command'], 8192, True)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        selector.register(process.stdout, selectors.EVENT_READ, 'output')
        selector.register(0, selectors.EVENT_READ, 'cancel')
        deadline = time.monotonic() + integer(args.get('timeout_seconds'), 30, 120)
        ended = False
        while not ended or process.poll() is None:
            if SIGNALLED:
                stop_group(process)
                reject('CANCELLED')
            if time.monotonic() >= deadline:
                stop_group(process)
                reject('COMMAND_TIMEOUT')
            for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                if key.data == 'cancel':
                    os.read(0, 1)
                    stop_group(process)
                    reject('CANCELLED')
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    selector.unregister(process.stdout)
                    ended = True
                else:
                    remaining = max(0, MAX_OUTPUT - len(output))
                    output.extend(chunk[:remaining])
                    truncated = truncated or len(chunk) > remaining
        return {'text': output.decode('utf-8', errors='replace'), 'exitCode': process.returncode, 'truncated': truncated, 'fileChanges': []}
    finally:
        if process is not None:
            # Also stop descendants still in the original command process group
            # after the shell has exited. This is not a remote OS sandbox.
            stop_group(process)
            if process.stdout:
                process.stdout.close()
        selector.close()
        os.close(work)


def walk_files(root_fd, recursive):
    pending = [(os.dup(root_fd), '')]
    count = 0
    try:
        while pending:
            fd, prefix = pending.pop()
            try:
                names = []
                with os.scandir(fd) as listing:
                    for entry in listing:
                        if entry.name in SKIP:
                            continue
                        names.append(entry.name)
                        if len(names) > MAX_ENTRIES - count:
                            break
                for name in sorted(names):
                    checkpoint()
                    if name in SKIP or any(ord(ch) < 32 for ch in name):
                        continue
                    try:
                        name.encode('utf-8')
                    except UnicodeError:
                        continue
                    count += 1
                    if count > MAX_ENTRIES:
                        return
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    relative = prefix + name
                    kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other'
                    yield fd, name, relative, kind
                    if recursive and kind == 'directory':
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        pending.append((child, relative + '/'))
            finally:
                os.close(fd)
    finally:
        for fd, _ in pending:
            os.close(fd)


def workflow_operation(root, root_fd, operation, args):
    fields(args, ('name', 'document', 'expectedDocument', 'overwrite'))
    name = args.get('name')
    if operation != 'workflow_list':
        name = text(name, 160, True)
        if name in ('.', '..') or any(ch in name for ch in '/\\:') or any(ord(ch) < 32 for ch in name):
            reject('INVALID_REQUEST')
    parts = ['.zcode', 'workflows']
    if operation == 'workflow_save':
        text(args.get('document'), 256 * 1024, True)
        if args.get('overwrite') is True:
            text(args.get('expectedDocument'), 256 * 1024)
        elif 'expectedDocument' in args or args.get('overwrite', False) is not False:
            reject('INVALID_REQUEST')
        # Create only the fixed workflow directories, never arbitrary paths.
        fd = os.dup(root_fd)
        try:
            for component in parts:
                checkpoint()
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
        finally:
            os.close(fd)
        replace_file(root, root_fd, parts + [name + '.md'], 'write_file', {'content': args['document'], 'expected_content': args.get('expectedDocument')})
        return {'ok': True}
    try:
        fd = directory(root_fd, parts)
    except FileNotFoundError:
        if operation == 'workflow_list':
            return {'documents': [], 'truncated': False}
        raise
    try:
        if operation == 'workflow_list':
            documents = []
            size = 0
            truncated = False
            for parent_fd, basename, _, kind in walk_files(fd, False):
                if kind != 'file' or not basename.endswith('.md'):
                    continue
                if len(documents) >= 200:
                    truncated = True
                    break
                try:
                    data, _ = file_bytes(parent_fd, basename, 256 * 1024)
                    entry = {'name': basename[:-3], 'document': utf8(data)}
                except (Rejected, OSError):
                    entry = {'name': basename[:-3], 'error': '文件无法读取、不是 UTF-8 或超过 256 KiB'}
                size += len(json.dumps(entry, ensure_ascii=True).encode('ascii'))
                if size > 4 * 1024 * 1024:
                    truncated = True
                    break
                documents.append(entry)
            return {'documents': documents, 'truncated': truncated}
        if operation == 'workflow_read':
            data, _ = file_bytes(fd, name + '.md', 256 * 1024)
            return {'document': utf8(data)}
        if operation == 'workflow_delete':
            with write_lock(root, parts + [name + '.md']):
                file_bytes(fd, name + '.md', 256 * 1024)
                checkpoint()
                os.unlink(name + '.md', dir_fd=fd)
                os.fsync(fd)
            return {'ok': True}
        reject('UNKNOWN_OPERATION')
    finally:
        os.close(fd)


def project_operation(request):
    operation = request['operation']
    root = text(request.get('root'), 4096, True)
    if not root.startswith('/') or any(ord(ch) < 32 for ch in root):
        reject('INVALID_REQUEST')
    canonical = os.path.realpath(root)
    # A previously selected canonical root must not silently follow a newly
    # inserted symlink to a different project after permission was granted.
    if operation != 'open_project' and canonical != root:
        reject('CONFLICT')
    root = canonical
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        args = request.get('args', {})
        if operation in ('workflow_list', 'workflow_read', 'workflow_save', 'workflow_delete'):
            checkpoint()
            return workflow_operation(root, root_fd, operation, args)
        choices = {
            'open_project': ((), ()),
            'read_file': (('path', 'offset', 'limit'), ('path',)),
            'view_image': (('path',), ('path',)),
            'preview_file': (('path',), ('path',)),
            'list_files': (('path', 'recursive'), ()),
            'search_files': (('path', 'pattern', 'max_results'), ('pattern',)),
            'write_file': (('path', 'content', 'expected_content'), ('path', 'content', 'expected_content')),
            'apply_patch': (('path', 'old_text', 'new_text'), ('path', 'old_text', 'new_text')),
            'run_command': (('command', 'workdir', 'timeout_seconds'), ('command',)),
        }
        if operation not in choices:
            reject('UNKNOWN_OPERATION')
        fields(args, *choices[operation])
        checkpoint()
        if operation == 'open_project':
            return {'root': root, 'name': os.path.basename(root), 'protocolVersion': 1}
        if operation == 'run_command':
            return command(root_fd, args)
        parts = path_parts(args.get('path', '.'))
        if operation in ('write_file', 'apply_patch'):
            return replace_file(root, root_fd, parts, operation, args)
        if operation in ('read_file', 'view_image', 'preview_file'):
            with parent(root_fd, parts) as (fd, name):
                data, _ = file_bytes(fd, name, MAX_FILE if operation == 'read_file' else MAX_IMAGE)
            if operation == 'preview_file':
                return {'base64': base64.b64encode(data).decode('ascii'), 'size': len(data)}
            if operation == 'view_image':
                return {'imageBase64': base64.b64encode(data).decode('ascii'), 'fileChanges': []}
            value = utf8(data)
            offset = integer(args.get('offset'), 1, 2**31)
            limit = integer(args.get('limit'), 200, 2000)
            lines = value.splitlines(keepends=True)
            result, truncated = bounded(''.join(str(index + 1) + ': ' + line for index, line in enumerate(lines) if offset <= index + 1 < offset + limit))
            return {'text': result, 'totalLines': len(lines), 'truncated': truncated, 'fileChanges': []}
        start = directory(root_fd, parts)
        try:
            if operation == 'list_files':
                entries = []
                size = 0
                recursive = boolean(args.get('recursive'))
                for _, _, name, kind in walk_files(start, recursive):
                    size += len(name.encode('utf-8')) + 32
                    if size > MAX_OUTPUT:
                        break
                    entries.append({'path': name, 'kind': kind})
                return {'entries': entries, 'bounded': True, 'fileChanges': []}
            pattern = text(args['pattern'], 4096, True)
            maximum = integer(args.get('max_results'), 100, 500)
            hits = []
            size = 0
            for fd, name, relative, kind in walk_files(start, True):
                if kind != 'file':
                    continue
                try:
                    data, _ = file_bytes(fd, name)
                    value = utf8(data)
                except (Rejected, OSError):
                    continue
                for number, line in enumerate(value.splitlines(), 1):
                    if pattern not in line:
                        continue
                    snippet = line[:500]
                    size += len(snippet.encode('utf-8')) + len(relative.encode('utf-8')) + 64
                    if len(hits) >= maximum or size > MAX_OUTPUT:
                        return {'matches': hits, 'truncated': True, 'fileChanges': []}
                    hits.append({'path': relative, 'line': number, 'text': snippet})
            return {'matches': hits, 'bounded': True, 'fileChanges': []}
        finally:
            os.close(start)
    finally:
        os.close(root_fd)


def execute(request):
    fields(request, ('version', 'requestId', 'operation', 'root', 'args'), ('version', 'requestId', 'operation'))
    if request['version'] != 1 or type(request['version']) is not int:
        reject('INVALID_REQUEST')
    text(request['requestId'], 64, True)
    if os.name != 'posix' or sys.version_info < (3, 9):
        reject('UNSUPPORTED_PLATFORM')
    if request['operation'] == 'probe':
        if request.get('args', {}) or request.get('root') is not None:
            reject('INVALID_REQUEST')
        return {'protocolVersion': 1, 'platform': sys.platform, 'architecture': os.uname().machine, 'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'home': os.path.expanduser('~'), 'credentialForwarding': False}
    return project_operation(request)


def main():
    request_id = None
    try:
        length = struct.unpack('!I', exact_input(4))[0]
        if not 1 <= length <= MAX_REQUEST:
            reject('INVALID_REQUEST')
        request = json.loads(exact_input(length))
        if isinstance(request, dict):
            request_id = request.get('requestId')
        result = execute(request)
        response = {'version': 1, 'requestId': request_id, 'ok': True, 'result': result}
    except Rejected as error:
        response = {'version': 1, 'requestId': request_id, 'ok': False, 'error': {'code': error.code}}
    except FileNotFoundError:
        response = {'version': 1, 'requestId': request_id, 'ok': False, 'error': {'code': 'NOT_FOUND'}}
    except PermissionError:
        response = {'version': 1, 'requestId': request_id, 'ok': False, 'error': {'code': 'PERMISSION_DENIED'}}
    except OSError as error:
        code = 'SYMLINK_REJECTED' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'IO_ERROR'
        response = {'version': 1, 'requestId': request_id, 'ok': False, 'error': {'code': code}}
    except Exception:
        # Never echo malformed payloads, file contents, environments or tracebacks.
        response = {'version': 1, 'requestId': request_id, 'ok': False, 'error': {'code': 'INVALID_REQUEST'}}
    sys.stdout.buffer.write(MARKER + json.dumps(response, ensure_ascii=True, separators=(',', ':')).encode('ascii') + b'\n')
    sys.stdout.buffer.flush()


def signal_stop(_number, _frame):
    global SIGNALLED
    SIGNALLED = True


for stopping_signal in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(stopping_signal, signal_stop)
main()
