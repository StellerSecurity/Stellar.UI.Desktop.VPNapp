"""Hash-pinned Windows probe on four synthetic Rust libraries; no app analysis."""
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run(command, cwd, env, seconds, capture=False):
    # The job object kills remaining descendants when closed. It is a resource
    # boundary, not a network/filesystem security sandbox.
    class Basic(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t),
                    ('active_processes', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                    ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Counters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', Counters), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), 'job object creation failed')
    try:
        limits = Extended()
        limits.basic.flags = 0x2000
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise OSError(ctypes.get_last_error(), 'job object limit failed')
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
            if not kernel.AssignProcessToJobObject(job, int(process._handle)):
                process.kill()
                process.wait()
                raise OSError(ctypes.get_last_error(), 'process job assignment failed')
            started = time.monotonic()
            while process.poll() is None:
                if time.monotonic() - started > seconds or os.fstat(log.fileno()).st_size > 8 * 1024**2:
                    raise ValueError('probe time/output limit')
                time.sleep(0.1)
            log.seek(0)
            raw = log.read(8 * 1024**2 + 1)
            if process.returncode != 0 or len(raw) > 8 * 1024**2:
                print(raw[-16000:].decode(errors='replace'))
                raise ValueError('reviewed Windows probe operation failed')
            result = dict(exit_code=0, output_bytes=len(raw), log_sha256=hashlib.sha256(raw).hexdigest())
            if capture:
                result['output'] = raw.decode('utf-8')
            return result
    finally:
        kernel.CloseHandle(job)


def main():
    root = Path(__file__).resolve().parent
    plan = json.loads((root / 'windows-codeql-probe-plan.json').read_text())
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != plan['script_sha256']:
        raise ValueError('first-party Windows probe changed')
    for row in plan['files']:
        path = Path(row['root']) / row['path']
        if (path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024**2
                or row.get('bytes') is not None and path.stat().st_size != row['bytes']
                or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']):
            raise ValueError('reviewed Windows runtime file changed: ' + row['path'])
    fixture_path = root / 'codeql-layout-probe.py'
    if hashlib.sha256(fixture_path.read_bytes()).hexdigest() != 'caa01ad8ba40a5455ba046b273956a37d3c8fe78ea3d7c5cbd44ca1b26aa8224':
        raise ValueError('first-party synthetic fixture changed')
    spec = importlib.util.spec_from_file_location('firstparty_fixture', fixture_path)
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    codeql = Path(plan['codeql_root']) / 'codeql.exe'
    rust = Path(plan['rust_root']) / 'bin'
    schema = Path(plan['codeql_root']) / 'rust/rust.dbscheme'
    if hashlib.sha256(schema.read_bytes()).hexdigest() != 'f412b260f76bdaad67d06973b8edc65e057ba723bd206d9fd12e653fa0aaf900':
        raise ValueError('Rust query schema changed')
    with tempfile.TemporaryDirectory(prefix='stellar-win-codeql-') as folder:
        work = Path(folder)
        before = fixture.fixture(work)
        source = work / 'source'
        for name in ('home', 'cargo', 'rustup', 'temp', 'target', 'queries'):
            (work / name).mkdir()
        env = dict(PATH=str(rust) + os.pathsep + str(Path(plan['java_root']) / 'bin') + os.pathsep + 'C:\\Windows\\System32',
                   SystemRoot='C:\\Windows', WINDIR='C:\\Windows', COMSPEC='C:\\Windows\\System32\\cmd.exe',
                   HOME=str(work/'home'), USERPROFILE=str(work/'home'), TEMP=str(work/'temp'), TMP=str(work/'temp'),
                   CODEQL_JAVA_HOME=plan['java_root'], CARGO_HOME=str(work/'cargo'), RUSTUP_HOME=str(work/'rustup'),
                   CODEQL_DIST=plan['codeql_root'], CODEQL_PLATFORM='win64',
                   CARGO_NET_OFFLINE='true', RUSTUP_TOOLCHAIN=plan['rust_root'], RUSTC=str(rust/'rustc.exe'),
                   CARGO=str(rust/'cargo.exe'), CARGO_TARGET_DIR=str(work/'target'),
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        commands = [run([str(rust/'cargo.exe'), 'metadata', '--format-version', '1', '--no-deps', '--locked', '--offline'], source, env, 30)]
        database = work / 'database'
        commands.append(run([str(codeql), 'database', 'create', str(database), '--language=rust', '--build-mode=none',
                             '--source-root=' + str(source), '--extractor-option=rust.extract_dependencies_as_source=true',
                             '--threads=2', '--ram=3072'], source, env, 300))
        query = work / 'queries/coverage.ql'
        query.write_text(fixture.QUERY)
        output = work / 'coverage.bqrs'
        commands.append(run([str(codeql), 'query', 'run', '--database=' + str(database), '--dbscheme=' + str(schema),
                             '--output=' + str(output), '--threads=2', '--ram=1024', str(query)], work/'queries', env, 120))
        decoded = work / 'coverage.json'
        commands.append(run([str(codeql), 'bqrs', 'decode', '--format=json', '--output=' + str(decoded), str(output)], work, env, 30))
        if not decoded.is_file() or decoded.stat().st_size > 65536:
            raise ValueError('query result bounds')
        result = json.loads(decoded.read_text())
        for row in result.get('#select', {}).get('tuples', []):
            if isinstance(row, list) and len(row) == 2 and isinstance(row[0], str):
                row[0] = row[0].replace('\\', '/')
        rows = fixture.validate_rows(result)
        if any(hashlib.sha256((work / name).read_bytes()).hexdigest() != value for name, value in before.items()):
            raise ValueError('synthetic source/lock changed')
        current = {str(path.relative_to(work)).replace('\\', '/') for base in ('source', 'metadata')
                   for path in (work / base).rglob('*') if path.is_file()}
        if current != set(before):
            raise ValueError('unexpected synthetic source/lock output')
        print(json.dumps(dict(commands=commands, database_function_bodies=rows,
                              first_party_only=True, source_lock_unchanged=True,
                              application_analyzed=False, dependency_downloaded=False,
                              signing=False, released=False)))


if __name__ == '__main__':
    main()
