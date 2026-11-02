// First-party packaging using only the installed Node runtime and macOS tools.
// Does not mount, install, launch, sign, notarise or bypass macOS protections.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const packages = JSON.parse(execFileSync(process.execPath, ['scripts/package-macos-installer.mjs'], { encoding: 'utf8' }));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-dmg-'));
fs.copyFileSync(packages.installer, path.join(stage, 'Install Stellar VPN.pkg'));
fs.copyFileSync(packages.uninstaller, path.join(stage, 'Uninstall Stellar VPN.pkg'));
fs.writeFileSync(path.join(stage, 'START-HERE.txt'), `STELLAR VPN — LOKAL TEST

macOS / Apple Silicon (ARM64). Version ${packages.version}.
Ingen Developer ID-signering eller notarisering. Ikke en offentlig release.

1. Luk Stellar VPN helt, før du installerer eller afinstallerer.
   En aktiv VPN-forbindelse bliver afbrudt, når du lukker appen.
2. Åbn "Install Stellar VPN.pkg". macOS beder om administratorgodkendelse.
   Pakken installerer appen i Programmer og en privilegeret systemhjælper,
   som kører i baggrunden. En lokal firewallkontrol kan kort afbryde netværket.
3. Åbn Stellar VPN fra Programmer. Når systemhjælperen er klar, går appen
   direkte til det almindelige loginvindue, uden en obligatorisk guide.
4. Hvis hjælperen mangler eller ikke svarer, vises hjælp og "Prøv igen".
   Sproget følger macOS ved første opstart; et gemt sprogvalg bevares.

Login er ikke det samme som en aktiv VPN-forbindelse. Denne testbuild bruger
projektets konfigurerede staging-API. Kill switch kræver bestået systemkontrol.
Eksisterende login og indstillinger kan blive genbrugt; dette nulstiller ikke
din konto eller nøglering og er ikke en ren installations-test på denne Mac.

macOS kan blokere usignerede pakker eller appen. Denne DMG ændrer ikke
Gatekeeper, karantæne eller andre sikkerhedsindstillinger. Ved blokering:
stop og notér den præcise besked; en signeret testbuild kan blive nødvendig.

AFINSTALLATION (valgfrit)
Luk Stellar VPN helt og åbn "Uninstall Stellar VPN.pkg".
Den fjerner appen, systemhjælperen og Stellars netværksregler.
Kontodata og lokale præferencer bevares. Abonnementet opsiges ikke.
Eventuelt automatisk start-login-element fjernes ikke af denne testpakke.
`);
const dmg = path.join(path.dirname(packages.installer), `Stellar-VPN-${packages.version}-macos-arm64-unsigned-test.dmg`);
execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Stellar VPN Test', '-srcfolder', stage, '-format', 'UDZO', dmg], { stdio: 'inherit' });
execFileSync('/usr/bin/hdiutil', ['verify', dmg], { stdio: 'inherit' });
const result = { ...packages, dmg, dmgSha256: createHash('sha256').update(fs.readFileSync(dmg)).digest('hex'),
  dmgBytes: fs.statSync(dmg).size, appBuiltWith: '--debug --bundles app --no-sign', appSignature: 'linker ad-hoc; no Developer ID or team identifier', developerIDSigned: false, installed: false };
fs.writeFileSync(path.join(path.dirname(dmg), 'manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
