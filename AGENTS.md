# Stellar VPN desktop release rules

These instructions are mandatory for every Codex session that builds, signs,
tests, promotes, repairs, or publishes Stellar VPN for macOS, Windows, or
Linux. Security and reproducibility take precedence over speed.

## 1. Definition of done

A desktop release is not done when a build succeeds. It is done only when all
of the following are true for every supported platform in scope:

1. The candidate came from one exact reviewed source commit.
2. The canonical version is identical everywhere.
3. Required source, unit, packaging, and platform tests passed.
4. The final native artifact is signed as required by the platform.
5. The exact final bytes have a locally verified Stellar OTA signature.
6. Clean install, upgrade, helper/service, VPN, kill-switch, disconnect, and
   network-restoration tests passed on the intended operating system.
7. Release evidence records commit, version, filenames, hashes, signatures,
   native-signing status, notarization status, test results, and public URLs.
8. Production assets were promoted through `Stellar.Desktop.Releases`.
9. Every public artifact and manifest was fetched back and verified.
10. The download aliases return the intended version for the intended OS.

If any item is missing, report the release as incomplete. Never describe
`releaseReady: false`, an unsigned candidate, a signing input, a draft, or a
successful compile as public-release ready.

## 2. Release authority and source boundaries

- `StellerSecurity/Stellar.UI.Desktop.VPNapp` is the application source and
  candidate-build repository.
- `StellerSecurity/Stellar.Desktop.Releases` is the production release and
  promotion repository. Final VPN assets use the exact tag `vpn-<version>`.
- Azure builds the reviewed Linux and Windows candidates from the same exact
  commit. The reviewed macOS workflow builds the macOS signing input from that
  same exact commit.
- Native signing happens only on an authorized signing machine. Private keys,
  passwords, certificates, Keychain contents, and OTA secrets must never be
  copied into Git, CI artifacts, logs, chat, or a third-party service.
- Never publish directly from a feature branch, PR artifact, local ad hoc
  build folder, or application-repository workflow.
- Never build a release from a dirty worktree. Preserve unrelated user changes
  and use a clean, detached checkout or isolated worktree at the approved
  commit. New branches use the `stellar/` prefix.

## 3. Start-of-release record

Before building, create an in-memory or non-Markdown release record containing:

- exact 40-character source commit;
- canonical stable version `MAJOR.MINOR.PATCH`;
- release tag `vpn-<version>`;
- supported targets for this release;
- expected artifact names;
- pinned OTA public-key fingerprint;
- current public version for each platform feed;
- current public download-alias result for macOS, Windows, and Linux;
- the exact approved workflows and signing machines that will be used.

Stop if the commit is ambiguous, the tree is dirty, the version is not a plain
stable three-part version, or different platforms point at different source
commits without an explicitly documented emergency exception.

## 4. Canonical version gate

The release version must agree in at least:

- `package.json`;
- `package-lock.json` root package metadata;
- `src-tauri/tauri.conf.json`;
- `src-tauri/Cargo.toml` package section;
- `Cargo.lock` application package;
- platform package names and build metadata;
- OTA trusted comments;
- release tag, release title, artifact paths, and manifests.

Run `tests/version-consistency.test.mjs`. Treat hard-coded historical versions
in scripts, tests, workflow branches, artifact regular expressions, filenames,
or build-info generation as blockers for a new version. Update them together
or replace them with a validated canonical-version lookup. Never silently
reuse a previous version's signature, archive, helper package, manifest, or
notarization result.

## 5. Dependency and toolchain policy

- Follow the global dependency security-review policy before downloading,
  installing, updating, or executing any new package, CLI, binary, plugin, or
  build tool.
- Prefer the repository's reviewed scripts, lockfiles, pinned source inputs,
  standard-library capabilities, and preinstalled hosted tools.
- Do not substitute a newer toolchain or package to make a failing build pass.
- Do not weaken checksum, signature, architecture, minimum-OS, source-commit,
  offline, or provenance checks.
- A dependency download/review workflow is not permission to execute or
  install what it downloaded.

## 6. Mandatory common tests

Use the commands already defined by the checked-out commit. At minimum, run the
applicable existing suites for:

- TypeScript type checking and frontend build;
- ordinary application tests;
- release frontend verification;
- version consistency;
- app identity;
- OTA release verification and OTA signing workflow;
- updater behavior;
- API retry and connection deadlines;
- connection cancel, traffic, server catalog, and VPN-auth refresh;
- IPC permissions;
- platform packaging and service/helper rules;
- dependency/security checks required by the workflow.

Do not install missing dependencies merely to run these tests. Stop and follow
the dependency review and approval process.

## 7. Platform build matrix

### Windows x86_64

1. Use the reviewed Azure Windows candidate stage from `azure-pipelines.yml`.
2. Verify exact source commit, reviewed runtime manifest, MSVC/SDK pins, Rust
   input pins, synthetic tests, service/helper build, and NSIS 3.10 identity.
3. The Azure result is an unsigned candidate named
   `Stellar-VPN-setup.exe`; it is not a public release.
4. Authenticode-sign the final installer first.
5. Verify Authenticode status, expected publisher, timestamp, file version,
   product version, architecture, installer contents, and SHA-256.
6. Only after Authenticode is final, OTA-sign those exact EXE bytes.
7. Verify the OTA signature locally against the public key pinned in
   `src-tauri/src/updates/trust.rs` and verify the signed version.
8. Any later byte change, including Authenticode signing or timestamping,
   invalidates the OTA signature and requires a new OTA signature.

Required live tests include clean per-machine install, service installation,
login, connect, traffic, server switch, kill switch on/off, disconnect,
service recovery, in-place update, uninstall, and clean reinstall.

### Linux x86_64 / Ubuntu 24.04

1. Use the reviewed Azure Linux candidate stage from `azure-pipelines.yml`.
2. Verify exact pinned build libraries and runtime dependencies, reviewed GLib
   boundary, hardened systemd unit, helper tests, and offline locked Rust build.
3. The Azure `.deb` is an unsigned OTA candidate, not public-release ready.
4. OTA-sign the exact final `.deb` bytes and verify the signature locally
   against the pinned OTA public key and canonical version.
5. Do not change or repackage the `.deb` after OTA signing.

Required live tests include clean package install, fixed helper/service paths,
service start, login, connect, DNS and traffic, server switch, kill switch
on/off, disconnect, network restoration, in-place update, uninstall/purge, and
clean reinstall on the supported Ubuntu version.

### macOS ARM64

1. Use `.github/workflows/macos-arm64-release-candidate.yml` at the approved
   commit to create the unsigned signing input.
2. Verify ARM64 architecture, macOS 12 minimum deployment target, reviewed
   OpenVPN runtime manifest, helper tests, release frontend, and archive hashes.
3. On the authorized Mac, native-sign in dependency order:
   - runtime libraries and OpenVPN;
   - native helper;
   - NetworkHelper package with Developer ID Installer;
   - regenerate and verify the embedded helper package hash/architecture data;
   - app and nested code with Developer ID Application;
   - final distribution artifacts.
4. Verify bundle ID `org.stellarsecurity.vpn.desktop`, team ID, entitlements,
   nested signatures, helper package signature, architectures, version, and
   Gatekeeper assessment.
5. Notarize the exact final distribution, wait for Apple acceptance, then
   staple and validate the ticket. A submission ID alone is not success.
6. Create the updater archive `Stellar VPN.app.tar.gz` only from the final
   signed/notarized app, then OTA-sign that exact archive.
7. Verify the OTA signature locally against the pinned public key and signed
   version. Never mutate or recreate the archive after signing.

Required live tests include clean install from the public distribution,
administrator-approved network-helper installation, authenticated helper
`CAPABILITIES` check, login, connect, traffic, server switch, kill switch
on/off, disconnect, sleep/resume, upgrade, uninstall, and clean reinstall.

The existence of a helper file is not proof that setup succeeded. Readiness is
proved through the authenticated helper socket. The packaged uninstaller must
be present and must safely release firewall and DNS state before deleting the
helper. A missing uninstaller is a release blocker.

## 8. Signing handoff rules

- The handoff must contain only verified public build inputs, checksums,
  provenance, and reviewed first-party scripts.
- The user should need only to select the approved key and enter its password
  locally. Passwords must not be accepted through chat, arguments, logs, files,
  environment variables, clipboard automation, or remote messages.
- Password failure must allow a bounded retry without rebuilding or changing
  artifacts.
- Signing scripts must reject symlinks, unexpected files, wrong source commit,
  wrong version, wrong hashes, missing reviewed runtime, and stale outputs.
- Signing output goes to a fresh directory. Never overwrite prior evidence.
- The script must verify its own result before reporting success.
- macOS notary credentials may be referenced only through the approved local
  Keychain profile; do not print or export them.

## 9. VPN and network acceptance tests

For each platform, test at least three production locations from the current
signed server catalog. Include Denmark plus two geographically distinct
locations where available. For every connection verify:

- the selected server actually changes;
- a VPN interface and route are established;
- DNS works without leaking the previous resolver;
- HTTPS traffic works through the tunnel;
- observed public IP/location changes as expected;
- disconnect restores ordinary internet access;
- switching server does not leave stale routes, DNS, firewall rules, or helper
  state;
- Wi-Fi and another practical network path are tested when available;
- failure/retry behavior is bounded and actionable.

Test kill switch both disabled and enabled. Every live network-disruption test
must install an independent fail-safe before connecting that automatically
disconnects, unblocks the firewall, and restores normal networking within 30
seconds if the test runner loses connectivity. Confirm the fail-safe is armed
before the disruptive action and disarm it only after normal internet access
has been independently verified. Never rely on Codex retaining connectivity
to perform cleanup.

Do not call a VPN test successful merely because the UI says Connected. Data
plane, DNS, public IP, disconnect, and network restoration must all pass.

## 10. Clean-install and upgrade matrix

Test both paths; one cannot substitute for the other.

### Clean install

1. Remove only exact Stellar VPN app, service/helper, runtime, receipt, cache,
   Keychain-service, DNS, and firewall state using reviewed uninstall logic.
2. Verify no Stellar VPN helper/service/firewall token remains.
3. Install from the same artifact intended for publication.
4. Verify helper/service installation and app readiness.
5. Complete the VPN and network acceptance tests.

### Upgrade

1. Install the currently public previous version from its public URL.
2. Point only at the production-format candidate manifest in an isolated test
   channel or controlled staging boundary.
3. Fetch, cryptographically verify, install, restart, and confirm the exact new
   version.
4. Verify saved login behavior, helper/service migration, VPN traffic, kill
   switch, and uninstall after upgrade.
5. Repeat using the exact production bytes before manifest activation.

An update modal appearing is not an OTA test. The updater must download the
artifact, verify the exact signature, install it, restart, and report the new
version. A fresh install passing does not prove upgrades work.

## 11. Production artifact and manifest contract

Publish immutable artifacts below:

`/vpn/desktop-v2/<version>/<target>/`

Maintain separate platform manifests:

- `/vpn/desktop-v2/darwin-aarch64/latest.json`
- `/vpn/desktop-v2/windows-x86_64/latest.json`
- `/vpn/desktop-v2/linux-x86_64/latest.json`

For each platform:

1. Upload the final artifact without changing its bytes.
2. Fetch it back from the public URL.
3. Compare SHA-256 and size to the locally verified artifact.
4. Verify native signature/notarization where applicable.
5. Verify the Stellar OTA signature and trusted version against fetched bytes.
6. Validate manifest schema, target, hostname, immutable version path,
   filename, version, and signature.
7. Activate only that platform's manifest.
8. Fetch the manifest publicly and repeat the updater verification.

`/vpn/desktop-v2/latest.json` is a legacy migration feed. Update it only after
macOS, Windows, and Linux for the same version are all signed, verified,
public, and release-ready. Never overwrite one platform's feed while promoting
another.

## 12. Public download aliases

After promotion, verify these user-facing routes in a clean HTTP session:

- `https://download.stellarsecurity.com/vpn/mac`
- `https://download.stellarsecurity.com/vpn/windows`
- `https://download.stellarsecurity.com/vpn/linux`

Follow redirects and confirm status, final hostname, exact target platform,
filename, version, content type, size, and SHA-256. A route serving an older
version, a wrong OS artifact, an invalid archive URL, HTML, or a missing blob
blocks completion even when OTA feeds are correct.

## 13. Release evidence and reporting

Before claiming completion, present a compact platform table containing:

- target;
- source commit;
- version;
- artifact filename and SHA-256;
- native signing status;
- notarization/stapling status;
- OTA verification status;
- clean-install result;
- upgrade result;
- VPN/kill-switch/network-restoration result;
- public artifact verification;
- platform manifest verification;
- download-alias verification.

Use only observed evidence. Distinguish `built`, `signed`, `uploaded`,
`manifest active`, `download alias active`, and `end-to-end verified`. Do not
infer one state from another.

## 14. Stop conditions

Stop publication immediately for any of the following:

- source commit or version mismatch;
- dirty or unreviewed source used for a candidate;
- unexpected artifact, symlink, archive member, path, or hash;
- missing or invalid native signature;
- notarization rejection or missing staple where required;
- OTA signature/key/version mismatch;
- artifact modified after OTA signing;
- `releaseReady: false` or incomplete provenance;
- clean install, helper/service, upgrade, VPN, DNS, kill-switch, disconnect, or
  network-restoration failure;
- missing safe uninstaller or recovery path;
- public blob, manifest, or download alias mismatch;
- request to bypass branch protection, security checks, signing verification,
  Gatekeeper, notarization, dependency review, or release-repository promotion.

Fix the source or release process, rebuild from the same approved commit (or a
new explicitly approved commit), and repeat every affected downstream step.
Never patch a production manifest to conceal a bad artifact.

## 15. Repository hygiene

- Preserve unrelated user changes.
- Never commit keys, credentials, tokens, downloaded third-party binaries,
  build outputs, signing handoffs, or release artifacts to the app repository.
- Do not add co-author or assistant-attribution trailers.
- Keep Markdown files local and untracked under the global policy. This
  repository-level `AGENTS.md` is the sole explicitly approved exception; do
  not infer permission to commit, push, or upload any other Markdown file.
- Production actions require explicit user authorization and must remain
  limited to the requested release scope.
