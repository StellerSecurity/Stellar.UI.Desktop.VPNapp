import type { SessionPort } from '../domain/Auth';
/** Session use cases delegate transport and never retain passwords or bearer tokens. */
export class SessionService {
  private port: SessionPort;
  constructor(port: SessionPort) { this.port = port; }
  login(email: string, password: string) { return this.port.login(email, password); }
  register(email: string, password: string) { return this.port.register(email, password); }
  logout() { return this.port.logout(); }
  completeOnboarding() { return this.port.completeOnboarding(); }
}
