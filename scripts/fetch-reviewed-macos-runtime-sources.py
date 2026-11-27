#!/usr/bin/env python3
"""Fetch only the exact, previously reviewed macOS runtime source archives."""
import hashlib
import json
import pathlib
import tempfile
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = ROOT / 'scripts' / 'intel-source-lock.json'
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
ALLOWED_HOSTS = {
    'swupdate.openvpn.net',
    'www.oberhumer.com',
    'github.com',
    'release-assets.githubusercontent.com',
    'codeload.github.com',
}


def allowed(url):
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == 'https' and parsed.hostname in ALLOWED_HOSTS


def main():
    lock = json.loads(LOCK.read_text())
    packages = [item for item in lock['artifacts'] if item['name'] != 'rust-std']
    output = pathlib.Path(tempfile.mkdtemp(prefix='stellar-reviewed-macos-sources-'))
    for item in packages:
        if not allowed(item['url']) or not item['file'].replace('.', '').replace('-', '').isalnum():
            raise SystemExit('Unexpected reviewed source location or filename.')
        request = urllib.request.Request(item['url'], headers={'User-Agent': 'stellar-reviewed-macos-source-fetcher/1'})
        with urllib.request.urlopen(request, timeout=30) as response:
            if not allowed(response.geturl()):
                raise SystemExit('Reviewed source redirected to an unapproved host.')
            data = response.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) > MAX_ARCHIVE_BYTES:
            raise SystemExit('Reviewed source archive exceeded the fixed size bound.')
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise SystemExit('Reviewed source archive checksum mismatch: ' + item['name'])
        destination = output / item['file']
        destination.write_bytes(data)
        print(f"Verified {item['name']} {item['version']} ({len(data)} bytes).")
    print(output)


if __name__ == '__main__':
    main()
