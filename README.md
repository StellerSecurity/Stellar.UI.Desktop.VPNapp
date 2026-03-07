# Stellar VPN Desktop

Stellar VPN Desktop is a cross-platform, security-first VPN application built with **Tauri v2**, designed and developed in Switzerland 🇨🇭.  
The app focuses on privacy, reliability, and minimal attack surface while delivering a native desktop experience on Linux, macOS, and Windows.

Stellar VPN Desktop ships with:
- Native system integration (tray, autostart, system networking)
- Secure privileged helpers for VPN control
- Signed releases and cryptographically verified OTA updates
- Open-source transparency where possible

---

## Tech Stack

- **Tauri v2**
- **Rust** (core, helpers, system integration)
- **TypeScript / React** (UI)
- **OpenVPN / system networking**
- **Tauri Updater (OTA)** with mandatory signing

---

## Building a Release (Production)

> ⚠️ Always build releases from a clean working tree.

The project is configured to automatically build the frontend before creating a release bundle.

### Standard build command

```bash
cargo tauri build
```

This will:
- Run `npm run build:web`
- Bundle the frontend from `frontendDist`
- Produce platform-specific installers and artifacts

Build output is located in:

```text
src-tauri/target/release/bundle/
```

### Build variants: internal vs customer

The app supports two build modes:

- **Internal build** → VPN logs visible in the dashboard
- **Customer build** → VPN logs hidden in the dashboard

Add this to `src-tauri/Cargo.toml`:

```toml
[features]
customer-build = []
```

### Internal build

```bash
VITE_SHOW_VPN_LOGS=true cargo tauri build
```

### Customer build

```bash
VITE_SHOW_VPN_LOGS=false cargo tauri build --features customer-build
```

### Behavior

- `VITE_SHOW_VPN_LOGS` controls whether the frontend shows the logs panel
- `customer-build` disables backend `vpn-log` emits for customer releases
- This allows clean customer builds without noisy connection logs in the UI

---

## macOS Fresh Reinstall / Rebuild Script

For macOS, you can use the reinstall script to fully rebuild the app, reinstall the privileged helper, restart the LaunchDaemon, and launch the fresh app bundle.

Script:

```bash
./reinstall_stellar_vpn_macos.sh
```

### Modes

#### Internal build

Builds the internal version with dashboard VPN logs enabled:

```bash
./reinstall_stellar_vpn_macos.sh --internal
```

#### Customer build

Builds the customer version with dashboard VPN logs hidden:

```bash
./reinstall_stellar_vpn_macos.sh --customer
```

### Default mode

If no flag is passed, the script builds:

```bash
./reinstall_stellar_vpn_macos.sh
```

This defaults to:

```text
--internal
```

### What the script does

- Stops old app/helper/OpenVPN processes
- Removes old helper sockets
- Cleans previous Rust build output
- Builds the macOS privileged helper
- Builds the Tauri app bundle
- Installs the helper into `/Library/PrivilegedHelperTools`
- Restarts the LaunchDaemon
- Verifies the helper is running
- Opens the freshly built app bundle

### Build parameters used by the script

For **internal**:

```bash
VITE_SHOW_VPN_LOGS=true
```

and Rust builds normally.

For **customer**:

```bash
VITE_SHOW_VPN_LOGS=false
```

and Tauri/Rust builds with:

```bash
--features customer-build
```

For the helper build, the script uses:

```bash
--features "macos-build,customer-build"
```

when building customer mode.

---

## Signing Releases

Stellar VPN Desktop uses **Tauri’s mandatory signing system** for release bundles and OTA updates.

### Environment variables

Set the signing key and password **before building**:

```bash
export TAURI_SIGNING_PRIVATE_KEY="/path/to/vpn.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="YOUR_PASSWORD"
```

Notes:
- Never commit private keys or passwords
- Prefer CI secrets for production builds
- Losing the private key means existing installs cannot receive updates

After setting the variables, run:

```bash
cargo tauri build
```

Artifacts and update packages will be signed automatically.

---

## OTA Updates (Updater)

The app uses **Tauri Updater** with signed artifacts.

### Configuration

The updater is configured in `tauri.conf.json` with:
- Update endpoint (`latest.json`)
- Public key for signature verification

### OTA Release Flow

1. Set signing environment variables
2. Build a release:
   ```bash
   cargo tauri build
   ```
3. Upload generated updater artifacts + `latest.json` to the release server
4. Clients automatically verify signatures and apply updates securely

OTA updates are:
- Cryptographically verified
- Fail-safe
- Mandatory signature-checked

---

## Autostart (Important)

Autostart **must only be enabled from a release / installed build**.

Do **not** enable autostart from:
- `cargo tauri dev`
- Debug binaries

Dev builds use a localhost UI (`devUrl`) and will fail on system startup.

---

## Security Principles

- Security-first architecture
- Minimal privileges
- Explicit permissions (Tauri capabilities)
- No silent privilege escalation
- Signed updates only

---

## License & Origin

Stellar VPN Desktop is developed by **Stellar Security (Switzerland)** 🇨🇭  
Mission: *Protect everyone’s privacy and security.*

---

© Stellar Security