"""Read the installed Rust macro server as PE data; never launch it."""
import hashlib
import json
from pathlib import Path
import struct


def main():
    root = Path('C:/Users/runneradmin/.rustup/toolchains/stable-x86_64-pc-windows-msvc')
    path = root / 'libexec/rust-analyzer-proc-macro-srv.exe'
    if root.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024**2:
        raise ValueError('unexpected Rust macro-server file')
    raw = path.read_bytes()
    if len(raw) < 512 or raw[:2] != b'MZ':
        raise ValueError('macro-server PE header missing')
    offset = struct.unpack_from('<I', raw, 60)[0]
    if offset + 24 > len(raw) or raw[offset:offset + 4] != b'PE\0\0':
        raise ValueError('macro-server PE signature missing')
    machine, sections = struct.unpack_from('<HH', raw, offset + 4)
    optional_size = struct.unpack_from('<H', raw, offset + 20)[0]
    table = offset + 24 + optional_size
    if machine != 0x8664 or not 1 <= sections <= 32 or table + 40 * sections > len(raw):
        raise ValueError('macro-server PE architecture/section bounds')
    rows = []
    for index in range(sections):
        section = table + index * 40
        name = raw[section:section + 8].rstrip(b'\0').decode('ascii')
        size, start = struct.unpack_from('<II', raw, section + 16)
        if start > len(raw) or size > len(raw) - start:
            raise ValueError('macro-server PE section exceeds file')
        rows.append(dict(name=name, offset=start, bytes=size,
                         sha256=hashlib.sha256(raw[start:start + size]).hexdigest()))
    print(json.dumps(dict(root=root.as_posix(), path=path.relative_to(root).as_posix(),
                          bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                          architecture='x86_64', sections=rows,
                          target_executed=False, source_review_complete=False,
                          release_approved=False)))


if __name__ == '__main__':
    main()
