# Stellar VPN Desktop

Stellar VPN is a desktop VPN application built with React, TypeScript, Tauri and
Rust. It provides a server map, connection controls, account access, settings
and signed software updates. Native helpers perform privileged VPN and firewall
operations separately from the interface.

This is the release guide for **future updates**. Use the version, source commit,
runtime inputs, certificates and test evidence for the release you are preparing.
Previously published artifacts are immutable; never overwrite them with a rebuild.

## Project structure

- Default branch: `main` in [Stellar.UI.Desktop.VPNapp](https://github.com/StellerSecurity/Stellar.UI.Desktop.VPNapp).
- Application identifier: `org.stellarsecurity.vpn.desktop`. Keep it stable for upgrades.
- `src/`: interface, domain types, application services and infrastructure adapters.
- `src-tauri/`: native commands, protected session storage and signed updater.
- `crates/stellar-core/`: shared Rust application logic.
- `crates/stellar-vpn-helper/`: native VPN/helper implementation.
- `native/windows/`: Windows service, bridge, firewall and installer integration.
- `scripts/`: validation, build, packaging and release preparation tools.
- `tests/`: application, native integration and release-tooling tests.
- `vendor/`: reviewed source backports and their integrity records.
- `desktop-api/` and `api-upgrades/`: backend integration/support sources.

Production API configuration is in `src/infrastructure/config/Production.ts`.
Desktop releases and backend deployment are separate operations. Confirm required
backend capabilities before offering an app update.

Runtime binaries, generated packages, signing keys, credentials, build outputs
and local acceptance evidence are not stored in this repository. The root README
is approved for publication; other Markdown documents remain local and untracked.

## 1. Prepare the release

Use an isolated checkout of `main` and create a `stellar/` working branch. Select
an exact reviewed source commit for the build. Do not discard work on a signing
machine to update it.

Choose a new application version higher than the versions you intend to update.
Synchronize it in:

- `package.json` and both root version fields in `package-lock.json`.
- `src-tauri/Cargo.toml` and the app package entry in `Cargo.lock`.
- `src-tauri/tauri.conf.json`.

Helper crate versions are independent. Do not bump unrelated dependencies just
to change the app version. After editing and reviewing the version files:

```sh
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
SOURCE_COMMIT=$(git rev-parse HEAD)
printf 'Release %s from %s\n' "$VERSION" "$SOURCE_COMMIT"
```

Record the target platforms, architectures, minimum operating systems, runtime
hashes, toolchains and expected output names in the release plan. Confirm that
manifest version values match the actual packaged app.

### Dependencies and tools

Use the exact lockfiles and a reviewed installed Node/Rust/native toolchain.
Check `package.json` and `Cargo.toml` for the declared minimum versions; those
minimums alone do not prove every locked dependency builds with that compiler.

Before downloading, installing, updating or executing a new third-party input,
complete the user's dependency security review and obtain explicit approval for
its exact version and command. This includes missing Rust targets, SDKs, driver
packages, runtime archives, signing tools and package lifecycle scripts.

After review and approval, a fresh Node setup normally uses:

```sh
npm ci --ignore-scripts
```

That example is not standing installation approval. Keep Rust builds locked and
offline once reviewed inputs are prepared. If an input is missing, stop and
review it; do not remove the flags or replace it with an unreviewed download.

### Shared checks

With reviewed dependencies already installed:

```sh
npm run typecheck
npm test
npm run check:architecture
npm run test:ota
node --test tests/macos-architecture.test.mjs tests/app-identity.test.mjs
```

Use `npm run dev` for a browser preview and `npm run desktop:dev` for native
work after preparing platform inputs. A browser preview cannot validate the
privileged helper, OS credential vault or actual VPN connection.

## 2. Release macOS

### Prepare the runtime and helper

Select one architecture per build and use matching runtime inputs:

| Architecture | Rust target | Packaging architecture | OTA target |
| --- | --- | --- | --- |
| Apple Silicon | `aarch64-apple-darwin` | `arm64` | `darwin-aarch64` |
| Intel | `x86_64-apple-darwin` | `x86_64` | `darwin-x86_64` |

For example, select Apple Silicon in the signing shell:

```sh
ARCH=arm64
TARGET=aarch64-apple-darwin
OTA_TARGET=darwin-aarch64
RUNTIME="$PWD/src-tauri/resources/openvpn-runtime"
```

Intel uses its own reviewed runtime directory, normally
`src-tauri/resources/openvpn-runtime-x86_64`. Never reuse ARM64 files for Intel.

Obtain the approved runtime for this release through an authorized transfer.
Verify the archive hash and safe archive paths before extraction. Verify every
file against `runtime-manifest.json`, including actual Mach-O architecture and
minimum macOS version, and ensure dependencies resolve only to bundled libraries
or macOS system libraries. A newer SDK or host name in `openvpn --version` is not
the binary's minimum operating system.

The app minimum is declared in `src-tauri/tauri.conf.json`. The runtime verifier
in `scripts/macos-architecture.mjs` currently enforces macOS 12.0. Keep the two
consistent through a reviewed change if the supported minimum ever changes.
Do not edit Mach-O version fields to pretend a binary supports an older OS.

```sh
node scripts/build-macos-test.mjs --arch "$ARCH" --profile release \
  --runtime "$RUNTIME" --check
```

A source-runtime rebuild requires separate approval of its pinned archives,
patches and execution. Review `scripts/build-arm64-runtime.py` and its input
lock before use; it is an ARM64 build recipe, not an Intel recipe or a universal
approval for future dependency versions.

For an unsigned local test candidate only:

```sh
node scripts/build-macos-test.mjs --arch "$ARCH" --profile release --runtime "$RUNTIME"
```

This script clears Apple signing variables, generates an unsigned helper
package and stages DMG inputs. It is not the production signing workflow.
The other `package-macos-installer.mjs`/`package-macos-dmg.mjs` scripts prepare
local ARM64 debug test packages; do not mistake them for a final release.

### Sign in the correct order

Use the approved signing machine with valid Developer ID Application and
Developer ID Installer identities, the existing notarization Keychain profile,
and the established OTA key. Verify the intended Apple team and certificate
validity for each release. Do not hardcode an expired certificate fingerprint.

Set `APP_IDENTITY`, `INSTALLER_IDENTITY` and `NOTARY_PROFILE` locally to the
intended existing identities/profile. Keep private keys and passwords out of
Git, logs and chat. Never use shell tracing, password arguments or shell-history
lookup. New certificate issuance or Keychain access grants require their own
authorization.

1. Build the native helper using the reviewed locked toolchain.
2. Verify the original runtime hashes; retain the original manifest separately.
3. Sign each nested runtime binary and the helper with Developer ID Application,
   timestamp and hardened-runtime settings; verify each signature.
4. Record the signed runtime hashes in its manifest. Signing changes bytes.
5. Package, Installer-sign, notarize and staple the helper package.
6. Finalize its package hash and architecture metadata **before compiling the app**.
7. Build, sign, notarize and staple the app, then create the final containers.

```sh
export CARGO_NET_OFFLINE=true
export MACOSX_DEPLOYMENT_TARGET=$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).bundle.macOS.minimumSystemVersion")
cargo build --locked --offline -p stellar-vpn-helper --target "$TARGET" --release

codesign --force --sign "$APP_IDENTITY" \
  --identifier org.stellarvpn.desktop.helper --timestamp --options runtime \
  "target/$TARGET/release/stellar-vpn-helper"
codesign --verify --strict "target/$TARGET/release/stellar-vpn-helper"

# Complete runtime signing and update its manifest before this packaging step.
node scripts/package-network-helper.mjs --arch "$ARCH" --profile release \
  --helper "target/$TARGET/release/stellar-vpn-helper" --runtime "$RUNTIME"

mv src-tauri/resources/NetworkHelper.pkg NetworkHelper-unsigned.pkg
productsign --sign "$INSTALLER_IDENTITY" --timestamp \
  NetworkHelper-unsigned.pkg src-tauri/resources/NetworkHelper.pkg
pkgutil --check-signature src-tauri/resources/NetworkHelper.pkg
xcrun notarytool submit src-tauri/resources/NetworkHelper.pkg \
  --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple src-tauri/resources/NetworkHelper.pkg
xcrun stapler validate src-tauri/resources/NetworkHelper.pkg
spctl --assess --type install --verbose=2 src-tauri/resources/NetworkHelper.pkg
```

Stop unless Apple returns **Accepted** and the package has the expected signing
team. Write the final package SHA-256 to `NetworkHelper.sha256` and
`packageSha256` in `NetworkHelper.arch.json`; verify the helper hash and
architecture fields too. The app compiles in the package checksum, so replacing
the package after app compilation requires another app build.

```sh
node node_modules/@tauri-apps/cli/tauri.js build --ci \
  --target "$TARGET" --bundles app --no-sign -- --locked --offline

APP="$PWD/target/$TARGET/release/bundle/macos/Stellar VPN.app"
codesign --force --sign "$APP_IDENTITY" --timestamp --options runtime "$APP"
codesign --verify --strict --deep "$APP"
codesign -d --verbose=4 "$APP"
ditto -c -k --keepParent "$APP" app-for-notarization.zip
xcrun notarytool submit app-for-notarization.zip \
  --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
```

This direct CLI call is the macOS final-build step after helper finalization;
it does not authorize evading Windows or Linux gates. Do not rerun the unsigned
test-build script over the finalized helper package. Confirm the bundle ID,
version, architecture, OS minimum, team, timestamp and embedded package hash.

Create a drag-to-Applications DMG from the finalized app in a new staging
folder. Sign and notarize it, staple/validate its ticket, run `hdiutil verify`,
and assess it with Gatekeeper. Verify the nested app and helper independently;
an outer DMG signature is insufficient.

### Create the OTA archive

Use USTAR inside gzip and reject AppleDouble (`._*`), PAX metadata and links.
Some older clients reject archives made by macOS tools that add extra metadata.
Package the finalized, signed and stapled app; compare every archived file with
its source bytes before signing the archive.

```sh
export STELLAR_APP="$APP"
export OTA_ARCHIVE="$PWD/Stellar VPN.app.tar.gz"
python3 - <<'PYCODE'
import gzip, os, tarfile
from pathlib import Path

app = Path(os.environ['STELLAR_APP'])
output = Path(os.environ['OTA_ARCHIVE'])
if app.is_symlink() or not app.is_dir() or app.name != 'Stellar VPN.app':
    raise RuntimeError('Expected a regular Stellar VPN app directory')

def allowed(member):
    parts = Path(member.name).parts
    if (not (member.isfile() or member.isdir())
            or any(p.startswith('._') or p in ('.', '..') for p in parts)):
        raise RuntimeError('Disallowed archive member')
    return member

with output.open('xb') as raw:
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            tar.add(app, arcname=app.name, filter=allowed)

with tarfile.open(output) as tar:
    members = tar.getmembers()
    names = [m.name for m in members]
    assert members and len(names) == len(set(names))
    assert all((m.isfile() or m.isdir())
               and m.name.split('/')[0] == app.name
               and not m.pax_headers for m in members)
    actual = {m.name: tar.extractfile(m).read() for m in members if m.isfile()}
    expected = {str(p.relative_to(app.parent)): p.read_bytes()
                for p in app.rglob('*') if p.is_file()}
    assert actual == expected
PYCODE
```

Set `OTA_KEY_PATH` locally to the existing approved private key. The signer must
provide a secure local password prompt; otherwise stop and review a safe local
wrapper. Do not replace the established OTA key casually: old clients trust its
public counterpart.

```sh
node node_modules/@tauri-apps/cli/tauri.js signer sign \
  --private-key-path "$OTA_KEY_PATH" --app-version "$VERSION" "$OTA_ARCHIVE"
node scripts/prepare-ota-manifest.mjs "$OTA_ARCHIVE" "$OTA_ARCHIVE.sig" \
  "$VERSION" "$OTA_TARGET" > candidate-platform-manifest.json
```

The signed trusted comment must contain `version:<release-version>`. Extract
into an empty test folder, compare all app-file hashes, and recheck signatures,
stapling and Gatekeeper on the extracted app. A regenerated or repacked archive
needs a new detached signature even if its application files did not change.

## 3. Release Windows

The current implementation targets Windows x64. Use the reviewed native MSVC/
Windows SDK toolchain, approved runtime and driver inputs, valid production
signing, and a prepared Windows test environment. Windows ARM emulation in a
Mac VM does not establish native x64 driver or service compatibility.

The per-machine NSIS installer requires administrator consent for the persistent
privileged service. Adapter creation, selection and cleanup must remain scoped
to Stellar and leave other VPN products alone.

Review these files on the exact release commit:

- `native/windows/release-policy.json`
- `scripts/check-windows-release.mjs`
- `scripts/windows-native-compile.ps1` and `scripts/build-windows-helper.mjs`
- `src-tauri/tauri.windows.conf.json` and `native/windows/installer.nsh`

With approved toolchain inputs already present:

```powershell
node scripts/build-windows-helper.mjs
powershell -NoProfile -File scripts/windows-live-preflight.ps1
node scripts/check-windows-release.mjs
```

Compilation is not release acceptance. Preflight is a read-only capability
inventory, not a VPN/leak test. Fulfil the native compile script's approval
requirements and every acceptance item in the release policy, including install/
upgrade/uninstall, credential vault, migration, VPN lifecycle, live kill switch,
crash fail-closed, IPv4/IPv6/DNS leaks, sleep/network changes and update rollback.

The gate binds evidence to the source hash, architecture and runtime manifest.
If policy flags are false, evidence is absent/stale or a required test has not
passed, stop. Do not fabricate an acceptance receipt or change flags merely to
allow packaging. Hosted synthetic checks cannot certify physical sleep or Wi-Fi.

After the reviewed acceptance process makes the gate pass:

```powershell
npm run desktop:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

Use the approved signing service and verify every component required by the
runtime's signature checks, including the privileged helper and installer.
Follow the native packaging requirements for when those signatures are applied.
Never disable signature checks or add a test trust root as a release workaround.

Verify fresh installation, upgrade and uninstall with the signed installer.
Sign the final OTA installer with the established OTA key, and prepare its entry:

```powershell
$Version = node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version"
node scripts/prepare-ota-manifest.mjs Stellar-VPN-setup.exe Stellar-VPN-setup.exe.sig $Version windows-x86_64
```

The tool enforces Windows acceptance as well as the artifact signature. Test the
actual native update, failure and rollback paths before activation.

## 4. Release Linux

Prepare a native Linux environment with reviewed distribution-specific GTK,
WebKit and other system dependencies plus the reviewed Rust/Node inputs. Select
and validate a Linux runtime/helper and firewall integration; binaries from
macOS or Windows cannot substitute.

The current workspace uses a local glib security backport. Read its provenance
manifest under `vendor/`, verify the exact source inventory and lockfile
selection, and run both tooling checks and native regressions:

```sh
npm run check:linux-security
npm run test:linux-security
cargo test --locked --offline -p stellar-vpn-desktop --test linux_glib_backport
cargo test --locked --offline --release -p stellar-vpn-desktop --test linux_glib_backport
```

Complete native debug/release desktop builds and VPN/helper/firewall acceptance
on the supported distributions. Source-hash tests cannot replace native tests.

At the time this guide was written, `scripts/desktop.mjs` intentionally blocks
Linux release builds. Removing that blocker requires a reviewed source change
supported by the missing native evidence. Do not invoke Tauri directly to evade
it. AppImage/DEB targets in configuration are not proof of finished packages.

Linux in-app OTA is not currently implemented in the native updater or manifest
tool. Define and test an approved package/update channel before distribution;
do not point Linux at a macOS or Windows artifact.

## 5. Test an actual update

For each target platform, use the intended old production app and the exact new
signed artifact. Record the machine/OS/architecture, old and new versions,
source commit, artifact hashes and observed results.

- Fresh install, update, relaunch and uninstall.
- Existing login/settings retention and new-user registration.
- Native helper installation/upgrade and final installed-file hashes.
- VPN connect, cancellation, disconnect and subscription expiry.
- Kill switch while connected, after tunnel failure and after process crashes.
- IPv4, IPv6 and DNS leaks; sleep/resume and network changes.
- Invalid signatures, interrupted updates, failed installation and recovery.

Check `src-tauri/legacy-migration.json` for the actual rollout state. Enable
native login migration only after validating the legacy-store read, backend
exchange, durable replacement session and safe cleanup. A failed migration must
retain the old login. Preserved credential fields alone do not prove automatic
migration succeeded.

Test the minimum supported OS and each supported architecture separately. A
current Mac cannot certify an older macOS, and a hosted server VM cannot certify
physical sleep/Wi-Fi. Record unavailable tests as missing, never as passed.

## 6. Stage and publish the release

Release assets are hosted by
[Stellar.Desktop.Releases](https://github.com/StellerSecurity/Stellar.Desktop.Releases).
Download routing is maintained separately in
[Stellar.UI.Download.API](https://github.com/StellerSecurity/Stellar.UI.Download.API).

Prepare immutable versioned artifacts and their new SHA-256 digests. For a Mac
release the publisher may require the OTA archive, its detached signature, DMG,
helper PKG and manifest. Inspect the current publisher's required asset schema;
do not reuse a previous version's names, bytes or pinned hashes by assumption.

In the reviewed release-hosting checkout, validate the exact prepared assets:

```sh
node scripts/vpn-release.cjs verify /path/to/exact-release-assets
```

This command belongs to the release-hosting repository, not the desktop app
checkout. Its current pipeline/input pins can be version-specific. Update them
through review for the new version before using the publisher. Do not replace
checks with the new hashes merely because a mismatch occurred; first establish
why the bytes changed and obtain approval for the exact inputs.

Use the approved Azure pipeline and existing scoped service connection:

1. Stage the reviewed artifacts using `mode=stage` on the selected source.
2. Verify staged downloads, hashes, signatures and platform manifests.
3. Perform the real controlled OTA test and record concrete evidence.
4. Obtain approval to activate that exact release.
5. Run `mode=activate` with a truthful `controlledOtaTest` result identifying the
   tested machine, versions and outcome.
6. Verify public feeds, download aliases and final downloaded bytes afterward.

Keep the publisher's compare-and-swap feed check and recovery journal. Stop on
unexpected feed changes. Do not copy Azure tokens into chat or install a local
cloud CLI just to bypass the existing deployment process.

### Feed and download compatibility

- Legacy clients: `https://desktopreleasesassetsprod.stellarsecurity.com/vpn/latest.json`
- New clients: `https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/latest.json`

Determine which clients the release should reach before activation. Changing the
legacy feed can offer the update to all compatible existing clients, so it is
not a private one-machine test channel. Preserve the established OTA public key,
app identity and platform signing requirements.

The manifest tool generates one platform entry per invocation. Merge reviewed
entries deliberately; do not accidentally delete another supported platform or
restore a paused platform. The updater restricts artifact paths to
`/vpn/desktop-v2/<version>/<target>/`. If a corrected artifact needs a new path,
use an immutable revision under that directory and update JSON deliberately
without changing or substituting its verified signature.

Verify the download service's expected DMG/installer alias separately from OTA
URLs. An alias must serve the same verified signed bytes as the approved release.
A GitHub draft used for runtime handoff is not an activated app release.

Keep the previous approved artifacts and a tested recovery plan. Do not force a
downgrade by editing a manifest to bypass updater rules. Record the final source,
artifact hashes, approvals, native tests and activation result for each release
outside this reusable guide.
