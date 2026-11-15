"""Stage only individually reviewed Rust standard-library text as analysis input."""
import hashlib
import io
import lzma
import re
from pathlib import Path, PurePosixPath
import tarfile
import time
import urllib.request

URL = 'https://static.rust-lang.org/dist/rust-src-1.99.1.tar.xz'
ARCHIVE_SHA = 'e485a88c45db546b73571df7bebfcb4454ba4fb552c492e25fc5b00eeb5bf22d'
PREFIX = 'rust-src-1.99.1/rust-src/lib/rustlib/src/rust/library/'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate_profile(profile):
    if profile.get('archive_url') != URL or profile.get('archive_sha256') != ARCHIVE_SHA or profile.get('version') != '1.99.1':
        raise ValueError('unexpected exact sysroot source component')
    expected, folded = {}, set()
    for row in profile['files']:
        path = row['path']
        parts = PurePosixPath(path).parts
        if not path or str(PurePosixPath(path)) != path or path.startswith('/') or not parts or any(part in ('.', '..') or part.endswith((' ', '.')) for part in parts) or any(c in path for c in ('\\', ':', '\0', '\r', '\n')):
            raise ValueError('invalid sysroot source path')
        if path.casefold() in folded or path.startswith('vendor/') or path.endswith(('.auxv', '.wasm', '.exe', '.dll', '.a', '.o')):
            raise ValueError('unreviewed or duplicate sysroot analysis input')
        if not isinstance(row['bytes'], int) or not 0 <= row['bytes'] <= 16 * 1024**2 or not re.fullmatch('[a-f0-9]{64}', row['sha256']):
            raise ValueError('invalid source byte/hash pin')
        folded.add(path.casefold())
        expected[PREFIX + path] = row
    if len(expected) != 2356:
        raise ValueError('exact reviewed sysroot source inventory required')
    return expected


def stage_source(destination, profile):
    expected = validate_profile(profile)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('fresh task-owned sysroot source directory required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    started, total, chunks = time.monotonic(), 0, []
    with opener.open(urllib.request.Request(URL, headers={'Accept-Encoding': 'identity'}), timeout=30) as response:
        if response.status != 200 or response.geturl() != URL or response.headers.get('Content-Encoding', 'identity') != 'identity':
            raise ValueError('unexpected sysroot source response')
        while True:
            block = response.read(min(1024**2, 32 * 1024**2 + 1 - total))
            if not block:
                break
            chunks.append(block)
            total += len(block)
            if total > 32 * 1024**2 or time.monotonic() - started > 150:
                raise ValueError('sysroot source acquisition bounds')
    raw = b''.join(chunks)
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA:
        raise ValueError('official source archive checksum mismatch')
    decoder = lzma.LZMADecompressor(memlimit=128 * 1024**2)
    data = decoder.decompress(raw, max_length=256 * 1024**2 + 1)
    if len(data) > 256 * 1024**2 or not decoder.eof or decoder.unused_data:
        raise ValueError('sysroot source archive expansion bounds')
    selected, seen = [], set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            if member.name in seen or len(seen) >= 12000:
                raise ValueError('sysroot source archive duplicate/member bounds')
            seen.add(member.name)
            if member.name not in expected:
                continue
            row = expected[member.name]
            if not member.isfile() or member.size != row['bytes']:
                raise ValueError('sysroot source member type/size mismatch')
            raw = archive.extractfile(member).read(member.size + 1)
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise ValueError('individual sysroot source checksum mismatch')
            raw.decode('utf-8')
            if b'\0' in raw:
                raise ValueError('unexpected binary in source-only sysroot inputs')
            selected.append((row['path'], raw))
    if len(selected) != len(expected):
        raise ValueError('incomplete exact sysroot source inventory')
    destination.mkdir()
    for relative, raw in selected:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(raw)
    return dict(source_root=str(destination), source_files=len(selected), archive_sha256=ARCHIVE_SHA,
                vendor_packages_staged=False, binaries_staged=False, installer_executed=False, sdk_modified=False)
