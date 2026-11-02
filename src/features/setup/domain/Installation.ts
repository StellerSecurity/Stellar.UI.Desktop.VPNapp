export interface InstallationStatus {
  platform: 'macos' | 'windows' | 'unsupported' | 'preview';
  helper: 'ready' | 'missing' | 'unavailable' | 'outdated';
  firewallVerified: boolean;
  language: string;
  setupIssue?: 'installer_required' | 'unsupported_architecture' | 'helper_untrusted';
}
export interface InstallationPort {
  check(): Promise<InstallationStatus>;
  openHelper?(): Promise<void>;
}
export function decodeInstallation(value: unknown): InstallationStatus {
  if (!value || typeof value !== 'object') throw new Error('Invalid installation status');
  const data = value as Record<string, unknown>;
  if (typeof data.platform !== 'string' || typeof data.helper !== 'string' || !['macos', 'windows', 'unsupported', 'preview'].includes(data.platform) || !['ready', 'missing', 'unavailable', 'outdated'].includes(data.helper)
    || typeof data.firewallVerified !== 'boolean' || typeof data.language !== 'string' || data.language.length > 64) throw new Error('Invalid installation status');
  if (data.setupIssue != null && !['installer_required', 'unsupported_architecture', 'helper_untrusted'].includes(data.setupIssue as string)) throw new Error('Invalid installation issue');
  return { platform: data.platform as InstallationStatus['platform'], helper: data.helper as InstallationStatus['helper'], firewallVerified: data.firewallVerified, language: data.language,
    ...(data.setupIssue == null ? {} : { setupIssue: data.setupIssue as InstallationStatus['setupIssue'] }) };
}
export const installationReady = (status: InstallationStatus) => status.platform === 'preview' || ['macos', 'windows'].includes(status.platform) && status.helper === 'ready' && !status.setupIssue;
export const requiresInstallationHelp = (status: InstallationStatus | null, failed = false) => failed || !!status && ['macos', 'windows'].includes(status.platform) && !installationReady(status);
