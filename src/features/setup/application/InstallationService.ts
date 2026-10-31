import { decodeInstallation, type InstallationPort } from '../domain/Installation.ts';
export class InstallationService {
  private port: InstallationPort;
  private timeoutMs: number;
  constructor(port: InstallationPort, timeoutMs = 5000) { this.port = port; this.timeoutMs = timeoutMs; }
  async openHelper() {
    if (!this.port.openHelper) throw new Error('Setup unavailable');
    await this.port.openHelper();
  }
  async check() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return decodeInstallation(await Promise.race([this.port.check(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installation check timed out')), this.timeoutMs);
      })]));
    } finally { clearTimeout(timer); }
  }
}
