"""Synthetic archive/HTTP tests; no real tokens, signing keys or network."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('artifact_transfer', ROOT / 'scripts/upload-reviewed-runtime.py')
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


def synthetic_token():
    payload = {'scp': 'Actions.Results:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002'}
    return 'synthetic.' + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=') + '.synthetic'


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.files = self.root / 'files'
        self.files.mkdir()
        self.runtimes, self.licenses = {}, {}
        for table, names in [(self.runtimes, transfer.RUNTIMES), (self.licenses, transfer.LICENSES)]:
            for name in names:
                raw = ('synthetic owned fixture ' + name).encode()
                (self.files / name).write_bytes(raw)
                table[name] = (len(raw), hashlib.sha256(raw).hexdigest())
        self.patches = [patch.object(transfer, 'RUNTIMES', self.runtimes), patch.object(transfer, 'LICENSES', self.licenses)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        targets = {}
        for name, (size, digest) in self.runtimes.items():
            target = name.removeprefix('esbuild-').removesuffix('.exe').replace('-', '/')
            targets[target] = dict(filename=name, bytes=size, sha256=digest)
        self.manifest = dict(schema=1, targets=targets, source_built=True,
                             independently_reproduced=True, published=False, release_approved=False)
        self.save_manifest()
        self.archive = self.root / 'runtime.zip'

    def save_manifest(self):
        (self.files / 'runtime-manifest.json').write_text(json.dumps(self.manifest))

    def test_complete_archive_reverified_and_hashed(self):
        size, digest = transfer.pack_reviewed(self.files, self.archive)
        self.assertEqual(size, self.archive.stat().st_size)
        self.assertEqual(digest, hashlib.sha256(self.archive.read_bytes()).hexdigest())
        with self.assertRaises(FileExistsError):
            transfer.pack_reviewed(self.files, self.archive)

    def test_extra_input_is_rejected_before_archive_write(self):
        (self.files / '.env').write_bytes(b'synthetic fixture only')
        with self.assertRaisesRegex(transfer.ArtifactError, 'ten-file'):
            transfer.pack_reviewed(self.files, self.archive)
        self.assertFalse(self.archive.exists())

    def test_modified_runtime_and_symlink_rejected(self):
        name = next(iter(self.runtimes))
        path = self.files / name
        original = path.read_bytes()
        path.write_bytes(b'changed')
        with self.assertRaises(transfer.ArtifactError):
            transfer.pack_reviewed(self.files, self.archive)
        path.unlink()
        other = self.root / 'other'
        other.write_bytes(original)
        path.symlink_to(other)
        with self.assertRaises(transfer.ArtifactError):
            transfer.pack_reviewed(self.files, self.archive)

    def test_manifest_cannot_carry_extra_data_or_claim_release_approval(self):
        for key, value in [('unexpected', 'synthetic'), ('release_approved', True), ('schema', True)]:
            previous = self.manifest.copy()
            self.manifest[key] = value
            self.save_manifest()
            with self.assertRaises(transfer.ArtifactError):
                transfer.pack_reviewed(self.files, self.archive)
            self.manifest = previous

    def test_routing_claims_do_not_accept_ambiguous_or_unrelated_tokens(self):
        ids = transfer.backend_ids(synthetic_token())
        self.assertEqual(len(ids), 2)
        for invalid in ['synthetic-invalid', 'x.' + base64.urlsafe_b64encode(b'{"scp":"unrelated"}').decode() + '.x']:
            with self.assertRaises(transfer.ArtifactError) as result:
                transfer.backend_ids(invalid)
            self.assertNotIn(invalid, str(result.exception))

    def test_authentication_never_forwarded_to_blob_and_public_result_only(self):
        size, digest = transfer.pack_reviewed(self.files, self.archive)
        calls = []
        def transport(url, method, headers, body, kind):
            calls.append((url, method, headers, kind))
            if kind == 'blob':
                self.assertNotIn('Authorization', headers)
                self.assertEqual(body.read(), self.archive.read_bytes())
                return b''
            data = json.loads(body)
            if url.endswith('/CreateArtifact'):
                self.assertEqual(data['version'], 7)
                self.assertEqual(data['mime_type'], 'application/zip')
                return json.dumps(dict(ok=True, signed_upload_url='https://fixture.blob.core.windows.net/a?sig=synthetic')).encode()
            self.assertEqual(data['hash'], 'sha256:' + digest)
            return b'{"ok":true,"artifact_id":"123"}'
        environment = dict(GITHUB_REPOSITORY=transfer.REPOSITORY, GITHUB_RUN_ID='1234',
                           ACTIONS_RESULTS_URL='https://' + transfer.SERVICE_HOST + '/', ACTIONS_RUNTIME_TOKEN=synthetic_token())
        result = transfer.upload_archive(self.archive, size, digest, environment, transport)
        self.assertEqual([row[3] for row in calls], ['rpc', 'blob', 'rpc'])
        self.assertNotIn('synthetic', json.dumps(result))
        self.assertEqual(result['artifact_id'], '123')
        self.assertFalse(result['credential_files_in_artifact'])

    def test_wrong_service_or_auth_destination_rejected_without_network(self):
        with patch.object(transfer.http.client, 'HTTPSConnection') as network:
            for url, method, headers, kind in [
                ('http://' + transfer.SERVICE_HOST + '/', 'POST', {}, 'rpc'),
                ('https://other.invalid/twirp/a', 'POST', {}, 'rpc'),
                ('https://fixture.blob.core.windows.net/a', 'PUT', {'Authorization': 'synthetic'}, 'blob'),
                ('https://fixture.blob.core.windows.net.evil.invalid/a', 'PUT', {}, 'blob'),
                ('https://user@fixture.blob.core.windows.net/a', 'PUT', {}, 'blob'),
            ]:
                with self.assertRaises(transfer.ArtifactError):
                    transfer.https_request(url, method, headers, b'', kind)
            network.assert_not_called()

    def test_service_failures_cannot_echo_signed_urls_or_credential_headers(self):
        with patch.object(transfer.http.client, 'HTTPSConnection', side_effect=RuntimeError('synthetic sensitive service detail')):
            with self.assertRaises(transfer.ArtifactError) as result:
                transfer.https_request('https://fixture.blob.core.windows.net/a?sig=synthetic', 'PUT', {}, io.BytesIO(), 'blob')
            self.assertEqual(str(result.exception), 'artifact transport failed at blob')


if __name__ == '__main__':
    unittest.main()
