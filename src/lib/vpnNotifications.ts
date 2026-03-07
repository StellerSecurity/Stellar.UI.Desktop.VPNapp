import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

const KEY = 'stellar.notifications.enabled';

let reconnectFlowActive = false;
let lastReconnectNoticeAt = 0;
let lastFailureNoticeAt = 0;
let lastSuccessNoticeAt = 0;
let lastVpnStatus: string | null = null;

const NOTICE_COOLDOWN_MS = 5000;
const RECONNECT_FAILURE_TIMEOUT_MS = 95000;
const MANUAL_SUPPRESS_MS = 4000;

let reconnectFailureTimer: ReturnType<typeof setTimeout> | null = null;
let suppressReconnectUntil = 0;

function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function clearReconnectFailureTimer(): void {
    if (reconnectFailureTimer) {
        clearTimeout(reconnectFailureTimer);
        reconnectFailureTimer = null;
    }
}

function scheduleReconnectFailureTimeout(): void {
    clearReconnectFailureTimer();

    reconnectFailureTimer = setTimeout(() => {
        if (!reconnectFlowActive) {
            return;
        }

        reconnectFlowActive = false;

        const now = Date.now();
        if (now - lastFailureNoticeAt > NOTICE_COOLDOWN_MS) {
            lastFailureNoticeAt = now;
            void notify(
                'Stellar VPN could not reconnect',
                'Open Stellar VPN to retry.'
            );
        }
    }, RECONNECT_FAILURE_TIMEOUT_MS);
}

async function notify(title: string, body: string): Promise<void> {
    if (!isTauri()) {
        return;
    }

    if (!getVpnNotificationsEnabled()) {
        return;
    }

    const granted = await ensureVpnNotificationPermission();
    if (!granted) {
        return;
    }

    await sendNotification({ title, body });
}

async function startReconnectFlow(): Promise<void> {
    const now = Date.now();

    reconnectFlowActive = true;
    scheduleReconnectFailureTimeout();

    if (now - lastReconnectNoticeAt > NOTICE_COOLDOWN_MS) {
        lastReconnectNoticeAt = now;
        await notify(
            'Stellar VPN lost connection',
            'Reconnecting in the background...'
        );
    }
}

async function finishReconnectSuccess(): Promise<void> {
    const now = Date.now();

    reconnectFlowActive = false;
    clearReconnectFailureTimer();

    if (now - lastSuccessNoticeAt > NOTICE_COOLDOWN_MS) {
        lastSuccessNoticeAt = now;
        await notify(
            'Stellar VPN is connected again',
            'Your VPN tunnel has been restored.'
        );
    }
}

async function finishReconnectFailure(): Promise<void> {
    const now = Date.now();

    reconnectFlowActive = false;
    clearReconnectFailureTimer();

    if (now - lastFailureNoticeAt > NOTICE_COOLDOWN_MS) {
        lastFailureNoticeAt = now;
        await notify(
            'Stellar VPN could not reconnect',
            'Open Stellar VPN to retry.'
        );
    }
}

export function getVpnNotificationsEnabled(): boolean {
    const raw = localStorage.getItem(KEY);
    if (raw === null) {
        return true;
    }
    return raw === 'true';
}

export function setVpnNotificationsEnabled(value: boolean): void {
    localStorage.setItem(KEY, value ? 'true' : 'false');
}

export async function ensureVpnNotificationPermission(): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    let granted = await isPermissionGranted();

    if (!granted) {
        const permission = await requestPermission();
        granted = permission === 'granted';
    }

    return granted;
}

/**
 * Call this before a user-initiated disconnect/reconnect
 * so we do not show “lost connection” notifications.
 */
export function markManualVpnDisconnect(): void {
    suppressReconnectUntil = Date.now() + MANUAL_SUPPRESS_MS;
    reconnectFlowActive = false;
    clearReconnectFailureTimer();
}

export async function handleVpnLogNotification(line: string): Promise<void> {
    if (!line) {
        return;
    }

    if (line.includes('[ui] Stellar VPN is rebuilding the connection on the current network.')) {
        await startReconnectFlow();
        return;
    }

    if (
        reconnectFlowActive &&
        (
            line.includes('[ui] Automatic reconnect failed:') ||
            line.includes('[ui] Base network did not come back in time.')
        )
    ) {
        await finishReconnectFailure();
    }
}

export async function handleVpnStatusNotification(status: string): Promise<void> {
    const previousStatus = lastVpnStatus;
    lastVpnStatus = status;

    const now = Date.now();
    const reconnectSuppressed = now < suppressReconnectUntil;

    if (
        !reconnectSuppressed &&
        previousStatus === 'connected' &&
        (status === 'disconnected' || status === 'connecting')
    ) {
        await startReconnectFlow();
        return;
    }

    if (reconnectFlowActive && status === 'connected') {
        await finishReconnectSuccess();
        return;
    }

    if (reconnectFlowActive && status.startsWith('error:')) {
        await finishReconnectFailure();
        return;
    }
}