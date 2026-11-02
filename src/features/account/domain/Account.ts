export interface Account {
  cached?: boolean;
  id: string;
  subscriptionState: 'available' | 'none' | 'unavailable';
  subscription: { id: string; status: 'active' | 'trial' | 'inactive' | 'expired' | 'pending'; expiresAt: string | null } | null;
  devicesState: 'available' | 'unavailable' | 'not_applicable';
  devices: { id: string; name: string }[] | null;
}
export interface AccountRepository { current(): Promise<Account>; cached?(): Promise<Account | null>; activateCode?(code: string): Promise<void> }
export function mergeAccount(previous: Account | null, current: Account): Account {
  if (!previous || previous.id !== current.id) return current;
  const subscriptionFallback = current.subscriptionState === 'unavailable' && previous.subscriptionState !== 'unavailable';
  const subscription = subscriptionFallback ? previous.subscription : current.subscription;
  const subscriptionState = subscriptionFallback ? previous.subscriptionState : current.subscriptionState;
  const devicesFallback = current.devicesState === 'unavailable' && previous.devicesState !== 'unavailable'
    && (subscriptionFallback || (previous.devicesState === 'available' && subscription?.id === previous.subscription?.id));
  return { ...current, subscription, subscriptionState,
    devicesState: devicesFallback ? previous.devicesState : current.devicesState,
    devices: devicesFallback ? previous.devices : current.devices,
    ...((subscriptionFallback || devicesFallback) ? { cached: true } : {}),
  };
}
/** Cache only the validated display DTO, never a raw upstream response. */
export function accountCacheData(account: Account): string {
  return JSON.stringify({ account_id: account.id, subscription_state: account.subscriptionState,
    subscription: account.subscription ? { id: account.subscription.id, status: account.subscription.status, expires_at: account.subscription.expiresAt } : null,
    devices_state: account.devicesState, devices: account.devices?.map(({ id, name }) => ({ id, name })) ?? null });
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function decodeAccount(value: unknown, expectedId: string): Account {
  if (!object(value) || value.account_id !== expectedId || !/^[1-9][0-9]*$/.test(expectedId)
    || !['available', 'none', 'unavailable'].includes(String(value.subscription_state))) throw new Error('Stellar returned invalid account data.');
  const state = value.subscription_state as Account['subscriptionState'];
  if (!['available', 'unavailable', 'not_applicable'].includes(String(value.devices_state))) throw new Error('Stellar returned invalid device data.');
  const devicesState = value.devices_state as Account['devicesState'];
  if ((state === 'none' && devicesState !== 'not_applicable') || (state === 'unavailable' && devicesState !== 'unavailable')
    || (state === 'available' && devicesState === 'not_applicable')) throw new Error('Stellar returned inconsistent account data.');
  let devices: Account['devices'] = null;
  if (devicesState === 'unavailable') {
    if (value.devices !== null) throw new Error('Stellar returned invalid device data.');
  } else {
    if (!Array.isArray(value.devices) || value.devices.length > 200 || (devicesState === 'not_applicable' && value.devices.length)) throw new Error('Stellar returned invalid device data.');
    const seen = new Set<string>();
    devices = value.devices.map((device: unknown) => {
      if (!object(device) || typeof device.id !== 'string' || !/^(?:[1-9][0-9]*|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(device.id) || seen.has(device.id)
        || typeof device.name !== 'string' || !device.name.trim() || device.name.length > 120 || /[\x00-\x1f\x7f]/.test(device.name)) throw new Error('Stellar returned invalid device data.');
      seen.add(device.id); return { id: device.id, name: device.name };
    });
  }
  if (state !== 'available') {
    if (value.subscription !== null) throw new Error('Stellar returned invalid account data.');
    return { id: expectedId, subscriptionState: state, subscription: null, devicesState, devices };
  }
  const sub = value.subscription;
  if (!object(sub) || typeof sub.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(sub.id)
    || !['active', 'trial', 'inactive', 'expired', 'pending'].includes(String(sub.status))
    || (sub.expires_at !== null && (typeof sub.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(sub.expires_at) || !Number.isFinite(Date.parse(sub.expires_at))))) throw new Error('Stellar returned invalid account data.');
  return { id: expectedId, subscriptionState: state, subscription: { id: sub.id, status: sub.status as NonNullable<Account['subscription']>['status'], expiresAt: sub.expires_at }, devicesState, devices };
}
export function daysRemaining(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / 86_400_000)) : 0;
}
export function subscriptionExpiring(account: Account | null, now = Date.now()) {
  const sub = account?.subscription;
  if (!sub) return false;
  if (sub.status === 'expired') return true;
  if (!sub.expiresAt) return false;
  const expiry = Date.parse(sub.expiresAt);
  return Number.isFinite(expiry) && (expiry <= now || ((sub.status === 'active' || sub.status === 'trial') && daysRemaining(sub.expiresAt, now) <= 14));
}
export function describeSubscription(account: Account, now = Date.now(), locale = 'en-GB') {
  const sub = account.subscription;
  const date = sub?.expiresAt ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(sub.expiresAt)) : null;
  const expired = sub?.status === 'expired' || (!!sub?.expiresAt && Date.parse(sub.expiresAt) <= now);
  const active = !!sub && !expired && (sub.status === 'active' || sub.status === 'trial');
  const remaining = active && sub.expiresAt ? daysRemaining(sub.expiresAt, now) : null;
  const title = !sub ? account.subscriptionState === 'none' ? 'No VPN subscription found' : 'Subscription unavailable'
    : sub.status === 'pending' ? 'Awaiting activation' : expired ? 'Subscription expired' : sub.status === 'inactive' ? 'Subscription inactive'
    : remaining !== null ? `${remaining} days remaining` : sub.status === 'trial' ? 'Trial subscription' : 'Active subscription';
  const description = !sub ? account.subscriptionState === 'none' ? 'No VPN subscription.' : 'Couldn’t load your subscription.'
    : sub.status === 'pending' ? 'Your subscription is awaiting activation.' : expired ? 'Your VPN subscription has expired.' : !active ? 'Your subscription is inactive.'
    : date ? `Your ${sub.status === 'trial' ? 'trial ' : ''}VPN access expires on ${date}.` : 'No expiry date available.';
  return { title, description, date, remaining, expired };
}
