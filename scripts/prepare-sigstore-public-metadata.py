"""Prepare bounded public TUF bytes; authenticity is checked by the verifier."""
import base64
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
ORIGIN = 'https://tuf-repo-cdn.sigstore.dev'


def prepare(seed, request=None):
    transport = request or urllib.request.build_opener(urllib.request.ProxyHandler({})).open
    responses = {}
    def get(relative, missing=False):
        if relative.startswith('/') or '..' in relative.split('/') or '?' in relative or '#' in relative:
            raise ValueError('public metadata path')
        url = ORIGIN + '/' + relative
        try:
            with transport(url, timeout=20) as response:
                if response.geturl() != url or response.status != 200:
                    raise ValueError('metadata origin/status')
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError('metadata size')
        except urllib.error.HTTPError as error:
            if error.code != 404 or not missing:
                raise
            responses[url] = dict(status=404)
            return None
        responses[url] = dict(status=200, bytes_base64=base64.b64encode(data).decode(), sha256=hashlib.sha256(data).hexdigest())
        return json.loads(data)
    root = json.loads(base64.b64decode(seed['root.json'], validate=True))
    original_version = root['signed']['version']
    if type(original_version) is not int or not 1 <= original_version <= 1000:
        raise ValueError('root seed version')
    for version in range(original_version + 1, original_version + 33):
        updated = get(str(version) + '.root.json', missing=True)
        if updated is None:
            break
        if updated.get('signed', {}).get('version') != version:
            raise ValueError('root version mismatch')
        root = updated
    else:
        raise ValueError('root rotation bound')
    consistent = root['signed']['consistent_snapshot']
    if type(consistent) is not bool:
        raise ValueError('root consistency flag')
    def versioned(name, metadata):
        version = metadata['signed']['meta'][name]['version']
        if type(version) is not int or not 1 <= version <= 10**9:
            raise ValueError('metadata version')
        return (str(version) + '.' if consistent else '') + name
    timestamp = get('timestamp.json')
    snapshot = get(versioned('snapshot.json', timestamp))
    targets = get(versioned('targets.json', snapshot))
    target = targets['signed']['targets']['trusted_root.json']
    digest = target['hashes']['sha256']
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('target digest')
    filename = (digest + '.' if consistent else '') + 'trusted_root.json'
    get('targets/' + filename)
    return dict(responses=responses, root_seed_version=original_version,
                latest_claimed_root_version=root['signed']['version'],
                signatures_verified=False, target_name='trusted_root.json')


def main():
    path = ROOT / 'npm-static-review-data/npm-11.21.2.tgz'
    if hashlib.sha256(path.read_bytes()).hexdigest() != '8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5':
        raise ValueError('reviewed npm source changed')
    with tarfile.open(path) as archive:
        seed = json.loads(archive.extractfile('package/node_modules/@sigstore/tuf/seeds.json').read())[ORIGIN]
    result = prepare(seed)
    (ROOT / 'sigstore-current-public-tuf-data.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(root_seed_version=result['root_seed_version'], latest_claimed_root_version=result['latest_claimed_root_version'], responses=len(result['responses']), signatures_verified=False)))


if __name__ == '__main__':
    main()
