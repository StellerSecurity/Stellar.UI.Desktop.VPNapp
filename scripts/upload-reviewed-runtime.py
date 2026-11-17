"""Narrow first-party artifact transfer; standard library only, no SDK code.

The runner's temporary artifact credential is used only at the fixed Results
service. Neither credentials, signed URLs nor service error bodies are logged.
This does not sign binaries, change repository permissions or publish releases.
"""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import urllib.parse
import uuid
import zipfile

REPOSITORY = 'StellerSecurity/Stellar.UI.Desktop.VPNapp'
SERVICE_HOST = 'results-receiver.actions.githubusercontent.com'
RUNTIMES = {
    'esbuild-darwin-arm64': (15050370, 'e1909408bf8cd939548394b9fafe3a99b0e5243bb97e976bf4f4b05f02a193f0'),
    'esbuild-darwin-amd64': (16341296, 'daf459299ec172f189f3c13c8175f801ab5a9165c3b8b5b977fb6a4c299a711c'),
    'esbuild-linux-amd64': (16061047, '0ec4b4dc642d8786c75ea26419100ac291af95ab1b831e559d1ed62fa6b7cd96'),
    'esbuild-linux-arm64': (14665372, '8d6e5c08be0095413a2e2f68b216eb4fd054c4764d73991867e6a71e4479e0ee'),
    'esbuild-windows-amd64.exe': (16164864, 'ef7c56fdd6e105da11c59b669eec487512261d50c0b549775df47fc9b64e6192'),
    'esbuild-windows-arm64.exe': (14583808, '41b1ef9793e27c48631fb4a17d0231e70ae0850c30c581421acd94ecc5ed2505'),
}
LICENSES = {
    'LICENSE-Go': (1453, '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad'),
    'LICENSE-esbuild': (1069, 'b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681'),
    'LICENSE-x-sys': (1453, '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad'),
}


class ArtifactError(Exception):
    pass


def unique_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ArtifactError('duplicate artifact JSON field')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError):
        raise ArtifactError('invalid artifact JSON') from None


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def check_file(path, size, digest):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size or sha256(path) != digest:
        raise ArtifactError('reviewed artifact input drift')


def pack_reviewed(directory, archive):
    directory = Path(directory)
    expected = {**RUNTIMES, **LICENSES}
    if directory.is_symlink() or not directory.is_dir() or set(p.name for p in directory.iterdir()) != set(expected) | {'runtime-manifest.json'}:
        raise ArtifactError('exact ten-file runtime artifact required')
    for name, (size, digest) in expected.items():
        check_file(directory / name, size, digest)
    manifest_path = directory / 'runtime-manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 16384:
        raise ArtifactError('bounded regular runtime manifest required')
    manifest = unique_json(manifest_path.read_bytes())
    if (not isinstance(manifest, dict)
            or set(manifest) != {'schema', 'targets', 'source_built', 'independently_reproduced', 'published', 'release_approved'}
            or type(manifest['schema']) is not int or manifest['schema'] != 1 or manifest['source_built'] is not True
            or manifest['independently_reproduced'] is not True or manifest['published'] is not False
            or manifest['release_approved'] is not False or not isinstance(manifest['targets'], dict)
            or set(manifest['targets']) != {'darwin/arm64', 'darwin/amd64', 'linux/arm64',
                                           'linux/amd64', 'windows/arm64', 'windows/amd64'}):
        raise ArtifactError('runtime manifest scope drift')
    observed = {}
    for key, record in manifest['targets'].items():
        filename = 'esbuild-' + key.replace('/', '-') + ('.exe' if key.startswith('windows/') else '')
        if filename not in RUNTIMES or record != {'filename': filename, 'bytes': RUNTIMES[filename][0], 'sha256': RUNTIMES[filename][1]}:
            raise ArtifactError('runtime manifest target drift')
        observed[filename] = record
    if set(observed) != set(RUNTIMES):
        raise ArtifactError('runtime manifest incomplete')
    expected['runtime-manifest.json'] = (manifest_path.stat().st_size, sha256(manifest_path))
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for name in sorted(expected):
            output.write(directory / name, name)
    if archive.stat().st_size > 128 * 1024**2:
        raise ArtifactError('runtime artifact size limit')
    # Validate the archive itself, not just the files read before compression.
    with zipfile.ZipFile(archive) as inspected:
        members = inspected.infolist()
        if len(members) != 10 or {m.filename for m in members} != set(expected):
            raise ArtifactError('runtime ZIP member drift')
        for member in members:
            size, digest = expected[member.filename]
            if member.file_size != size or member.flag_bits & 1:
                raise ArtifactError('runtime ZIP member size/encryption drift')
            if hashlib.sha256(inspected.read(member)).hexdigest() != digest:
                raise ArtifactError('runtime ZIP content drift')
    return archive.stat().st_size, sha256(archive)


def backend_ids(token):
    try:
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{32,32768}', token):
            raise ValueError()
        parts = token.split('.')
        if len(parts) != 3:
            raise ValueError()
        payload = base64.b64decode(parts[1] + '=' * (-len(parts[1]) % 4), altchars=b'-_', validate=True)
        claims = unique_json(payload)
        scopes = [part.split(':') for part in claims['scp'].split(' ') if part.startswith('Actions.Results:')]
        if len(scopes) != 1 or len(scopes[0]) != 3:
            raise ValueError()
        identifiers = scopes[0][1:]
        if any(str(uuid.UUID(value)) != value for value in identifiers):
            raise ValueError()
        return {'workflow_run_backend_id': identifiers[0], 'workflow_job_run_backend_id': identifiers[1]}
    except (ValueError, KeyError, TypeError, AttributeError, ArtifactError):
        raise ArtifactError('current job artifact routing scope unavailable') from None


def https_request(url, method, headers, body, kind):
    """Direct TLS, no proxy/redirect handling and no raw service errors."""
    connection = None
    try:
        target = urllib.parse.urlsplit(url)
        if (target.scheme != 'https' or target.port is not None or target.username is not None
                or target.password is not None or target.fragment):
            raise ValueError()
        if kind == 'rpc':
            if (target.hostname != SERVICE_HOST or target.query or method != 'POST'
                    or not re.fullmatch(r'/twirp/github\.actions\.results\.api\.v1\.ArtifactService/(CreateArtifact|FinalizeArtifact)', target.path)):
                raise ValueError()
        elif kind == 'blob':
            if (not target.hostname or not target.hostname.endswith('.blob.core.windows.net') or method != 'PUT'
                    or any(key.lower() == 'authorization' for key in headers)):
                raise ValueError()
        else:
            raise ValueError()
        connection = http.client.HTTPSConnection(target.hostname, timeout=45, context=ssl.create_default_context())
        connection.request(method, urllib.parse.urlunsplit(('', '', target.path, target.query, '')), body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        if response.status != (200 if kind == 'rpc' else 201):
            raise ArtifactError('artifact ' + kind + ' HTTP status ' + str(response.status))
        return raw
    except ArtifactError:
        raise
    except Exception:
        raise ArtifactError('artifact transport failed at ' + kind) from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def upload_archive(archive, size, digest, environment, transport=https_request):
    if environment.get('GITHUB_REPOSITORY') != REPOSITORY or not re.fullmatch(r'[1-9][0-9]{0,19}', environment.get('GITHUB_RUN_ID', '')):
        raise ArtifactError('exact current repository run required')
    if environment.get('ACTIONS_RESULTS_URL', '').rstrip('/') != 'https://' + SERVICE_HOST:
        raise ArtifactError('expected GitHub artifact service unavailable')
    token = environment.get('ACTIONS_RUNTIME_TOKEN')
    ids = backend_ids(token)
    name = 'reviewed-esbuild-0.28.1-go1.26.11-' + environment['GITHUB_RUN_ID']
    def rpc(method, data):
        body = json.dumps(data, separators=(',', ':')).encode()
        reply = unique_json(transport('https://' + SERVICE_HOST + '/twirp/github.actions.results.api.v1.ArtifactService/' + method,
                                      'POST', {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                               'Content-Length': str(len(body))}, body, 'rpc'))
        if not isinstance(reply, dict) or reply.get('ok') is not True:
            raise ArtifactError('artifact service rejected ' + method)
        return reply
    expires = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat().replace('+00:00', 'Z')
    created = rpc('CreateArtifact', dict(ids, name=name, version=7, mime_type='application/zip', expires_at=expires))
    signed_url = created.get('signed_upload_url', created.get('signedUploadUrl'))
    if not isinstance(signed_url, str) or len(signed_url) > 16384:
        raise ArtifactError('artifact upload location unavailable')
    with archive.open('rb') as source:
        transport(signed_url, 'PUT', {'Content-Type': 'application/zip', 'Content-Length': str(size),
                                      'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-12-02'}, source, 'blob')
    if archive.stat().st_size != size or sha256(archive) != digest:
        raise ArtifactError('runtime archive changed during transfer')
    final = rpc('FinalizeArtifact', dict(ids, name=name, size=str(size), hash='sha256:' + digest))
    identifier = str(final.get('artifact_id', final.get('artifactId', '')))
    if not re.fullmatch(r'[1-9][0-9]{0,19}', identifier):
        raise ArtifactError('artifact identifier unavailable')
    return dict(name=name, artifact_id=identifier, archive_bytes=size, archive_sha256=digest,
                artifact_url='https://github.com/' + REPOSITORY + '/actions/runs/' + environment['GITHUB_RUN_ID'] + '/artifacts/' + identifier,
                retention_days=7, runtime_files=6, license_files=3, signing_invoked=False,
                credential_files_in_artifact=False, auth_scope='current-run-artifact-service-only',
                thirdparty_uploader_executed=False, release_published=False)


def upload(directory):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise ArtifactError('current isolated CI job required')
    with tempfile.TemporaryDirectory(prefix='stellar-runtime-artifact-', dir=Path(directory).parent) as temporary:
        archive = Path(temporary) / 'reviewed-runtimes.zip'
        size, digest = pack_reviewed(directory, archive)
        # Only the current job's related artifact credential and public context
        # are accessed; no GitHub PAT, cloud login, signing key or user vault.
        environment = {key: os.environ.get(key, '') for key in (
            'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'ACTIONS_RESULTS_URL', 'ACTIONS_RUNTIME_TOKEN')}
        return upload_archive(archive, size, digest, environment)
