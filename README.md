# Stellar VPN Desktop

Stellar VPN is a desktop VPN application built with React, TypeScript, Tauri and
Rust. The interface provides a server map, connection controls, account access,
settings and signed software updates. Platform-specific network helpers perform
the privileged VPN and firewall work outside the interface process.

This document describes the current 0.5.0 source and its release requirements.
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
| macOS Apple Silicon | Source-build runtime targets macOS 12.0. Its six Mach-O targets, hashes, local linkage, ad hoc signatures and library smoke tests passed. Final app/helper signing, notarization, installation and upgrade acceptance must use that replacement runtime. Live macOS 12 compatibility remains unverified. |
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
