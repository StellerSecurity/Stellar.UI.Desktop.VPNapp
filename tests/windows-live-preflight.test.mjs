import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('Windows environment preflight cannot mutate network, install software or claim a live pass', () => {
  const script = read('scripts/windows-live-preflight.ps1');
  for (const name of ['vpnLiveTest', 'killSwitchLiveTest', 'dnsLeakTest', 'ipv4LeakTest', 'ipv6LeakTest', 'sleepResumeTest', 'networkHandoverTest']) {
    assert(script.includes(`${name} = 'not-run'`), name);
  }
  assert(!/\b(?:Set|New|Remove|Disable|Enable|Restart|Stop|Start)-(?:Net\w*|Service|Computer)|msiexec|InstallProduct|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|Add-Type|secrets\./i.test(script));
  assert(script.includes("& $powercfg '/a'"));
  assert(script.includes("Get-Service -Name 'StellarVPNDesktop'"));
  assert(script.includes('$os.ProductType -ne 1'));
  assert(script.includes('failed IPv6 probe would not prove leak protection'));
  assert(script.includes('releaseApproved = $false'));
});
test('hosted preflight fetches only pinned first-party code and has no privileged actions', () => {
  const workflow = read('.github/workflows/windows-live-preflight.yml');
  assert(workflow.includes('permissions: {}'));
  assert(workflow.includes(createHash('sha256').update(read('scripts/windows-live-preflight.ps1')).digest('hex')));
  assert(!/uses:|secrets\.|sudo|InstallProduct|msiexec/i.test(workflow));
});
