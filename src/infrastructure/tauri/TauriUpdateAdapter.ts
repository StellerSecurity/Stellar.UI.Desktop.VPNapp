import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { decodeUpdate, type UpdatePort, type UpdateState } from '../../features/updates/domain/Update';
export class TauriUpdateAdapter implements UpdatePort {
  private unavailable(): UpdateState { return { phase: 'unsupported', currentVersion: '', version: null, notes: '', downloaded: 0, message: 'Updates are available in the installed desktop app.' }; }
  async check() { return isTauri() ? decodeUpdate(await invoke('check_update')) : this.unavailable(); }
  async download() { return isTauri() ? decodeUpdate(await invoke('download_update')) : this.unavailable(); }
  async install() { if (isTauri()) await invoke('install_update'); }
  async cancel() { if (isTauri()) await invoke('cancel_update'); }
  async subscribe(callback: (state: UpdateState) => void) {
    if (!isTauri()) return () => {};
    return listen<unknown>('update-changed', event => { try { callback(decodeUpdate(event.payload)); } catch { /* Discard malformed IPC. */ } });
  }
}
