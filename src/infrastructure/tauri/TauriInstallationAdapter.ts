import { invoke, isTauri } from '@tauri-apps/api/core';
import type { InstallationPort, InstallationStatus } from '../../features/setup/domain/Installation';
export class TauriInstallationAdapter implements InstallationPort {
  async openHelper() { if (isTauri()) await invoke('open_network_helper'); }
  async check(): Promise<InstallationStatus> {
    if (!isTauri()) return { platform: 'preview', helper: 'ready', firewallVerified: false, language: 'English' };
    return invoke<InstallationStatus>('installation_status');
  }
}
