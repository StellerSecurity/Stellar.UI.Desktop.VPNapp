"""Isolated source rebuild and exact Linux-only synthetic probes after hash checks."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
SDK = Path('/opt/hostedtoolcache/go/1.26.11/x64')
ARTIFACTS = {
    'go': ('https://dl.google.com/go/go1.26.11.src.tar.gz', 'd44101b0ff27ed2a4c75ad46c17b9c74359209e2eb2ca7c9df6cb4fdb68e1969', 34192889),
    'esbuild': ('https://api.github.com/repos/evanw/esbuild/tarball/bb9db84c02433fbe37b3509f53f9f3e3cc48725e', '96a3e9d485f33cefa1200dbed6a29787f7c7161b0bec4d42dd4b017c40cbc6b5', 8 * 1024**2),
    'sys': ('https://proxy.golang.org/golang.org/x/sys/@v/v0.44.0.zip', 'f1fa1052808e6bd6eb9c5372c053b2370a582532fac5d6a4600e7a6fab190ff3', 8 * 1024**2),
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fetch(name):
    url, expected, limit = ARTIFACTS[name]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.monotonic()
    with opener.open(urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'StellarReviewedBuild/1.0'}), timeout=30) as response:
        final = response.geturl()
        allowed = final == url or (name == 'esbuild' and final == 'https://codeload.github.com/evanw/esbuild/legacy.tar.gz/bb9db84c02433fbe37b3509f53f9f3e3cc48725e')
        if not allowed or response.status != 200:
            raise ValueError('unexpected source response')
        raw = response.read(limit + 1)
    if len(raw) > limit or digest(raw) != expected or time.monotonic() - started > 120:
        raise ValueError('exact reviewed source archive mismatch')
    return raw


def tar_files(raw, prefix, maximum):
    result, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for item in archive:
            if item.isdir():
                continue
            if (prefix == 'evanw-esbuild-bb9db84/' and item.issym()
                    and item.name == prefix + 'scripts/browser/esbuild.wasm.bagel'
                    and item.linkname == '../../npm/esbuild-wasm/esbuild.wasm'):
                # Exact upstream browser-test alias, unused by the Go build.
                # Do not create it; all other links remain an error.
                continue
            path = PurePosixPath(item.name)
            if not item.isfile() or not item.name.startswith(prefix) or path.is_absolute() or '..' in path.parts:
                raise ValueError('nonregular or escaping source member')
            name = item.name[len(prefix):]
            total += item.size
            if not name or name in result or item.size > 32 * 1024**2 or total > maximum:
                raise ValueError('source member budget')
            data = archive.extractfile(item).read(item.size + 1)
            if len(data) != item.size:
                raise ValueError('source member length')
            result[name] = data
    return result


def materialize(root, files):
    for name, raw in files.items():
        target = root / name
        if target.is_symlink() or root.resolve() not in target.resolve().parents:
            raise ValueError('output escapes workspace')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def run(command, cwd, env, seconds=300, input_bytes=None):
    # Bounded first-party runner; no ambient env, credentials or shell.
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        if input_bytes is not None:
            process.stdin.write(input_bytes)
            process.stdin.close()
        started = time.monotonic()
        while process.poll() is None:
            if time.monotonic() - started > seconds or os.fstat(log.fileno()).st_size > 4 * 1024**2:
                os.killpg(process.pid, 9)
                process.wait()
                raise ValueError('compiler time/output budget')
            time.sleep(0.1)
        log.seek(0)
        raw = log.read(4 * 1024**2 + 1)
        if process.returncode != 0 or len(raw) > 4 * 1024**2:
            print(raw[-12000:].decode(errors='replace'), file=sys.stderr)
            raise ValueError('isolated build operation failed')
        return raw.decode()


def main():
    plan = json.loads((ROOT / 'esbuild-rebuild-plan.json').read_text())
    if digest(Path(__file__).read_bytes()) != plan['script_sha256']:
        raise ValueError('first-party builder drift')
    for relative, expected in plan['sdk_tool_sha256'].items():
        path = SDK / relative
        if path.is_symlink() or digest(path.read_bytes()) != expected:
            raise ValueError('reviewed Go tool drift')
    sources = tar_files(fetch('go'), 'go/', 256 * 1024**2)
    verified = 0
    for path in (SDK / 'src').rglob('*'):
        if path.is_symlink():
            raise ValueError('SDK source symlink')
        if path.is_file():
            name = path.relative_to(SDK).as_posix()
            expected = plan['generated_sdk_source_sha256'].get(name)
            if expected is None:
                expected = digest(sources[name]) if name in sources else None
            if expected is None or digest(path.read_bytes()) != expected:
                raise ValueError('SDK source differs from exact approved release: ' + name)
            verified += 1
    for path in (SDK / 'pkg/include').glob('*.h'):
        if path.is_symlink() or path.read_bytes() != sources['src/runtime/' + path.name]:
            raise ValueError('SDK assembler header drift')
    esbuild = tar_files(fetch('esbuild'), 'evanw-esbuild-bb9db84/', 64 * 1024**2)
    sys_source, excluded = {}, []
    with zipfile.ZipFile(io.BytesIO(fetch('sys'))) as archive:
        for item in archive.infolist():
            prefix = 'golang.org/x/sys@v0.44.0/'
            if not item.filename.startswith(prefix) or not item.is_dir() and item.file_size > 4 * 1024**2:
                raise ValueError('module member bounds')
            name = item.filename[len(prefix):]
            if item.is_dir():
                continue
            if '..' in PurePosixPath(name).parts or name in sys_source:
                raise ValueError('module member path')
            # Only production Go/assembly source is vendored. In particular the
            # unrelated Windows signed-test EXE is never materialized or run.
            if '/testdata/' in '/' + name or name.endswith('_test.go'):
                excluded.append(name)
                continue
            sys_source[name] = archive.read(item)
    with tempfile.TemporaryDirectory(prefix='stellar-patched-esbuild-') as folder:
        work = Path(folder)
        source = work / 'source'
        source.mkdir()
        materialize(source, esbuild)
        materialize(source / 'vendor/golang.org/x/sys', sys_source)
        (source / 'go.mod').write_text('module github.com/evanw/esbuild\n\ngo 1.25.0\n\nrequire golang.org/x/sys v0.44.0\n')
        (source / 'go.sum').write_text('golang.org/x/sys v0.44.0 h1:ildZl3J4uzeKP07r2F++Op7E9B29JRUy+a27EibtBTQ=\ngolang.org/x/sys v0.44.0/go.mod h1:4GL1E5IUh+htKOUEOaiffhrAeqysfVGipDYzABqnCmw=\n')
        (source / 'vendor/modules.txt').write_text('# golang.org/x/sys v0.44.0\n## explicit; go 1.25.0\ngolang.org/x/sys/unix\n')
        for name in ('home', 'cache', 'modules', 'temp', 'output'):
            (work / name).mkdir()
        pins = {str(SDK / name): value for name, value in plan['sdk_tool_sha256'].items() if name.endswith(('/compile', '/asm', '/link'))}
        wrapper = work / 'tool-guard.py'
        wrapper.write_text('#!/usr/bin/python3\nimport hashlib,os,sys\npins=' + repr(pins) + '\np=sys.argv[1]\nif p not in pins or hashlib.sha256(open(p,"rb").read()).hexdigest()!=pins[p]: raise SystemExit("unreviewed compiler tool")\nos.execve(p,sys.argv[1:],os.environ)\n')
        wrapper.chmod(0o700)
        env = dict(PATH='/usr/bin:/bin', HOME=str(work/'home'), TMPDIR=str(work/'temp'),
                   GOROOT=str(SDK), GOPATH=str(work/'modules'), GOCACHE=str(work/'cache'),
                   GOMODCACHE=str(work/'modules'), GOENV='off', GOTOOLCHAIN='local',
                   GOTELEMETRY='off', GOPROXY='off', GOSUMDB='off', GOVCS='*:off',
                   CGO_ENABLED='0', GOWORK='off', GOFLAGS='', GOEXPERIMENT='',
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        version = run([str(SDK/'bin/go'), 'version'], source, env, 30).strip()
        if version != 'go version go1.26.11 linux/amd64':
            raise ValueError('unexpected reviewed SDK version')
        outputs = []
        synthetic_tests = []
        for target_os, target_arch in plan['targets']:
            target = work / 'output' / ('esbuild-' + target_os + '-' + target_arch)
            target_env = dict(env, GOOS=target_os, GOARCH=target_arch)
            run([str(SDK/'bin/go'), 'build', '-mod=vendor', '-trimpath', '-buildvcs=false',
                 '-toolexec=' + str(wrapper), '-ldflags=-linkmode=internal', '-o', str(target), './cmd/esbuild'], source, target_env)
            metadata = run([str(SDK/'bin/go'), 'version', '-m', str(target)], source, env, 30)
            if 'go1.26.11' not in metadata or 'golang.org/x/sys\tv0.44.0' not in metadata and target_os != 'windows':
                raise ValueError('patched build component identity mismatch')
            identity = digest(target.read_bytes())
            if identity != plan['expected_target_sha256'][target_os + '/' + target_arch]:
                raise ValueError('independent rebuild bytes differ; target execution blocked')
            if (target_os, target_arch) == ('linux', 'amd64'):
                if run([str(target), '--version'], source, env, 30).strip() != '0.28.1':
                    raise ValueError('reviewed esbuild version probe failed')
                transformed = run([str(target), '--loader=js', '--minify', '--log-level=error'], source, env, 30,
                                  input_bytes=b'console.log(1 + 2);\n')
                if transformed != 'console.log(3);\n':
                    raise ValueError('reviewed synthetic transformation failed')
                synthetic_tests = ['exact-version', 'stdin-javascript-minification']
            outputs.append(dict(os=target_os, arch=target_arch, bytes=target.stat().st_size,
                                sha256=identity, build_metadata=metadata,
                                target_executed=(target_os, target_arch) == ('linux', 'amd64')))
        print(json.dumps(dict(sdk_source_files_verified=verified, sdk_version=version,
                              outputs=outputs, source_patch='Go directive 1.25.0 and x/sys v0.44.0; application Rust and JS unchanged',
                              synthetic_tests=synthetic_tests, independent_rebuild_hashes_match=True,
                              target_execution_scope='Linux amd64 only: --version and fixed 20-byte stdin expression; no target app or Mac execution',
                              module_downloads_enabled=False,
                              cgo_enabled=False, installed=False, published=False,
                              scope='Isolated patched esbuild source rebuild only, not native clearance or application release.')))


if __name__ == '__main__':
    main()
