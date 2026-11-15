"""Exercise IPC source identity and require real, nonempty model bindings."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ipc_models', ROOT / 'scripts/stage-tauri-ipc-models.py')
models = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(models)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'
        self.profile = dict(files=[])
        fixtures = [
            '#[tauri::command]\npub async fn login(token: String, expiry: u64, app: AppHandle) {}\n',
            '#[tauri::command]\npub fn check(app: tauri::AppHandle) {}\n',
        ]
        for relative, text in zip(models.SOURCES, fixtures):
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            self.profile['files'].append(dict(path=relative, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))

    def test_every_json_parameter_is_modeled_and_app_handle_is_excluded(self):
        result = models.inventory(self.source, self.profile)
        self.assertEqual(result['data'], [
            ['stellar_vpn_desktop::commands::login', 'Parameter[0]', 'remote', 'manual'],
            ['stellar_vpn_desktop::commands::login', 'Parameter[1]', 'remote', 'manual'],
        ])
        self.assertEqual(len(result['commands']), 2)

    def test_changed_source_rejected(self):
        (self.source / models.SOURCES[0]).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'reviewed application inputs'):
            models.inventory(self.source, self.profile)

    def test_unknown_command_syntax_cannot_silently_disappear(self):
        path = self.source / models.SOURCES[0]
        path.write_text(path.read_text() + '#[tauri::command]\nfn unsupported() {}')
        self.profile['files'][0]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'unaccounted IPC'):
            models.inventory(self.source, self.profile)

    def test_commands_in_another_source_file_require_explicit_modeling(self):
        path = self.source / 'src-tauri/src/extra.rs'
        path.write_text('#[tauri :: command]\npub fn extra(value: String) {}')
        self.profile['files'].append(dict(path='src-tauri/src/extra.rs',
            sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        with self.assertRaisesRegex(ValueError, 'unaccounted IPC source file'):
            models.inventory(self.source, self.profile)

    def test_duplicate_commands_rejected(self):
        path = self.source / models.SOURCES[0]
        path.write_text(path.read_text() * 2)
        self.profile['files'][0]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'duplicate IPC command'):
            models.inventory(self.source, self.profile)

    def test_source_symlink_rejected(self):
        path = self.source / models.SOURCES[0]
        path.unlink()
        path.symlink_to(self.source / models.SOURCES[1])
        with self.assertRaisesRegex(ValueError, 'regular Rust source'):
            models.inventory(self.source, self.profile)

    def test_all_parameter_bindings_required(self):
        rows = models.inventory(self.source, self.profile)['data']
        expected = [['stellar_vpn_desktop::commands::login', 0], ['stellar_vpn_desktop::commands::login', 1]]
        result = models.validate_bindings({'#select': {'tuples': expected}}, rows)
        self.assertEqual(len(result), 2)
        for observed in ([], expected[:1], expected + [['unknown', 0]]):
            with self.subTest(observed=observed), self.assertRaisesRegex(ValueError, 'every expected parameter'):
                models.validate_bindings({'#select': {'tuples': observed}}, rows)

    def test_duplicate_or_malformed_bindings_are_rejected(self):
        rows = models.inventory(self.source, self.profile)['data']
        for observed in ([['a', 0], ['a', 0]], [['a', True]], [['a', '0']], [['a', -1]]):
            with self.subTest(observed=observed), self.assertRaisesRegex(ValueError, 'invalid or duplicate'):
                models.validate_bindings({'#select': {'tuples': observed}}, rows)

    def test_staging_adds_only_sources_and_no_downloads_or_compiled_inputs(self):
        destination = Path(self.temp.name) / 'packs'
        (destination / 'rust-queries').mkdir(parents=True)
        (destination / 'rust-queries/codeql-pack.lock.yml').write_text('lockVersion: 1.0.0\ncompiled: false\n')
        result = models.stage(self.source, destination, self.profile)
        self.assertTrue(result['source_only'])
        model = json.loads((destination / 'stellar-tauri-ipc-models/ipc.model.json').read_bytes())
        self.assertEqual(model['extensions'][0]['addsTo']['extensible'], 'sourceModel')
        self.assertEqual(len(model['extensions']), 1)
        self.assertEqual(result['neutral_or_barrier_models'], 0)
        self.assertFalse(list(destination.rglob('*.qlx')))
        with self.assertRaisesRegex(ValueError, 'fresh application model'):
            models.stage(self.source, destination, self.profile)

    def test_real_application_inventory_is_complete_and_bound(self):
        profile = json.loads((ROOT / 'native/codeql/windows-app-source-inputs.json').read_bytes())
        result = models.inventory(ROOT, profile)
        self.assertGreater(len(result['commands']), 30)
        self.assertGreater(len(result['data']), 20)
        self.assertIn(['stellar_vpn_desktop::commands::prepare_vpn_configuration', 'Parameter[1]', 'remote', 'manual'], result['data'])


if __name__ == '__main__':
    unittest.main()
