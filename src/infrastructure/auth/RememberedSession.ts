/** Never present an in-memory-only login as a remembered desktop session. */
export function requireRememberedSession<T extends { remembered: boolean }>(session: T): T {
  if (session.remembered !== true) {
    throw { code: 'session_storage_unavailable' };
  }
  return session;
}
