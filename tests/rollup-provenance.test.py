"""Fail-closed public metadata preparation and verification scope regressions."""
import base64
import importlib.util
import json
from pathlib import Path
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('public_tuf', ROOT / 'scripts/prepare-sigstore-public-metadata.py')
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class Response:
    status = 200

    def __init__(self, url, data):
        self.url, self.data = url, data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def geturl(self):
        return self.url

    def read(self, size):
        return self.data[:size]


class MetadataTests(unittest.TestCase):
    def seed(self):
        raw = json.dumps({'signed': {'version': 14, 'consistent_snapshot': True}}).encode()
        return {'root.json': base64.b64encode(raw).decode()}

    def test_forbidden_status_does_not_end_root_rotation(self):
        def request(url, **kwargs):
            raise urllib.error.HTTPError(url, 403, 'forbidden', {}, None)
        with self.assertRaises(urllib.error.HTTPError):
            metadata.prepare(self.seed(), request)

    def test_cross_origin_redirect_rejected(self):
        with self.assertRaisesRegex(ValueError, 'origin'):
            metadata.prepare(self.seed(), lambda url, **kwargs: Response('https://other.invalid', b'{}'))

    def test_oversized_metadata_rejected(self):
        with self.assertRaisesRegex(ValueError, 'size'):
            metadata.prepare(self.seed(), lambda url, **kwargs: Response(url, b'x' * (1024 * 1024 + 1)))

    def test_root_version_mismatch_rejected(self):
        raw = json.dumps({'signed': {'version': 16}}).encode()
        with self.assertRaisesRegex(ValueError, 'version mismatch'):
            metadata.prepare(self.seed(), lambda url, **kwargs: Response(url, raw))

    def test_transport_is_not_claimed_authentic(self):
        digest = 'a' * 64
        table = {
            'timestamp.json': {'signed': {'meta': {'snapshot.json': {'version': 3}}}},
            '3.snapshot.json': {'signed': {'meta': {'targets.json': {'version': 4}}}},
            '4.targets.json': {'signed': {'targets': {'trusted_root.json': {'hashes': {'sha256': digest}}}}},
            'targets/' + digest + '.trusted_root.json': {'test_fixture': True},
        }
        def request(url, **kwargs):
            relative = url.removeprefix(metadata.ORIGIN + '/')
            if relative == '15.root.json':
                raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
            return Response(url, json.dumps(table[relative]).encode())
        result = metadata.prepare(self.seed(), request)
        self.assertFalse(result['signatures_verified'])
        self.assertEqual(result['latest_claimed_root_version'], 14)
        self.assertEqual(len(result['responses']), 5)


if __name__ == '__main__':
    unittest.main()
