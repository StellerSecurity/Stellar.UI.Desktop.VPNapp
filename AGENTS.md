# Stellar VPN release flow

For every desktop VPN release, follow the established Stellar Notes release-control pattern.

1. Build the Windows, Linux, and macOS candidates from the same reviewed source commit and the same canonical version. Azure builds Windows and Linux; the reviewed macOS workflow builds macOS.
2. Never publish unsigned candidates. Complete native platform signing first where applicable, then create and locally verify an OTA signature for every final public artifact with the already approved Stellar OTA key. Never read, copy, upload, print, or commit a private key.
3. Put final signed VPN release assets in `StellerSecurity/Stellar.Desktop.Releases` under an exact `vpn-<version>` release tag. The VPN application repository is a build source, not the production release host.
4. The release repository must verify the exact source commit, version, filenames, hashes, native-signing evidence, OTA signatures, and pinned OTA public key before promotion.
5. Publish immutable artifacts below `/vpn/desktop-v2/<version>/<target>/`. Maintain separate manifests at:
   - `/vpn/desktop-v2/darwin-aarch64/latest.json`
   - `/vpn/desktop-v2/windows-x86_64/latest.json`
   - `/vpn/desktop-v2/linux-x86_64/latest.json`
6. Activate a platform manifest only after its public artifact bytes have been fetched back and verified. Do not overwrite another platform's manifest.
7. Treat `/vpn/desktop-v2/latest.json` as a legacy migration feed. Do not update it until all supported platforms for the same version are signed, verified, public, and ready together.
8. Never deploy directly from a pull request, feature branch, local build folder, or application-repository workflow. Production promotion runs from the protected release repository and must preserve the Notes release flow.
9. Do not install new release tooling or dependencies. Use reviewed repository scripts and standard-library capabilities. Stop on any mismatch instead of weakening verification.

These rules are release invariants. Any automation or AI change that conflicts with them must be refused or redesigned.
