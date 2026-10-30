import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Container } from './container';
import type { DesktopSnapshot, Settings } from '../contracts/desktop';
import type { Server } from '../features/locations/domain/Server';
import type { BooleanSetting } from '../features/settings/domain/Settings';
import type { Account } from '../features/account/domain/Account';
import { markerAction } from '../features/map/domain/MarkerAction';
import { autoConnectTarget } from '../features/connection/domain/AutoConnect';
import { usePanelNavigation } from '../shared/ui/usePanelNavigation';
import { AccountRefresh, CONNECTED_ACCOUNT_REFRESH_INTERVAL } from '../application/AccountRefresh';
import type { UpdateState } from '../features/updates/domain/Update';
import { compactConnectionLayout } from '../features/connection/domain/ConnectionLayout';
import { I18nProvider } from '../shared/i18n/I18n';
import { subscriptionRequired, subscriptionErrorResolved } from '../features/account/domain/VpnAccess';

import { screenAfterSessionUpdate, type Screen } from './SessionScreen';
export type { Screen } from './SessionScreen';
export type View = 'connection' | 'general' | 'relay' | 'account' | 'devices';
export type DialogId = 'auto-rotate' | 'plan' | 'activation' | 'trust' | 'logout' | 'subscription';
function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'The action could not be completed. Please try again.';
}
function useAppState(container: Container, surface: 'main' | 'tray') {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountStatus, setAccountStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [accountError, setAccountError] = useState('');
  const [accountAttempt, setAccountAttempt] = useState(0);
  const accountRefresh = useRef(new AccountRefresh());
  const [screen, setScreen] = useState<Screen>('booting');
  const [view, setView] = useState<View>('connection');
  const navigateView = usePanelNavigation(view, setView);
  const [servers, setServers] = useState<Server[]>(() => container.servers.cached());
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('cz-1');
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [connectionErrorKind, setConnectionErrorKind] = useState<'subscription' | null>(null);
  const [pendingAction, setPendingAction] = useState<'connect' | 'disconnect'>('connect');
  const [collapsed, setCollapsed] = useState(compactConnectionLayout);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => container.favorites.load());
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const previousAccess = useRef<boolean | null>(null);
  const [toast, setToast] = useState('');
  const [bootError, setBootError] = useState('');
  const autoConnected = useRef(false);
  const bootReady = useRef(false);
  const notify = (message: string) => setToast(message);
  useEffect(() => {
    // Reconcile only on a new account result, not against an older active
    // display value when a subsequent connection attempt has just failed.
    if (!subscriptionErrorResolved(account, connectionErrorKind)) return;
    setConnectionError('');
    setConnectionErrorKind(null);
    setDialog(current => current === 'subscription' ? null : current);
  }, [account]);
  useEffect(() => {
    const active = snapshot?.subscriptionAccess?.active;
    if (active === false) autoConnected.current = true;
    if (active === false && previousAccess.current === true) setDialog('subscription');
    previousAccess.current = snapshot?.session.authenticated ? active ?? null : null;
  }, [snapshot?.subscriptionAccess?.active, snapshot?.session.authenticated]);
  async function checkUpdate() { try { setUpdate(await container.updates.check()); } catch { /* Keep the last known state on a background check failure. */ } }
  async function downloadUpdate() { try { setUpdate(await container.updates.download()); } catch (error) { notify(errorMessage(error)); } }
  async function installUpdate() { try { await container.updates.install(); } catch (error) { notify(errorMessage(error)); } }
  async function activateCode(code: string) {
    if (!container.account.activateCode) throw new Error('Activation is unavailable in this environment.');
    await container.account.activateCode(code);
    setAccountAttempt(attempt => attempt + 1);
  }
  useEffect(() => {
    if (surface !== 'main') return;
    let live = true, stop: (() => void) | undefined;
    const check = () => { void container.updates.check().then(s => { if (live) setUpdate(s); }).catch(() => {}); };
    void container.updates.subscribe(s => { if (live) setUpdate(s); }).then(fn => { if (live) stop = fn; else fn(); }).catch(() => {});
    check();
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    const interval = setInterval(check, 4 * 60 * 60 * 1000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', visible);
    return () => { live = false; stop?.(); clearInterval(interval); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible); };
  }, [container, surface]);
  useEffect(() => { container.favorites.save(favoriteIds); }, [container, favoriteIds]);
  useEffect(() => {
    let live = true; let stop: (() => void) | undefined;
    void container.desktop.onNativeConnectionState?.(id => {
      if (!live) return;
      if (cancellingRef.current) return;
      setPending(id !== null);
      setPendingSince(current => id ? current ?? Date.now() : null);
      if (id) setPendingAction('connect');
      if (id) setSelectedId(id);
    }).then(unsubscribe => { if (live) stop = unsubscribe; else unsubscribe(); }).catch(() => {});
    return () => { live = false; stop?.(); };
  }, [container]);
  useEffect(() => {
    const current = snapshot?.connection.serverId;
    if (surface !== 'main' || !snapshot?.session.authenticated || !snapshot.settings.autoRotate
      || snapshot.connection.status !== 'connected' || !current || servers.length < 2 || !container.desktop.prepareRotation) return;
    const index = servers.findIndex(server => server.id === current);
    const next = servers[(index + 1) % servers.length];
    if (!next || next.id === current) return;
    let live = true;
    void container.desktop.prepareRotation(next.id, `${next.country} – ${next.city}`)
      .catch(() => { if (live) notify('Couldn’t prepare Auto Rotate. Your current connection is unchanged.'); });
    return () => { live = false; };
  }, [container, surface, servers, snapshot?.session.authenticated, snapshot?.settings.autoRotate, snapshot?.connection.status, snapshot?.connection.serverId]);
  useEffect(() => {
    if (surface !== 'main') return;
    let live = true;
    let stop: (() => void) | undefined;
    void container.desktop.onShowLocations?.(() => { if (live) { setView('connection'); setCollapsed(false); } })
      .then(unsubscribe => { if (live) stop = unsubscribe; else unsubscribe(); }).catch(error => notify(errorMessage(error)));
    return () => { live = false; stop?.(); };
  }, [container, surface]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void container.desktop.subscribe?.(state => {
      if (!live) return;
      setSnapshot(state);
      if (state.selectedServerId || state.connection.serverId) setSelectedId(state.selectedServerId || state.connection.serverId!);
      if (bootReady.current) setScreen(current => screenAfterSessionUpdate(current, state.session));
    }).then(unsubscribe => { if (live) stop = unsubscribe; else unsubscribe(); }).catch(error => notify(errorMessage(error)));
    return () => { live = false; stop?.(); };
  }, [container]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const cached = container.servers.cached();
    if (cached.length) { setServers(cached); setCatalogStatus('ready'); }
    else setCatalogStatus('loading');
    setCatalogError('');
    void container.servers.list(controller.signal).then(locations => {
      if (!live) return;
      setServers(locations); setCatalogStatus('ready');
    }).catch(error => { if (live) { setCatalogStatus('error'); setCatalogError(errorMessage(error)); } });
    return () => { live = false; controller.abort(); };
  }, [container, catalogAttempt]);
  useEffect(() => {
    // A failed refresh keeps the last-known list. Retry naturally when the
    // network returns or the user reopens the app, without resetting that list.
    const refresh = () => setCatalogAttempt(attempt => attempt + 1);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [container]);
  useEffect(() => {
    let live = true;
    bootReady.current = false;
    // Account sign-in does not depend on the public location catalog.
    container.desktop.bootstrap().then(state => {
      if (!live) return;
      if (state.contractVersion !== 1) throw new Error('Unsupported desktop protocol. Update the app.');
      setSnapshot(state);
      setSelectedId(state.selectedServerId || state.connection.serverId || 'cz-1');
      bootReady.current = true;
      const params = new URLSearchParams(location.search);
      setScreen(params.get('auth') === '1' ? 'auth'
        : params.get('onboarding') === '1' ? 'onboarding'
        : !state.session.authenticated ? 'auth' : !state.session.onboardingComplete ? 'onboarding' : 'app');
    }).catch(error => { if (live) setBootError(errorMessage(error)); });
    return () => { live = false; bootReady.current = false; };
  }, [container]);
  useEffect(() => {
    if (!snapshot?.session.authenticated) {
      setAccount(null); setAccountStatus('idle'); setAccountError(''); return;
    }
    // Warm the account cache after sign-in, independently of navigation.
    if (surface !== 'main') return;
    let live = true;
    accountRefresh.current.mark(Date.now());
    setAccountStatus('loading'); setAccountError('');
    void (async () => {
      const cached = await container.account.cached?.().catch(() => null);
      if (!live) return;
      if (cached) { setAccount(cached); setAccountStatus('ready'); }
      try {
        const value = await container.account.current();
        if (live) { setAccount(value); setAccountStatus('ready'); }
      } catch (error) { if (live) { setAccountStatus('error'); setAccountError(errorMessage(error)); } }
    })();
    return () => { live = false; };
  }, [container, surface, snapshot?.session.authenticated, accountAttempt]);
  useEffect(() => {
    if (surface !== 'main' || !snapshot?.session.authenticated) return;
    const refresh = () => { if (accountRefresh.current.request(Date.now())) setAccountAttempt(attempt => attempt + 1); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    // Native/browser minute pulses are local only; HTTP is gated to 30 minutes.
    const periodic = () => { if (accountRefresh.current.request(Date.now(), true, snapshot?.connection.status === 'connected' ? CONNECTED_ACCOUNT_REFRESH_INTERVAL : undefined)) setAccountAttempt(attempt => attempt + 1); };
    let live = true, stop: (() => void) | undefined;
    void container.desktop.onAccountRefresh?.(reason => { if (live) { if (reason === 'resume') refresh(); else periodic(); } })
      .then(unsubscribe => { if (live) stop = unsubscribe; else unsubscribe(); }).catch(() => {});
    const timer = setInterval(periodic, 60_000);
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { live = false; stop?.(); clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [container, surface, snapshot?.session.authenticated, snapshot?.connection.status]);
  useEffect(() => {
    if (surface === 'main' && snapshot?.session.authenticated && (view === 'account' || view === 'devices')
      && accountRefresh.current.request(Date.now())) setAccountAttempt(attempt => attempt + 1);
  }, [view, surface, snapshot?.session.authenticated]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (surface !== 'main' || !snapshot?.session.authenticated) return;
    let live = true;
    const timer = setInterval(() => {
      void container.desktop.bootstrap().then(state => {
        if (!live) return;
        setSnapshot(state);
        if (!state.session.authenticated) { setScreen('auth'); notify('Your session has expired. Please log in again.'); }
      }).catch(() => { /* A transient IPC failure must not invent an authenticated session. */ });
    }, 2_000);
    return () => { live = false; clearInterval(timer); };
  }, [container, surface, snapshot?.session.authenticated]);
  async function connect(id = selectedId) {
    if (cancellingRef.current) return;
    if (!servers.some(server => server.id === id)) { notify('Choose an available location before connecting.'); return; }
    autoConnected.current = true;
    setPendingAction('connect');
    setPendingSince(Date.now()); setConnectionError(''); setConnectionErrorKind(null);
    setPending(true);
    try {
      const result = await container.connection.connect(id);
      if (result.current) {
        setSnapshot(state => state && { ...state, connection: result.value }); setPending(false);
      }
    } catch (error) { setPending(false); setConnectionError(errorMessage(error)); setConnectionErrorKind(subscriptionRequired(error) ? 'subscription' : null); if (subscriptionRequired(error)) setDialog('subscription'); }
  }
  async function cancelConnect() {
    if (cancellingRef.current) return;
    autoConnected.current = true;
    cancellingRef.current = true; setCancelling(true); setPending(true);
    try {
      const result = await container.connection.cancelConnect();
      if (result.current) { setSnapshot(state => state && { ...state, connection: result.value }); setPending(false); setPendingSince(null); setConnectionError(''); }
    } catch (error) {
      // A failed stop is not evidence that the tunnel has stopped.
      setConnectionError(errorMessage(error));
    } finally { cancellingRef.current = false; setCancelling(false); }
  }
  async function disconnect() {
    if (cancellingRef.current) return;
    autoConnected.current = true; // A deliberate disconnect must never trigger startup reconnect.
    setPendingAction('disconnect');
    setConnectionError(''); setPendingSince(Date.now());
    setPending(true);
    try {
      const result = await container.connection.disconnect();
      if (result.current) { setSnapshot(state => state && { ...state, connection: result.value }); setPending(false); }
    } catch (error) { setPending(false); notify(errorMessage(error)); }
  }
  useEffect(() => {
    if (surface !== 'main' || screen !== 'app') return;
    const target = autoConnectTarget(snapshot, catalogStatus === 'ready', servers.map(server => server.id), autoConnected.current, pending);
    if (!target) return;
    autoConnected.current = true;
    void connect(target);
  }, [surface, screen, snapshot, servers, catalogStatus, pending]);
  function selectServer(id: string) {
    if (cancellingRef.current || !servers.some(s => s.id === id) || id === selectedId) return;
    setSelectedId(id);
    void container.desktop.selectLocation?.(id).catch(error => notify(errorMessage(error)));
    if (snapshot?.connection.status === 'connected' || pending) void connect(id);
  }
  function activateMarker(id: string) {
    const action = markerAction(id, servers.map(server => server.id), snapshot?.connection, pending);
    if (action === 'ignore') return;
    if (id !== selectedId) {
      setSelectedId(id);
      void container.desktop.selectLocation?.(id).catch(error => notify(errorMessage(error)));
    }
    if (action === 'connect') void connect(id);
  }
  function saveSettings(settings: Settings) {
    setSnapshot(state => state && { ...state, settings });
    void container.settings.save(settings).catch(async error => {
        try { const current = await container.desktop.bootstrap(); setSnapshot(state => state && { ...state, settings: current.settings }); } catch { /* Keep the last visible values; retry remains possible. */ }
        notify(errorMessage(error));
    });
  }
  function toggleSetting(key: BooleanSetting) { if (snapshot) saveSettings({ ...snapshot.settings, [key]: !snapshot.settings[key] }); }
  async function authenticate(operation: 'login' | 'register' | 'account', email: string, password: string) {
    setConnectionError(''); setConnectionErrorKind(null);
    setAccount(null); setAccountStatus('idle');
    const session = await (operation === 'account' ? container.session.loginAccount(email) : container.session[operation](email, password));
    setSnapshot(state => state && { ...state, session });
    setAccountAttempt(attempt => attempt + 1);
    if (!servers.length) setCatalogAttempt(attempt => attempt + 1);
    setScreen('onboarding');
    if (session.remembered === false) notify('Signed in, but this login could not be remembered securely.');
  }
  async function finishOnboarding() {
    if (!snapshot?.session.authenticated) { setScreen('auth'); return; }
    try {
      const session = await container.session.completeOnboarding();
      setSnapshot(state => state && { ...state, session });
      const url = new URL(location.href); url.searchParams.delete('auth'); url.searchParams.delete('onboarding');
      history.replaceState(null, '', url.pathname + url.search);
      setView('connection'); setScreen('app');
    } catch (error) { notify(errorMessage(error)); }
  }
  async function logout() {
    try {
      await container.connection.disconnect();
      const session = await container.session.logout();
      setSnapshot(state => state && { ...state, session, connection: { status: 'disconnected', serverId: null, connectedAt: null } });
      setDialog(null); setPending(false); setView('connection'); setScreen('auth'); autoConnected.current = false;
      setConnectionError(''); setConnectionErrorKind(null);
      if (session.revocationPending) notify('You are logged out locally. Stellar could not confirm server revocation; the remote session expires automatically.');
    } catch (error) { notify(errorMessage(error)); }
  }
  return { snapshot, account, accountStatus, accountError, update, checkUpdate, downloadUpdate, installUpdate, cancelUpdate: () => container.updates.cancel(), refreshAccount: () => setAccountAttempt(attempt => attempt + 1), screen, setScreen, view, setView: navigateView, servers, selectedId,
    catalogStatus, catalogError, retryCatalog: () => setCatalogAttempt(attempt => attempt + 1),
    selected: servers.find(server => server.id === selectedId), pending, pendingAction, pendingSince, cancelling, connectionError, connectionErrorKind, cancelConnect, collapsed, setCollapsed,
    favoriteIds, toggleFavorite: (id: string) => setFavoriteIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]),
    dialog, setDialog, toast, notify, bootError, connect, disconnect, selectServer, activateMarker, saveSettings, toggleSetting,
    authenticate, finishOnboarding, logout, activateCode, loadWorldMap: container.loadWorldMap,
    showMain: () => container.desktop.showMain?.(), showLocations: () => container.desktop.showLocations?.(), hideTray: () => container.desktop.hideTray?.(), quit: () => container.desktop.quit?.(),
    openExternal: (url: string) => { void container.desktop.openExternal(url).catch(error => notify(errorMessage(error))); } };
}
type AppState = ReturnType<typeof useAppState>;
const AppContext = createContext<AppState | null>(null);
export function AppProvider({ container, children, surface = 'main' }: { container: Container; children: ReactNode; surface?: 'main' | 'tray' }) {
  const state = useAppState(container, surface);
  return <AppContext.Provider value={state}><I18nProvider language={state.snapshot?.settings.language || 'English'}>{children}</I18nProvider></AppContext.Provider>;
}
export function useApp() {
  const state = useContext(AppContext);
  if (!state) throw new Error('AppProvider is missing');
  return state;
}
