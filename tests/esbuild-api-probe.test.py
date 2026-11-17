"""Validate the first-party CI boundary without executing Node or esbuild."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class ApiProbeBoundaryTests(unittest.TestCase):
    def test_all_workflow_inputs_match_exact_source_hashes(self):
        workflow = (ROOT / '.github/workflows/esbuild-patched-source-build.yml').read_text()
        lines = workflow.split('        run: |\n', 1)[1].splitlines()
        tree = ast.parse('\n'.join(line[10:] for line in lines))
        assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'files' for target in node.targets))
        files = ast.literal_eval(assignment.value)
        self.assertEqual(len(files), 14)
        for name, (expected, maximum) in files.items():
            data = (ROOT / name).read_bytes()
            self.assertLessEqual(len(data), maximum)
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected)
        self.assertIn('permissions: {}', workflow)

    def test_builder_identity_matches_review_plan(self):
        plan = json.loads((ROOT / 'native/codeql/esbuild-rebuild-plan.json').read_text())
        self.assertEqual(hashlib.sha256((ROOT / 'scripts/build-reviewed-esbuild.py').read_bytes()).hexdigest(), plan['script_sha256'])
        self.assertEqual(len(plan['expected_target_sha256']), 6)

    def test_target_probe_is_rejected_outside_explicit_ci_scope(self):
        spec = importlib.util.spec_from_file_location('reviewed_api_probe', ROOT / 'scripts/probe-reviewed-esbuild-api.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        linux = types.SimpleNamespace(sysname='Linux', machine='x86_64')
        with patch.object(module.os, 'uname', return_value=linux), patch.dict(module.os.environ, {}, clear=True), \
                patch.object(module, 'load', side_effect=AssertionError('runtime must not be loaded')):
            with self.assertRaisesRegex(ValueError, 'fresh Linux CI VM required'):
                module.probe(Path('/unused'), Path('/unused'))


if __name__ == '__main__':
    unittest.main()
