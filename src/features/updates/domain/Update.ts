export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported';
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  version: string | null;
  notes: string;
  downloaded: number;
  message: string;
}
export interface UpdatePort {
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
  cancel(): Promise<void>;
  subscribe(callback: (state: UpdateState) => void): Promise<() => void>;
}
const phases: readonly string[] = ['idle', 'checking', 'current', 'available', 'downloading', 'ready', 'installing', 'error', 'unsupported'];
export function decodeUpdate(value: unknown): UpdateState {
  if (!value || typeof value !== 'object') throw new Error('Invalid update state.');
  const s = value as Record<string, unknown>;
  if (typeof s.phase !== 'string' || !phases.includes(s.phase) || typeof s.currentVersion !== 'string' || s.currentVersion.length > 64
    || (s.version !== null && (typeof s.version !== 'string' || s.version.length > 64))
    || typeof s.notes !== 'string' || s.notes.length > 8192 || typeof s.message !== 'string' || s.message.length > 512
    || !Number.isSafeInteger(s.downloaded) || Number(s.downloaded) < 0 || Number(s.downloaded) > 512 * 1024 * 1024
    || (['available', 'downloading', 'ready', 'installing'].includes(s.phase) && (typeof s.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(s.version)))) throw new Error('Invalid update state.');
  return s as unknown as UpdateState;
}
export function mayInstall(state: UpdateState, connection: string | undefined, blocked: boolean, busy: boolean) {
  return state.phase === 'ready' && connection === 'disconnected' && !blocked && !busy;
}
