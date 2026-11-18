"""Extract runtime files from a previously verified Rust component archive."""

import pathlib
import re
import shutil
import sys
import tarfile


def extract(archive, destination, prefix, component, directories):
    written = 0
    total_size = 0
    count = 0
    with tarfile.open(archive, mode='r|xz') as source:
        for member in source:
            count += 1
            if count > 4096:
                raise ValueError('Unexpected Rust archive entry count')
            parts = member.name.split('/')
            if parts[:2] != [prefix, component] or len(parts) < 4 or parts[2] not in directories:
                continue
            relative = parts[2:]
            if any(not re.fullmatch(r'[A-Za-z0-9_.+-]+', part) or part in {'.', '..'} for part in relative):
                raise ValueError('Unexpected Rust archive path')
            if member.isdir():
                continue
            total_size += member.size
            if not member.isfile() or member.size < 0 or total_size > 512 * 1024**2:
                raise ValueError('Unexpected Rust archive file size or type')
            output = destination.joinpath(*relative)
            output.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as data, output.open('xb') as target:
                shutil.copyfileobj(data, target, length=64 * 1024)
            written += 1
    if not written:
        raise ValueError('Rust archive contained no selected runtime files')
    print(f'Extracted {written} verified archive entries from {prefix}.', flush=True)


if __name__ == '__main__':
    extract(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4], set(sys.argv[5:]))
