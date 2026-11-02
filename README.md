# Stellar VPN Desktop

Stellar VPN is a desktop VPN application built with React, TypeScript, Tauri and
Rust. The interface provides a server map, connection controls, account access,
settings and signed software updates. Platform-specific network helpers perform
the privileged VPN and firewall work outside the interface process.

This document describes the 0.5.0 project, release requirements and published
macOS release record. The historical procedure below is documentation, not an
instruction to rebuild, republish or overwrite the existing 0.5.0 artifacts.
Build success, notarization and a passing unit-test suite do not by themselves
establish that a platform is ready for public distribution.

## Repository and architecture

- Repository: <https://github.com/StellerSecurity/Stellar.UI.Desktop.VPNapp>
- Default branch: `main`.
- Application identifier: `org.stellarsecurity.vpn.desktop`.
- Application version: `0.5.0`.
- `src/`: React interface, application services, domain types and adapters.
- `src-tauri/`: native commands, protected session storage and signed updater.
- `crates/stellar-core/`: shared Rust application logic.
- `crates/stellar-vpn-helper/`: native VPN/helper implementation.
- `native/windows/`: Windows service, bridge, firewall and installer integration.
- `scripts/`: checks, local builds, packaging and release preparation.
- `tests/`: synthetic application, integration and release-tooling tests.
- `vendor/glib-0.18.5/`: hash-checked Linux security backport.
- `desktop-api/` and `api-upgrades/`: API integration/support sources. Deploying
  the desktop app does not deploy these backend services.

The frontend keeps domain logic separate from UI and infrastructure. Native
commands and platform helpers enforce privileged-operation boundaries. The
production desktop gateway is configured in
`src/infrastructure/config/Production.ts`; anonymous account creation happens
inside the app through that gateway.

Runtime binaries, generated helper packages, signing keys, credentials, build
outputs and local security-acceptance evidence are deliberately absent from Git.
Cloning this repository alone is insufficient to produce a distributable app.

## Current platform status

| Platform | Release status and remaining work |
| --- | --- |
| macOS Apple Silicon | Version 0.5.0 is published. Both OTA feeds offer the corrected ARM64 archive. The signing-machine record reports successful notarization and a controlled 0.2.0 → 0.5.0 upgrade. Live macOS 12 compatibility, full clean-machine VPN/firewall acceptance and automatic login migration remain outstanding. |
| macOS Intel | Separate reviewed x86_64 runtime, helper, build and native acceptance are required. ARM64 artifacts cannot substitute for Intel artifacts. |
| Windows x64 | Distribution is blocked by the checked-in release policy until exact runtime/driver approval and native acceptance are complete. |
| Linux | Release builds are intentionally blocked pending native debug/release validation of the glib backport and the desktop build. In-app OTA updates are not implemented for Linux. |

Recheck the files and evidence on the exact release commit; this table is not
permission to bypass a gate or mark an unavailable test as passed.

## Development and dependency policy

Use the project's pinned dependencies and lockfiles. Node requires at least
22.12.0; React, Vite and Tauri versions are pinned in `package.json`.
`Cargo.lock` pins Rust dependencies, and `Cargo.toml` declares the Rust minimum.
Use an explicitly reviewed installed toolchain rather than assuming the minimum
compiler can build every current locked dependency.

Before any new third-party download, installation, update or execution, complete
the user's dependency security review and obtain explicit approval for the exact
versions and commands. Approval on one machine does not prove another machine's
environment has been reviewed. Never silently upgrade a dependency or enable
package lifecycle scripts.

After that review and approval, a fresh Node installation normally uses:

```sh
npm ci --ignore-scripts
```

Do not run that command merely because it appears here. Missing Rust targets,
native SDKs, installers and VPN runtimes require the same review process.
Offline build commands below assume those inputs are already approved and present.

With reviewed dependencies installed:

```sh
npm run dev
npm run typecheck
npm test
npm run check:architecture
node --test tests/macos-architecture.test.mjs tests/app-identity.test.mjs tests/ota-release.test.mjs
```

`npm run dev` is a browser interface preview, not proof that the privileged VPN
helper or operating-system session storage works. Use `npm run desktop:dev` for
the native application after preparing its platform prerequisites. Do not run
tests that manipulate networking on a machine without authorization.

## Common release checklist

1. Start from an exact reviewed commit on `main` or a `stellar/` working branch.
   Preserve local work; do not force-reset a signing machine to update it.
2. Synchronize the application version in `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, the app entry in `Cargo.lock` and
   `src-tauri/tauri.conf.json`. Helper crate versions are independent.
3. Run the relevant source, dependency, application and native checks. Preserve
   the exact source commit, runtime hashes, toolchain identity and test results.
4. Verify production API configuration, application identity, supported OS and
   architecture. Preserve the existing update public key and platform signing
   identity needed for upgrade compatibility.
5. Test fresh installation, an upgrade from the actual old app, and uninstall.
   Test login retention separately from VPN connection success.
6. Test connection, cancellation, expiry, kill switch, crash behavior, IPv4,
   IPv6 and DNS leaks, sleep/resume and network changes on the target platform.
   A hosted VM inventory is not a physical sleep/Wi-Fi acceptance test.
7. Sign and verify all required nested components and installers. Recompute
   any hashes embedded in the app only after finalizing their inputs.
8. Generate the signed update artifacts and manifest, test a controlled upgrade
   and failure/rollback paths, then obtain release publication approval.

Do not commit keys, tokens, `.env` files, downloaded third-party binaries,
`node_modules`, local acceptance receipts or generated application bundles.
The root `README.md` is explicitly approved for publication. Other Markdown
documents remain local and untracked under the user's repository policy.

## macOS release

### Runtime and architecture

Apple Silicon uses `aarch64-apple-darwin`; Intel uses `x86_64-apple-darwin`.
The configured minimum macOS version is **12.0**. Check the actual Mach-O load
commands of the VPN engine and every library, not just compiler flags or the
outer app's Info.plist.

The original runtime archive with SHA-256
`970d5c82c82901ddc5eb121bd77f99a6c502b1007dcf1a4948cd631274c554c8`
is blocked: its binaries require macOS 26/27. Do not reuse it or patch version
fields to pretend compatibility.

The replacement is attached to the GitHub draft release
`macos-0.5.0-runtime-macos12-handoff`:

```text
Stellar-VPN-0.5.0-OpenVPN-runtime-darwin-arm64-macos12.tar.gz
SHA-256: 20910b9caa4503f81f3fbecc117b3ed4de07de45729603514c79dad5d98aba54
```

For an authorized transfer of this already reviewed artifact, authenticated
repository members can use:

```sh
gh release download macos-0.5.0-runtime-macos12-handoff \
  --repo StellerSecurity/Stellar.UI.Desktop.VPNapp \
  --dir runtime-handoff
```

Verify its checksum before extraction. Place its `openvpn-runtime` directory at
`src-tauri/resources/openvpn-runtime/`. It contains six files plus
`runtime-manifest.json`: OpenVPN, OpenSSL crypto/SSL, LZO, PKCS11 helper and LZ4.
The manifest records per-file hashes and actual minimum versions. Do not run an
unreviewed replacement download when a runtime input is missing.

```sh
node scripts/build-macos-test.mjs --arch arm64 --profile release --check
```

If rebuilding the runtime from source, use `scripts/build-arm64-runtime.py` only
after explicit approval of its pinned archives, backports and build execution.
It builds in a fresh local prefix with network access blocked during its build
commands. It does not install a system VPN service or publish a release.

### Local test build

```sh
node scripts/build-macos-test.mjs --arch arm64 --profile release
```

This builds the helper and app offline, generates an unsigned helper package and
stages drag-to-Applications DMG inputs. It deliberately clears Apple signing
environment variables. **It is not the final signing/notarization pipeline.**

Expected app output:

```text
target/aarch64-apple-darwin/release/bundle/macos/Stellar VPN.app
```

The script prints the staging/output paths. Staging is not proof a final DMG
has been created. The separate `package-macos-installer.mjs` and
`package-macos-dmg.mjs` scripts target local ARM64 debug test packages, not a
ready-made production signing workflow.

### Production signing order

Use the approved signing machine and existing keys. The configured team is
`7VYLUCU756`; the identities are Developer ID Application and Developer ID
Installer for North Star Swiss SA. Confirm their current validity locally.
Keep private keys, IronKey material and notarization passwords off Git and chat.

1. Verify the reviewed runtime, then Developer ID sign its nested dylibs,
   OpenVPN and the native helper with the appropriate hardened-runtime settings.
   Signing changes hashes; retain provenance for the reviewed inputs and record
   the final signed-file hashes in the runtime manifest.
2. Generate the helper package with `scripts/package-network-helper.mjs`, using
   the correct architecture, runtime directory and signed helper input.
3. Sign the final helper installer with Developer ID Installer. Notarize and
   staple it as required before treating its bytes as final.
4. Update `src-tauri/resources/NetworkHelper.sha256` and the package hash in
   `NetworkHelper.arch.json` to match the final package. The helper hash and
   architecture metadata must match too. The package checksum is compiled into
   the app; replacing the package afterward invalidates that relationship.
5. Compile the final app against those finalized resources. Do not rerun the
   unsigned test-build script over a finalized signed helper package.
6. Sign, notarize and staple the app and its distribution container as required.
   Verify nested signatures, team identity, bundle identifier, versions,
   architecture, helper package hashes and Gatekeeper assessment.
7. Test a clean install and a real old-app upgrade. Generate the OTA archive
   from the finalized app only after all byte-changing operations are complete.

Use the signing machine's approved notarization keychain profile. Do not invent
a new credential workflow or disable Gatekeeper/quarantine to pass validation.
For the detailed handoff, see `scripts/macos-release-handoff.txt`.

### Login migration

`src-tauri/legacy-migration.json` currently disables automatic native migration.
Backend support and synthetic tests are not sufficient to enable a public
rollout. Validate the real legacy-store read, exchange, durable replacement
session and cleanup behavior on an upgrade fixture first. A failed migration
must retain the old login rather than deleting it prematurely.

## Windows release

The current implementation targets **Windows x64**. Windows ARM in a Mac VM is
not equivalent to native x64 driver/service acceptance.

Required inputs include a reviewed MSVC/Windows SDK toolchain, exact approved
OpenVPN runtime and driver inputs, and a valid production code-signing setup.
The per-machine NSIS installer installs the privileged service with administrator
consent. Its adapter and cleanup operations must remain scoped to Stellar.

Read these files before preparing a release:

- `native/windows/release-policy.json`
- `scripts/check-windows-release.mjs`
- `scripts/windows-native-compile.ps1`
- `scripts/build-windows-helper.mjs`
- `src-tauri/tauri.windows.conf.json`
- `native/windows/installer.nsh`

With the approved native Windows toolchain already available:

```powershell
node scripts/build-windows-helper.mjs
powershell -NoProfile -File scripts/windows-live-preflight.ps1
node scripts/check-windows-release.mjs
```

Helper compilation is not installation or release approval. Preflight is a
read-only capability inventory, not a live VPN/leak test. Follow the compile
script's explicit source/toolchain approval requirements; do not bypass them.

The current release policy has `releaseReady`, `runtimeApproved` and
`driverApproved` set to false. Required native acceptance covers MSVC builds,
install/upgrade/uninstall, credential vault, legacy migration, VPN lifecycle,
live kill switch, fail-closed crashes, IPv4/IPv6/DNS leaks, sleep/network changes
and signed-update rollback.

Acceptance evidence must match the exact source hash, architecture and runtime
manifest. Do not fabricate `.security-review/windows-acceptance.json` or flip
policy fields just to make the gate pass. Hosted compile/synthetic workflows do
not establish desktop hardware acceptance.

Only after the approved acceptance process makes the gate pass:

```powershell
npm run desktop:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

Finalize signing through the approved Windows signing service for all components
required by the runtime's signature checks, including the privileged helper and
installer. Verify signatures and installer behavior; do not introduce test trust
roots or disable signature verification. Then prepare the Windows OTA artifact
and test update/rollback before publication.

## Linux release

Linux depends on native GTK/WebKit/system packages as well as the reviewed Rust
and Node inputs. Determine exact distribution versions and review missing
packages before installation. Do not copy macOS/Windows runtimes into Linux.

The workspace selects a local glib 0.18.5 backport for RUSTSEC-2024-0429.
`vendor/glib-0.18.5/stellar-backport.json` records its provenance and inventory.

On a prepared Linux machine:

```sh
npm run check:linux-security
npm run test:linux-security
cargo test --locked --offline -p stellar-vpn-desktop --test linux_glib_backport
cargo test --locked --offline --release -p stellar-vpn-desktop --test linux_glib_backport
```

The first two commands verify source/inventory tooling; they do not replace the
native debug/release regression tests. Complete the native desktop build and
platform VPN/helper/firewall/installation acceptance as well.

`scripts/desktop.mjs` currently blocks Linux release builds unconditionally.
A separately reviewed source change backed by native acceptance evidence is
needed before a Linux release can proceed. Do not call the underlying Tauri CLI
directly to evade the block. AppImage and DEB are configured prospective bundle
targets, not proof of working release artifacts.

Linux in-app OTA is currently unsupported by both native updater handling and
the manifest-generation tool. Distribute only through an approved packaging and
update channel after defining and testing that channel; do not point Linux at a
macOS or Windows artifact.

## Signed OTA manifests and publication

The new updater uses:

```text
https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/latest.json
```

Legacy clients use `/vpn/latest.json`. Changing the legacy feed can affect all
existing users. Preserve the old/new feed contracts and existing platform entries;
a controlled one-machine test must not accidentally update the entire user base.

Sign the finalized artifact with the existing approved OTA key. The signature
must verify against the public key pinned in `src-tauri/src/updates/trust.rs`.
Its signed trusted comment must contain the exact release `version:0.5.0`.
Keep the private key on the signing machine/IronKey; this repository's manifest
tool reads only artifact bytes and the detached public signature.

After signing and final validation, examples of manifest generation are:

```sh
node scripts/prepare-ota-manifest.mjs \
  'Stellar VPN.app.tar.gz' 'Stellar VPN.app.tar.gz.sig' \
  0.5.0 darwin-aarch64 > macos-platform-manifest.json

node scripts/prepare-ota-manifest.mjs \
  Stellar-VPN-setup.exe Stellar-VPN-setup.exe.sig \
  0.5.0 windows-x86_64 > windows-platform-manifest.json
```

Each invocation emits one platform entry, not a safely merged multi-platform
feed. The Windows invocation additionally enforces native acceptance. Intel macOS
uses `darwin-x86_64` only with its independently validated Intel artifact.

Upload approved immutable versioned artifacts first, independently verify their
download hashes/signatures, then update the appropriate feed after publication
approval. The tool restricts artifacts to `/vpn/desktop-v2/<version>/<target>/`.
It does not upload files, merge platform entries or publish an update.

A GitHub draft containing runtime inputs is a signing handoff, not an app release
or an OTA publication. Preserve older working artifacts and a tested recovery
plan; do not edit manifests to force an unsupported downgrade.

## macOS 0.5.0 signing and OTA release record

Recorded on **2 November 2026** from the signing-machine handoff. The published
GitHub asset digests and the two public OTA manifests were independently checked
when this section was added. The notarization, installation and controlled
upgrade results below are reported by that handoff; they are not new tests run
while editing this README.

This is a historical procedure and a starting point for future reviewed releases.
**Do not rebuild and overwrite the published 0.5.0 files.** New signatures and
timestamps produce different bytes and hashes. A new release needs a separately
verified source commit, version, artifact paths, pinned hashes and approval.

### Identities, source and hosting

| Item | Historical release value |
| --- | --- |
| Apple team | North Star Swiss SA / `7VYLUCU756` |
| Application certificate SHA-1 fingerprint | `5ECA1D6A477A09B93BF5D4FBF772C969B9CDED02` |
| Installer certificate SHA-1 fingerprint | `B76774558253A64B657A67257F59156F9BACE878` |
| Certificate expiry reported by the signing machine | 2 December 2027 |
| Released application source | `0e8952cc3b26bad5f19b5c2c7d2f95015f4c74f3` |
| Initial source merge into `main` | `957dd3eac0218dbf07ce1c1303271b62531c759b` |
| Release hosting | [Stellar.Desktop.Releases](https://github.com/StellerSecurity/Stellar.Desktop.Releases) |
| Download service source | [Stellar.UI.Download.API](https://github.com/StellerSecurity/Stellar.UI.Download.API) |

These fingerprints identify public certificates, not private keys. Confirm the
intended valid identities on the signing machine before reuse. Existing keys and
the older Application certificate were retained; issuing the new certificates
did not require revoking them. Apple Developer ID signing and OTA signing are
separate layers. The existing OTA private key stayed on the hardware-encrypted
drive and was not copied into Git or release hosting.

The historical environment used reviewed Xcode tools, Node 22.12.0, Rust 1.99.1,
the `aarch64-apple-darwin` target and locked dependencies. This record grants no
approval to install those tools elsewhere or substitute other versions.

### Signing-machine sequence

Use a fresh isolated checkout of the intended source commit. Keep an unchanged
copy of the original runtime manifest for provenance, verify the reviewed input
hashes, and stop on any failed command. Use an isolated, already prepared
`CARGO_HOME`/`RUSTUP_HOME` if required by the reviewed build environment, and
confirm that `Cargo.lock` remains unchanged.

The following commands illustrate the historical macOS sequence. Set
`APP_IDENTITY`, `INSTALLER_IDENTITY` and `NOTARY_PROFILE` locally to the intended
existing certificate identities and Keychain profile. No new Keychain access
grant, certificate issuance or credential setup is authorized by this guide.

```sh
export MACOSX_DEPLOYMENT_TARGET=12.0
export CARGO_NET_OFFLINE=true

cargo build --locked --offline -p stellar-vpn-helper \
  --target aarch64-apple-darwin --release
```

Sign each of the six runtime binaries with the intended Application identity,
timestamp and hardened runtime options, verify it, and update that file's hash
in `runtime-manifest.json`. Preserve the original manifest separately. Do not
reuse the pre-signing hashes as if signing had left the files unchanged.

```sh
codesign --force --sign "$APP_IDENTITY" \
  --identifier org.stellarvpn.desktop.helper --timestamp --options runtime \
  target/aarch64-apple-darwin/release/stellar-vpn-helper
codesign --verify --strict \
  target/aarch64-apple-darwin/release/stellar-vpn-helper

node scripts/package-network-helper.mjs --arch arm64 --profile release \
  --helper target/aarch64-apple-darwin/release/stellar-vpn-helper \
  --runtime src-tauri/resources/openvpn-runtime

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

Confirm Apple's **Accepted** result and the expected team. After stapling, write
the final package SHA-256 to `NetworkHelper.sha256` and `packageSha256` in
`NetworkHelper.arch.json`. Verify the metadata's signed helper hash too. Only
then compile the app, so its embedded checksum matches the final package:

```sh
node node_modules/@tauri-apps/cli/tauri.js build --ci \
  --target aarch64-apple-darwin --bundles app --no-sign -- --locked --offline

APP="$PWD/target/aarch64-apple-darwin/release/bundle/macos/Stellar VPN.app"
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

This direct CLI invocation is the macOS final-build step after helper
finalization, not permission to bypass Windows or Linux release gates. Confirm
the bundle ID, release version, ARM64 architecture, minimum macOS 12.0, timestamp,
team and the exact bundled helper-package checksum.

Create the drag-to-Applications DMG from that finalized app in a new staging
directory. Sign the DMG, submit it for notarization, staple and validate it, and
run `hdiutil verify` and Gatekeeper assessment on the final container. The app
and helper require their own checks; a signed outer DMG does not replace them.

Never use shell tracing, passwords in command arguments or shell-history lookup
to recover credentials. Use an existing Keychain profile or a reviewed hidden
local prompt. Historical scripts on the signing Mac contain machine-specific
paths and unlock handling; inspect them before reuse rather than executing them
as trusted release automation.

### Corrected OTA archive format

The first OTA archive contained AppleDouble entries (`._*`) that the legacy
updater rejected. The replacement used **USTAR**, without PAX metadata or links,
inside gzip with `mtime=0`. Repacking preserved the signed app's file bytes.
Deterministic container metadata does not make a newly signed app identical to
the published app.

The following packaging example operates only on the already finalized app;
it does not sign, install or publish it:

```sh
export STELLAR_APP="$APP"
python3 - <<'PY'
import gzip, os, tarfile
from pathlib import Path

app = Path(os.environ['STELLAR_APP'])
if app.is_symlink() or not app.is_dir() or app.name != 'Stellar VPN.app':
    raise RuntimeError('Expected a regular Stellar VPN app directory')
output = Path('Stellar VPN.app.tar.gz')

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
PY
```

Sign that exact archive with the existing OTA key. Use the approved local CLI's
hidden password prompt; if unavailable, stop and review a secure local wrapper
instead of placing a password in shell arguments or history. With
`OTA_KEY_PATH` set locally to the hardware drive's key path:

```sh
node node_modules/@tauri-apps/cli/tauri.js signer sign \
  --private-key-path "$OTA_KEY_PATH" --app-version 0.5.0 'Stellar VPN.app.tar.gz'
node scripts/prepare-ota-manifest.mjs \
  'Stellar VPN.app.tar.gz' 'Stellar VPN.app.tar.gz.sig' \
  0.5.0 darwin-aarch64 > candidate-latest.json
```

For a future version, replace **all** version-specific values deliberately.
The manifest tool verifies the pinned public key and signed version comment.
The historical corrected URL added `/ota1/` under the target directory. That
manifest change used JSON parsing and retained the exact signature. Re-extract
the archive into an empty test directory, compare every app-file hash, and
verify code signatures, stapling and Gatekeeper on the extracted app.

### Controlled upgrade and remaining acceptance

The signing-machine record reports that an isolated copy of the old production
0.2.0 app installed the corrected 0.5.0 archive, that every installed app file
matched the notarized app, and that relaunch was confirmed visually. The user
installed the reviewed helper through macOS and reported it working; all nine
installed helper files reportedly matched the package.

Credential fields were retained, but automatic native login migration remained
disabled. Users may still need to sign in again. This controlled upgrade is not
a full clean-machine VPN/firewall or leak test. Live macOS 12 testing, complete
clean-machine acceptance and review of automatic login migration remain open.
Every new release needs its own real upgrade test.

### Published assets and Azure activation

The final five assets are on
[release vpn-mac-0.5.0-ota1](https://github.com/StellerSecurity/Stellar.Desktop.Releases/releases/tag/vpn-mac-0.5.0-ota1).
These are immutable historical digests, not expected hashes of a rebuild:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Stellar-VPN-0.5.0-darwin-aarch64.app.tar.gz` | 6,774,519 | `0723b0d9e13fd82145052326555bad7ef84c456d129f2a39cf08b7bb32187e88` |
| `Stellar-VPN-0.5.0-darwin-aarch64.app.tar.gz.sig` | 428 | `3191677fd459c0977ba22c7130b239f0427f938e610f971d62e2291126fd302f` |
| `Stellar-VPN-0.5.0-macos-arm64.dmg` | 7,244,480 | `8d3a420a4fc2b90bc1f3344423be8742d00c2fc9e196d2829245c3891575969c` |
| `Stellar-VPN-0.5.0-NetworkHelper-arm64.pkg` | 3,638,424 | `2dc363aa9191ac9ba08c224e69ea640ba0c698319ae44f936214b87d30cd2886` |
| `latest.json` | 695 | `1f4c1784babfff4274e588932641f0809c19f509512701ec1d420621622345bb` |

The release-hosting repository contains `azure-vpn-release.yml` and
`scripts/vpn-release.cjs`. The historical deployment used Azure pipeline **190**,
branch `main`, environment `stellardesktopreleasesprod` and an existing scoped
Azure service connection. No Azure token was copied to the coding agent.

For an explicitly approved release, the process is:

1. Review the publisher source, pinned inputs and intended version. Its 0.5.0
   inputs must not be reused with different bytes without a new review.
2. Validate the exact five assets in the reviewed release-hosting checkout:
   `node scripts/vpn-release.cjs verify /path/to/exact-assets`.
3. Run the pipeline with `mode=stage` first.
4. Perform the real controlled OTA test and record actual evidence.
5. After concrete release approval, run `mode=activate`. Supply a truthful
   `controlledOtaTest` record identifying the machine, old/new versions and
   outcome. Never enter a made-up `PASS` just to satisfy a gate.

The handoff records successful runs **7035** (stage), **7036** (activation) and
**7038** (DMG alias fix). It describes pinned SHA-256, OTA signature, version,
USTAR and manifest verification, a feed-hash compare-and-swap, and a recovery
journal. Stop on unexpected hashes; do not rewrite those checks to force a run.
Local `az` or `gh` installation was not required for that deployment.

Both public feeds were checked to serve version 0.5.0 with the exact manifest
digest above and only the `darwin-aarch64` platform:

- [Legacy feed](https://desktopreleasesassetsprod.stellarsecurity.com/vpn/latest.json)
- [Desktop V2 feed](https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/latest.json)

Their artifact URL is
`https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/0.5.0/darwin-aarch64/ota1/Stellar%20VPN.app.tar.gz`.
The old compatible Apple Silicon app offers the update at its next check; the
user chooses installation. This is not a forced update. Linux offers were
explicitly paused, and this release did not publish Intel Mac, Windows or mobile
artifacts.

The handoff also records a DMG compatibility alias using the **same verified
DMG bytes**, after the download service's original path returned 404:

```text
https://desktopreleasesassetsprod.stellarsecurity.com/vpn/0.5.0/Stellar%20VPN_0.5.0_aarch64.dmg
https://download.stellarsecurity.com/vpn/mac
```

Keep download aliases, release asset names and OTA URLs distinct. Changing a
filename or manifest path must not silently change the underlying signed bytes.
