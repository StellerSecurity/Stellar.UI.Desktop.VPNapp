"""Fixed-input tool regressions in a secret-free ephemeral Linux CI VM only."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import selectors
import resource
import urllib.request
import signal
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parent
NPM_SHA = '8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5'
NODE_ARCHIVE_SHA = '5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864'
NODE_SHA = 'd931c649850ffa7155b8ceffb400dc916ef325866e509cc52ae36e33e8fbb9a9'
PATCH_SHA = 'b256f3844d01e55da6ac8fd38f48985ec6dae7bb9ecb1953d53ddc603d964fa3'
FIXTURE_SHA = 'd20d668d3d8168aa8ca4603972467702d154c7697ffa4a15a26595a436466a4f'


def verified(path, expected):
    if path.is_symlink() or not path.is_file():
        raise ValueError('regular reviewed input required')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('reviewed input drift: ' + path.name)
    return raw


def run(command, work, env, timeout=45):
    def limit_child():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    process = subprocess.Popen(command, cwd=work, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limit_child)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise ValueError('tool probe time limit')
                for key, _ in selector.select(max(0, min(0.1, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > 128 * 1024:
                            raise ValueError('tool probe output limit')
            code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        raise
    finally:
        process.stdout.close()
    text = output.decode('utf-8', errors='replace').replace(str(work), '<temporary>')
    if code:
        (ROOT / 'npm-tool-isolation-failure.json').write_text(json.dumps(dict(pid=process.pid, exit_code=code, command=[part.replace(str(work), '<temporary>') for part in command], output=text[:4096], unsandboxed_fallback=False), indent=2) + '\n')
        raise ValueError('bounded tool verification failed (exit ' + str(code) + '): ' + text[:4096])
    return text


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def download(url, expected, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('reviewed tool artifact identity drift')
    return data


def materialize_runtime(work, npm, node_archive, patcher):
    if hashlib.sha256(npm).hexdigest() != NPM_SHA or hashlib.sha256(node_archive).hexdigest() != NODE_ARCHIVE_SHA:
        raise ValueError('reviewed runtime view archive identity drift')
    records, count = {}, 0
    expected_patches = {}
    with tarfile.open(fileobj=io.BytesIO(npm), mode='r:gz') as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            if (not member.isfile() or parts[0] != 'package' or '..' in parts
                    or '\\' in member.name or member.size > 4 * 1024**2):
                raise ValueError('uncontained runtime source member')
            relative = '/'.join(parts[1:])
            if relative in records:
                raise ValueError('duplicate runtime source member')
            raw = archive.extractfile(member).read(4 * 1024**2 + 1)
            if relative in patcher.INPUTS:
                raw = patcher.patch(relative, raw)
                expected_patches[relative] = hashlib.sha256(raw).hexdigest()
            records[relative] = hashlib.sha256(raw).hexdigest()
            path = work / 'npm' / relative
            if not path.resolve().is_relative_to(work / 'npm'):
                raise ValueError('runtime source traversal')
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as output:
                output.write(raw)
            path.chmod(0o600)
            count += 1
    if count != 1944 or set(expected_patches) != set(patcher.INPUTS):
        raise ValueError('incomplete fixed-input tool view')
    executable = work / 'node'
    with tarfile.open(fileobj=io.BytesIO(node_archive), mode='r:xz') as archive:
        member = archive.getmember('node-v26.13.1-linux-x64/bin/node')
        if not member.isfile() or member.size != 150348872:
            raise ValueError('reviewed Node member drift')
        with archive.extractfile(member) as source, executable.open('xb') as output:
            while block := source.read(1024**2):
                output.write(block)
    verified(executable, NODE_SHA)
    executable.chmod(0o700)
    return records, expected_patches, executable


def main():
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64':
        raise ValueError('the reviewed fresh Linux CI VM is required')
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('isolated CI-only tool test')
    npm = download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', NPM_SHA, 8 * 1024**2)
    node_archive = download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', NODE_ARCHIVE_SHA, 64 * 1024**2)
    verified(ROOT / 'patch-reviewed-npm-tool.py', PATCH_SHA)
    fixture = verified(ROOT / 'npm-backport-regression.cjs', FIXTURE_SHA)
    spec = importlib.util.spec_from_file_location('firstparty_tool_patch', ROOT / 'patch-reviewed-npm-tool.py')
    patcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patcher)
    with tempfile.TemporaryDirectory(prefix='stellar-npm-fixed-input-', dir=ROOT) as folder:
        work = Path(folder).resolve()
        (work / 'tmp').mkdir()
        with tempfile.NamedTemporaryFile(prefix='stellar-denied-fixture-', dir=ROOT) as sentinel:
            sentinel.write(b'owned sandbox denial fixture')
            sentinel.flush()
            records, expected_patches, executable = materialize_runtime(work, npm, node_archive, patcher)
            count = len(records)
            (work / 'regression.cjs').write_bytes(fixture)
            env = dict(PATH='/usr/bin:/bin', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC')
            command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                       '--allow-fs-write=' + str(work), '--no-addons', '--disable-sigusr1',
                       '--max-old-space-size=256', str(work / 'regression.cjs'), sentinel.name]
            result = json.loads(run(command, work, env, 30))
            if (result.get('assertions') != 21 or result.get('permission_file_denial') is not True
                    or result.get('permission_network_denial') is not True
                    or result.get('child_process_denial') is not True
                    or result.get('npm_cli_executed') is not False):
                raise ValueError('incomplete scoped regression result')
            for relative, expected in records.items():
                verified(work / 'npm' / relative, expected)
            report = dict(schema=1, result=result, npm_archive_sha256=NPM_SHA, node_archive_sha256=NODE_ARCHIVE_SHA,
                          node_native_sha256=NODE_SHA, patched_source_sha256=expected_patches,
                          all_runtime_source_files_unchanged=count, app_changed=False, package_installation=False,
                          hooks_executed=False, downloaded_exact_reviewed_artifacts=2,
                          scope='Only four security-backported dependency distributions and fixed first-party regressions in a fresh CI VM with empty GitHub permissions. Node permission controls are not a malicious-code OS sandbox.',
                          no_secrets_or_signing_configured=True, general_npm_execution_approved=False,
                          release_approved=False)
            print(json.dumps(report))


if __name__ == '__main__':
    main()
