export interface DeviceLogin { id: string; current: boolean; createdAt: string; revoked: boolean }
export interface DeviceLoginsPage { sessions: DeviceLogin[]; nextCursor: string | null }
export const validDeviceSessionId = (id: string) => /^d1[a-f0-9]{32}$/.test(id);

/** Accept a bounded, ordered public projection; never retain server token/hash fields. */
export function deviceLoginsPage(value: Record<string, unknown>, after?: string): DeviceLoginsPage {
  if (!Array.isArray(value.sessions) || value.sessions.length > 50
    || !(value.next_cursor === null || typeof value.next_cursor === 'string' && validDeviceSessionId(value.next_cursor))) {
    throw new Error('Stellar returned invalid session data.');
  }
  let previous = after;
  let current = 0;
  const sessions = value.sessions.map((item: unknown): DeviceLogin => {
    if (!item || typeof item !== 'object') throw new Error('Stellar returned invalid session data.');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !validDeviceSessionId(row.id) || previous !== undefined && row.id <= previous
      || typeof row.current !== 'boolean' || typeof row.revoked !== 'boolean' || row.current && ++current > 1
      || typeof row.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(row.created_at)
      || !Number.isFinite(Date.parse(row.created_at))) throw new Error('Stellar returned invalid session data.');
    previous = row.id;
    return { id: row.id, current: row.current, createdAt: row.created_at, revoked: row.revoked };
  });
  if (value.next_cursor !== null && (sessions.length !== 50 || value.next_cursor !== previous)) {
    throw new Error('Stellar returned invalid session data.');
  }
  return { sessions, nextCursor: value.next_cursor as string | null };
}
