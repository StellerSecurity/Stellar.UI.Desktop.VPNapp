"""Read-only inventory of preinstalled CodeQL/Rust tools. Never execute targets."""
import hashlib
import json
import os
from pathlib import Path
import stat
import time

LIMIT_FILES = 12000
LIMIT_BYTES = 3 * 1024**3
started = time.monotonic()
rows = []
scanned = 0
roots = [Path('/opt/hostedtoolcache/CodeQL/2.27.4/x64/codeql'),
         Path.home() / '.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu',
         Path.home() / '.rustup/toolchains/stable-x86_64-unknown-linux-gnu',
         Path('/opt/hostedtoolcache/go/1.26.4/x64'),
         Path('/usr/lib/jvm/temurin-25-jdk-amd64')]
missing = []
for root in roots:
    if not root.is_dir() or root.is_symlink():
        missing.append(str(root))
        continue
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(folder) / d).is_symlink())
        for name in sorted(names):
            path = Path(folder) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('unexpected tool file type')
            if time.monotonic() - started > 90 or len(rows) >= LIMIT_FILES:
                raise ValueError('static inventory budget')
            relative = str(path.relative_to(root))
            rust_tool = (root.name.startswith(('1.99.1-', 'stable-')) and
                         (relative.startswith(('bin/', 'libexec/',
                                               'lib/rustlib/x86_64-unknown-linux-gnu/lib/'))
                          or relative.startswith(('lib/librustc_', 'lib/libLLVM'))))
            go_tool = ('/go/1.26.4/' in str(root) and
                       (relative == 'VERSION' or relative.startswith(('bin/', 'pkg/tool/linux_amd64/'))))
            codeql_tool = (root.name == 'codeql' and
                           (relative == 'codeql' or relative.startswith(('rust/', 'tools/linux64/', 'tools/codeql'))))
            jdk_tool = (str(root) == '/usr/lib/jvm/temurin-25-jdk-amd64' and
                        (relative in ('bin/java', 'release') or relative.startswith(('lib/', 'conf/'))))
            selected = rust_tool or go_tool or codeql_tool or jdk_tool
            if not selected:
                continue
            if info.st_size > 512 * 1024**2 or scanned + info.st_size > LIMIT_BYTES:
                raise ValueError('static byte budget')
            digest = hashlib.sha256()
            with path.open('rb') as source:
                first = source.read(16)
                digest.update(first)
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            scanned += info.st_size
            rows.append(dict(root=str(root), path=relative, bytes=info.st_size,
                             sha256=digest.hexdigest(), elf=first.startswith(b'\x7fELF'),
                             executable=bool(info.st_mode & 0o111)))
go_cache = Path('/opt/hostedtoolcache/go')
go_versions = sorted(p.name for p in go_cache.iterdir() if p.is_dir()) if go_cache.is_dir() else []
static_text = {}
codeql_root = roots[0]
for relative in ('rust/codeql-extractor.yml', 'rust/tools/autobuild.sh',
                 'rust/tools/index-files.sh', 'codeql', 'tools/linux64/java/release'):
    candidate = codeql_root / relative
    if candidate.is_file() and not candidate.is_symlink() and candidate.stat().st_size <= 32768:
        static_text[relative] = candidate.read_text(encoding='utf-8')
rustup_root = Path.home() / '.rustup/toolchains'
rustup_versions = sorted(p.name for p in rustup_root.iterdir() if p.is_dir()) if rustup_root.is_dir() else []
rust_metadata = {}
for toolchain in rustup_versions:
    if toolchain not in ('1.99.1-x86_64-unknown-linux-gnu', 'stable-x86_64-unknown-linux-gnu'):
        continue
    metadata = rustup_root / toolchain / 'lib/rustlib/multirust-channel-manifest.toml'
    if metadata.is_file() and not metadata.is_symlink() and metadata.stat().st_size <= 2 * 1024**2:
        import tomllib
        decoded = tomllib.loads(metadata.read_text(encoding='utf-8'))
        rust_metadata[toolchain] = dict(rust_version=decoded['pkg']['rust']['version'],
                                        cargo_version=decoded['pkg']['cargo']['version'])
binary_option_strings = {}
import re
for relative in ('rust/tools/linux64/autobuild', 'rust/tools/linux64/extractor'):
    candidate = codeql_root / relative
    if candidate.is_file() and not candidate.is_symlink() and candidate.stat().st_size <= 48 * 1024**2:
        data = candidate.read_bytes()
        hits = set()
        for match in re.finditer(rb'CODEQL_EXTRACTOR_RUST[A-Z_0-9]{0,120}|(?:linked_projects|run_build_scripts|cargo_manifest|project_manifest)', data):
            lo = max(0, match.start() - 64)
            hi = min(len(data), match.end() + 128)
            hits.add(data[lo:hi].decode('utf-8', errors='backslashreplace'))
            if len(hits) > 256:
                raise ValueError('static option string budget')
        binary_option_strings[relative] = dict(sha256=hashlib.sha256(data).hexdigest(), fragments=sorted(hits), purpose='configuration discovery only; not full native code review')
installed_java = []
java_roots = [Path('/usr/lib/jvm'), Path('/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk')]
for java_root in java_roots:
    if not java_root.is_dir() or java_root.is_symlink():
        continue
    for folder, dirs, names in os.walk(java_root, followlinks=False):
        depth = len(Path(folder).relative_to(java_root).parts)
        dirs[:] = sorted(d for d in dirs if depth < 3 and not (Path(folder) / d).is_symlink())
        if len(installed_java) > 64:
            raise ValueError('JDK identity inventory budget')
        if 'release' in names:
            release = Path(folder) / 'release'
            if not release.is_symlink() and release.stat().st_size <= 32768:
                installed_java.append(dict(root=folder, release=release.read_text(encoding='utf-8')))
report = dict(schema=1, installed_jdk_release_metadata=installed_java, static_binary_option_fragments=binary_option_strings, installed_rust_metadata=rust_metadata, selected_configuration_text=static_text, available_rust_version_directories=rustup_versions, available_go_version_directories=go_versions, codeql_version_directory='2.27.4', rust_version_directory='1.99.1',
              files=rows, bytes_hashed=scanned, missing_roots=missing,
              package_code_executed=False, tool_binaries_executed=False,
              installation=False, downloads=False, private_credentials_read=False,
              scope='selected preinstalled tool files only; not full vendor/source review',
              execution_approved=False)
print(json.dumps(report, separators=(',', ':')))
