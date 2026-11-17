"""Download four hash-bound Ubuntu artifacts as data; never install or execute."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
ARTIFACTS = {
    'glib2.0_2.80.0.orig.tar.xz': ('8228a92f92a412160b139ae68b6345bd28f24434a7b5af150ebe21ff587a561d', 5510536),
    'glib2.0_2.80.0-6ubuntu3.10.debian.tar.xz': ('9790a8bbf6d775f8a482f3862a64b2127330a1866ceaf04c85be34fbd2698254', 178808),
    'libglib2.0-0t64_2.80.0-6ubuntu3.10_amd64.deb': ('ff1b650f655b36dfe202fdbae6bb02b363c7257b6dd23e4f95ab61f716190df3', 1547558),
    'libglib2.0-dev_2.80.0-6ubuntu3.10_amd64.deb': ('6d1d88d68192256603c0de05d084b8ef06ed9b16753215ec2c1ef9ef5fa15014', 1860604),
}


def ar_members(raw):
    if not raw.startswith(b'!<arch>\n'):
        raise ValueError('Debian AR framing')
    offset, result = 8, {}
    while offset < len(raw):
        header = raw[offset:offset + 60]
        if len(header) != 60 or header[58:] != b'`\n':
            raise ValueError('Debian AR header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58].decode('ascii').strip())
        start, end = offset + 60, offset + 60 + size
        if name in result or name not in ('debian-binary', 'control.tar.zst', 'data.tar.zst', 'control.tar.xz', 'data.tar.xz') or size < 0 or end > len(raw):
            raise ValueError('Debian AR member')
        result[name] = raw[start:end]
        offset = end + size % 2
    if offset != len(raw) or result.get('debian-binary') != b'2.0\n':
        raise ValueError('Debian AR terminator/version')
    return result


def main():
    destination = ROOT / 'glib-native-review-data'
    destination.mkdir(mode=0o700, exist_ok=True)
    if destination.is_symlink():
        raise ValueError('review destination must be owned regular directory')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    results = []
    for name, (expected, size) in ARTIFACTS.items():
        url = 'https://archive.ubuntu.com/ubuntu/pool/main/g/glib2.0/' + name
        with opener.open(url, timeout=30) as response:
            if response.geturl() != url or response.status != 200:
                raise ValueError('unexpected source origin')
            raw = response.read(size + 1)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('official artifact identity drift')
        path = destination / name
        if path.exists():
            if path.is_symlink() or path.read_bytes() != raw:
                raise ValueError('existing review artifact differs')
        else:
            with path.open('xb') as output:
                output.write(raw)
            path.chmod(0o600)
        row = dict(name=name, sha256=expected, bytes=size)
        if name.endswith('.deb'):
            row['members'] = {member: dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                              for member, data in ar_members(raw).items()}
        else:
            inventory, total = [], 0
            with tarfile.open(fileobj=io.BytesIO(raw), mode='r:xz') as archive:
                for member in archive:
                    if member.isdir():
                        continue
                    path = PurePosixPath(member.name)
                    if path.is_absolute() or '..' in path.parts or len(inventory) >= 10000:
                        raise ValueError('source member path/budget')
                    if member.issym() or member.islnk():
                        data = member.linkname.encode()
                    elif member.isfile() and member.size <= 16 * 1024**2:
                        data = archive.extractfile(member).read(member.size + 1)
                        if len(data) != member.size:
                            raise ValueError('source member size')
                    else:
                        raise ValueError('source member type')
                    total += len(data)
                    if total > 160 * 1024**2:
                        raise ValueError('source expansion budget')
                    inventory.append(dict(path=member.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), type=member.type.decode('ascii')))
            row['source_inventory'] = inventory
        results.append(row)
    (ROOT / 'glib-native-static-acquisition.json').write_text(json.dumps(dict(artifacts=results, package_code_executed=False, installed=False, extracted_to_disk=False), indent=2) + '\n')
    print(json.dumps([dict(name=row['name'], bytes=row['bytes'], source_files=len(row.get('source_inventory', [])), deb_members=list(row.get('members', {}))) for row in results]))


if __name__ == '__main__':
    main()
