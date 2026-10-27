import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Container } from './container';
import type { DesktopSnapshot, Settings } from '../contracts/desktop';
import type { Server } from '../features/locations/domain/Server';
import type { BooleanSetting } from '../features/settings/domain/Settings';
import type { Account } from '../features/account/domain/Account';

export type Screen = 'booting' | 'auth' | 'onboarding' | 'app';
export type View = 'connection' | 'general' | 'relay' | 'account';
export type DialogId = 'auto-rotate' | 'plan' | 'activation' | 'trust' | 'logout';
function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'The action could not be completed. Please try again.';
}
function useAppState(container: Container, surface: 'main' | 'tray') {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [screen, setScreen] = useState<Screen>('booting');
  const [view, setView] = useState<View>('connection');
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedId, setSelectedId] = useState('cz-1');
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(['cz-1', 'dk-1', 'ch-1']);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [toast, setToast] = useState('');
  const [bootError, setBootError] = useState('');
  const autoConnected = useRef(false);
  const bootReady = useRef(false);
  const notify = (message: string) => setToast(message);
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
      if (bootReady.current) setScreen(!state.session.authenticated ? 'auth' : !state.session.onboardingComplete ? 'onboarding' : 'app');
    }).then(unsubscribe => { if (live) stop = unsubscribe; else unsubscribe(); }).catch(error => notify(errorMessage(error)));
    return () => { live = false; stop?.(); };
  }, [container]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    bootReady.current = false;
    // Sign-in must remain available even when the independent fixture catalog is offline.
    void container.servers.list(controller.signal).then(locations => {
      if (!live) return;
      setServers(locations);
    }).catch(error => { if (live) notify(errorMessage(error)); });
    Promise.all([container.desktop.bootstrap(), container.account.current()]).then(([state, account]) => {
      if (!live) return;
      if (state.contractVersion !== 1) throw new Error('Unsupported desktop protocol. Update the app.');
      setSnapshot(state); setAccount(account);
      setSelectedId(state.selectedServerId || state.connection.serverId || 'cz-1');
      bootReady.current = true;
      const params = new URLSearchParams(location.search);
      setScreen(params.get('auth') === '1' ? 'auth'
        : params.get('onboarding') === '1' ? 'onboarding'
        : !state.session.authenticated ? 'auth' : !state.session.onboardingComplete ? 'onboarding' : 'app');
    }).catch(error => { if (live) setBootError(errorMessage(error)); });
    return () => { live = false; bootReady.current = false; controller.abort(); };
  }, [container]);
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
    }, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [container, surface, snapshot?.session.authenticated]);
  async function connect(id = selectedId) {
    setPending(true);
    try {
      const result = await container.connection.connect(id);
      if (result.current) { setSnapshot(state => state && { ...state, connection: result.value }); setPending(false); }
    } catch (error) { setPending(false); notify(errorMessage(error)); }
  }
  async function disconnect() {
    setPending(true);
    try {
      const result = await container.connection.disconnect();
      if (result.current) { setSnapshot(state => state && { ...state, connection: result.value }); setPending(false); }
    } catch (error) { setPending(false); notify(errorMessage(error)); }
  }
  useEffect(() => {
    if (surface === 'main' && screen === 'app' && snapshot?.settings.autoConnect && !autoConnected.current) {
      autoConnected.current = true;
      void connect();
    }
  }, [screen, snapshot?.settings.autoConnect]);
  function selectServer(id: string) {
    if (!servers.some(s => s.id === id) || id === selectedId) return;
    setSelectedId(id);
    void container.desktop.selectLocation?.(id).catch(error => notify(errorMessage(error)));
    if (snapshot?.connection.status === 'connected' || pending) void connect(id);
  }
  function saveSettings(settings: Settings) {
    setSnapshot(state => state && { ...state, settings });
    void container.settings.save(settings).catch(async error => {
        try { const current = await container.desktop.bootstrap(); setSnapshot(state => state && { ...state, settings: current.settings }); } catch { /* Keep the last visible values; retry remains possible. */ }
        notify(errorMessage(error));
    });
  }
  function toggleSetting(key: BooleanSetting) { if (snapshot) saveSettings({ ...snapshot.settings, [key]: !snapshot.settings[key] }); }
  async function authenticate(operation: 'login' | 'register', email: string, password: string) {
    const session = await container.session[operation](email, password);
    setSnapshot(state => state && { ...state, session });
    setScreen('onboarding');
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
      if (session.revocationPending) notify('You are logged out locally. Stellar could not confirm server revocation; the remote session expires automatically.');
    } catch (error) { notify(errorMessage(error)); }
  }
  return { snapshot, account, screen, setScreen, view, setView, servers, selectedId,
    selected: servers.find(server => server.id === selectedId), pending, collapsed, setCollapsed,
    favoriteIds, toggleFavorite: (id: string) => setFavoriteIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]),
    dialog, setDialog, toast, notify, bootError, connect, disconnect, selectServer, saveSettings, toggleSetting,
    authenticate, finishOnboarding, logout, loadWorldMap: container.loadWorldMap,
    showMain: () => container.desktop.showMain?.(), showLocations: () => container.desktop.showLocations?.(), hideTray: () => container.desktop.hideTray?.(), quit: () => container.desktop.quit?.(),
    openExternal: (url: string) => { void container.desktop.openExternal(url).catch(error => notify(errorMessage(error))); } };
}
type AppState = ReturnType<typeof useAppState>;
const AppContext = createContext<AppState | null>(null);
export function AppProvider({ container, children, surface = 'main' }: { container: Container; children: ReactNode; surface?: 'main' | 'tray' }) {
  const state = useAppState(container, surface);
  return <AppContext.Provider value={state}>{children}</AppContext.Provider>;
}
export function useApp() {
  const state = useContext(AppContext);
  if (!state) throw new Error('AppProvider is missing');
  return state;
}
