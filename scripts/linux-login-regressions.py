"""Run the exact PR13 first-party login tests without network or native vaults."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('reviewed ephemeral Linux only')
    plan = json.loads((ROOT / 'login-regression-plan.json').read_text())
    if (plan['commit'] != '551950c7c71a8a8b28b921725b53c10d5e1792b0'
            or plan['repository'] != 'StellerSecurity/Stellar.UI.Desktop.VPNapp'
            or len(plan['tests']) != 7 or len(plan['files_sha256']) != 18):
        raise ValueError('exact PR13 fixed-input tests only')
    tool = module('reviewed_tool', 'linux-npm-backport-probe.py')
    patcher = module('reviewed_patcher', 'patch-reviewed-npm-tool.py')
    npm = tool.download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', tool.NPM_SHA, 8 * 1024**2)
    node = tool.download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', tool.NODE_ARCHIVE_SHA, 64 * 1024**2)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), tool.NoRedirect())
    with tempfile.TemporaryDirectory(prefix='stellar-synthetic-login-', dir=ROOT) as directory:
        work = Path(directory).resolve()
        (work / 'tmp').mkdir()
        records, _, executable = tool.materialize_runtime(work, npm, node, patcher)
        project = work / 'project'
        project.mkdir()
        (project / 'package.json').write_text('{"type":"module","private":true}\n')
        for relative, expected in plan['files_sha256'].items():
            if not re.fullmatch(r'(?:src|tests)/[A-Za-z0-9_/.-]+\.ts', relative) or '..' in relative.split('/'):
                raise ValueError('contained first-party TypeScript inputs only')
            url = 'https://raw.githubusercontent.com/' + plan['repository'] + '/' + plan['commit'] + '/' + relative
            with opener.open(url, timeout=30) as response:
                raw = response.read(256 * 1024 + 1)
                if response.geturl() != url or len(raw) > 256 * 1024 or hashlib.sha256(raw).hexdigest() != expected:
                    raise ValueError('frozen PR13 source drift')
            destination = project / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        env = dict(PATH='/usr/bin:/bin', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC')
        command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                   '--no-addons', '--disable-sigusr1', '--max-old-space-size=256',
                   '--experimental-strip-types', '--test-isolation=none', '--test', '--test-reporter=tap',
                   '--test-timeout=10000', *plan['tests']]
        output = tool.run(command, project, env, 45)
        passed = re.search(r'^# pass (\d+)$', output, re.MULTILINE)
        failed = re.search(r'^# fail (\d+)$', output, re.MULTILINE)
        if passed is None or int(passed[1]) < 25 or failed is None or failed[1] != '0':
            raise ValueError('incomplete synthetic auth test result: ' + output[-4000:])
        for relative, expected in records.items():
            tool.verified(work / 'npm' / relative, expected)
        for relative, expected in plan['files_sha256'].items():
            tool.verified(project / relative, expected)
        print(json.dumps(dict(commit=plan['commit'], tests_passed=int(passed[1]), failed=0,
                              firstparty_source_files_unchanged=len(plan['files_sha256']),
                              network_allowed=False, child_processes_allowed=False, filesystem_writes_allowed=False,
                              native_vaults_accessed=False, mac_app_changed=False, synthetic_fetch_only=True,
                              proves_real_reboot=False, package_installation=False, hooks_executed=False,
                              release_approved=False)))


if __name__ == '__main__':
    main()
