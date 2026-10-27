import type { ConnectionPort } from '../domain/Connection';
import type { ConnectionSnapshot } from '../../../contracts/desktop';

/** Orders commands and prevents late responses from replacing a newer intent. */
export class ConnectionService {
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private port: ConnectionPort;
  constructor(port: ConnectionPort) { this.port = port; }
  private run(command: () => Promise<ConnectionSnapshot>) {
    const revision = ++this.revision;
    const task = this.queue.then(command, command);
    this.queue = task.catch(() => undefined);
    return task.then(
      value => revision === this.revision ? { value, current: true as const } : { value: null, current: false as const },
      error => { if (revision !== this.revision) return { value: null, current: false as const }; throw error; }
    );
  }
  connect(serverId: string) { return this.run(() => this.port.connect(serverId)); }
  disconnect() { return this.run(() => this.port.disconnect()); }
}
