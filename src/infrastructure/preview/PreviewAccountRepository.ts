import type { AccountRepository } from '../../features/account/domain/Account';
export class PreviewAccountRepository implements AccountRepository {
  async current() {
    return { id: '8237 6194 4821 3065', deviceName: 'Winged Coral', deviceLimit: 6, devicesUsed: 1,
      expiresAt: '2026-11-20T00:00:00+01:00', periodDays: 30 };
  }
}
