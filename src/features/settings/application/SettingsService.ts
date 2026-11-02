import type { Settings } from '../../../contracts/desktop';
import type { SettingsPort } from '../domain/Settings';

export class SettingsService {
  private port: SettingsPort;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(port: SettingsPort) { this.port = port; }
  save(settings: Settings) {
    const revision = ++this.revision;
    const task = this.queue.then(() => this.port.saveSettings({ ...settings }));
    this.queue = task.catch(() => undefined);
    return task.then(
      value => ({ value, current: revision === this.revision }),
      error => { if (revision === this.revision) throw error; return { value: settings, current: false }; }
    );
  }
}
