import type { InstallationStatus } from './Installation.ts';

// One diagnostic at a time. Never offer elevation when the fixed helper is absent
// or incompatible, and never interpret setup diagnostics as VPN readiness.
export function installationHelpState(status: InstallationStatus | null, error: boolean, openError: boolean, opened: boolean) {
  const issue = status?.platform === 'windows' ? status.setupIssue : undefined;
  const blocked = !!issue;
  const description = issue === 'unsupported_architecture'
    ? 'This x64 Windows build cannot connect on Windows ARM. It needs an ARM64 VPN driver and a compatible installer. Retrying administrator approval will not fix this.'
    : issue === 'installer_required'
      ? 'The network helper is missing. This app cannot install it by itself. Use a complete Stellar VPN installer before connecting.'
      : issue === 'helper_untrusted'
        ? 'The network helper could not be verified. Reinstall using a complete, signed Stellar VPN installer. No administrator request was opened.'
        : 'One small step before you connect. Install the network helper so Stellar VPN can create your VPN connection.';
  const diagnostic = blocked ? null
    : error || openError || status?.helper === 'unavailable'
      ? 'Setup could not finish. Check macOS permission prompts and try again.'
      : status?.helper === 'outdated' ? 'Update required'
        : opened ? 'Finish the installation in macOS, then return here and try again.' : null;
  return {
    title: issue === 'unsupported_architecture' ? 'Windows ARM support required'
      : issue === 'installer_required' ? 'Complete installation required'
        : issue === 'helper_untrusted' ? 'Network helper needs verification' : 'Get Stellar VPN ready',
    description, diagnostic, alert: !blocked && (error || openError),
    retryOnly: blocked,
    button: blocked ? 'Check again' : opened ? 'Try again' : 'Install network helper',
    footnote: blocked ? 'This build cannot enable VPN protection on this Windows installation.'
      : 'macOS will ask for administrator approval. A local firewall check may briefly interrupt your network.',
  };
}
