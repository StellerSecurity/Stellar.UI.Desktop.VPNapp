"""Reject dependency drift and native/hook reintroduction in the source-fork graph."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('source_lock', ROOT / 'scripts/esbuild-source-lock-probe.py')
lock = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lock)


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.before = dict(lockfileVersion=3, packages={
            '': dict(name='app', devDependencies=dict(vite='7.3.7')),
            'node_modules/vite': dict(version='7.3.7', integrity='known'),
            'node_modules/esbuild': dict(version='0.28.1'),
            'node_modules/@esbuild/linux-x64': dict(version='0.28.1'),
        })
        self.after = dict(lockfileVersion=3, packages={
            '': dict(name='app', devDependencies=dict(vite='7.3.7', esbuild='file:vendor/esbuild-reviewed')),
            'node_modules/vite': dict(version='7.3.7', integrity='known'),
            'node_modules/esbuild': dict(resolved='vendor/esbuild-reviewed', link=True),
            'vendor/esbuild-reviewed': dict(version='0.28.1-stellar.1'),
        })

    def test_exact_source_substitution_keeps_other_dependencies(self):
        result = lock.validate_graph(self.before, self.after)
        self.assertEqual(result['removed_platform_packages'], 1)
        self.assertEqual(result['unrelated_locked_dependencies_unchanged'], 1)

    def test_unrelated_integrity_or_version_drift_rejected(self):
        for field in ('version', 'integrity'):
            changed = copy.deepcopy(self.after)
            changed['packages']['node_modules/vite'][field] = 'changed'
            with self.assertRaisesRegex(ValueError, 'unrelated locked dependency'):
                lock.validate_graph(self.before, changed)

    def test_new_dependencies_and_platform_binaries_remain_blocked(self):
        for name in ('node_modules/unreviewed', 'node_modules/@esbuild/linux-x64'):
            changed = copy.deepcopy(self.after)
            changed['packages'][name] = dict(version='1.0.0')
            with self.assertRaisesRegex(ValueError, 'unexpected dependencies or platform'):
                lock.validate_graph(self.before, changed)

    def test_esbuild_cannot_resolve_outside_contained_source(self):
        self.after['packages']['node_modules/esbuild']['resolved'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'contained source'):
            lock.validate_graph(self.before, self.after)

    def test_source_fork_cannot_reintroduce_hooks_or_dependencies(self):
        for field, value in [('hasInstallScript', True), ('dependencies', {}), ('optionalDependencies', {})]:
            changed = copy.deepcopy(self.after)
            changed['packages']['vendor/esbuild-reviewed'][field] = value
            with self.assertRaisesRegex(ValueError, 'dependencies or hooks'):
                lock.validate_graph(self.before, changed)

    def test_root_dependency_drift_rejected(self):
        self.after['packages']['']['devDependencies']['unreviewed'] = '1.0.0'
        with self.assertRaisesRegex(ValueError, 'root dependency changes'):
            lock.validate_graph(self.before, self.after)

    def test_unknown_lock_schema_rejected(self):
        self.after['lockfileVersion'] = 2
        with self.assertRaisesRegex(ValueError, 'v3 lock graphs'):
            lock.validate_graph(self.before, self.after)


if __name__ == '__main__':
    unittest.main()
