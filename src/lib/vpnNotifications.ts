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

const NOTICE_COOLDOWN_MS = 5000;

function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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

    sendNotification({ title, body });
}

export async function handleVpnLogNotification(line: string): Promise<void> {
    const now = Date.now();

    if (line.includes('[ui] Stellar VPN is rebuilding the connection on the current network.')) {
        reconnectFlowActive = true;

        if (now - lastReconnectNoticeAt > NOTICE_COOLDOWN_MS) {
            lastReconnectNoticeAt = now;
            await notify(
                'Stellar VPN lost connection',
                'Reconnecting in the background...'
            );
        }

        return;
    }

    if (
        reconnectFlowActive &&
        (
            line.includes('[ui] Automatic reconnect failed:') ||
            line.includes('[ui] Base network did not come back in time.')
        )
    ) {
        reconnectFlowActive = false;

        if (now - lastFailureNoticeAt > NOTICE_COOLDOWN_MS) {
            lastFailureNoticeAt = now;
            await notify(
                'Stellar VPN could not reconnect',
                'Open Stellar VPN to retry.'
            );
        }
    }
}

export async function handleVpnStatusNotification(status: string): Promise<void> {
    const now = Date.now();

    if (reconnectFlowActive && status === 'connected') {
        reconnectFlowActive = false;

        if (now - lastSuccessNoticeAt > NOTICE_COOLDOWN_MS) {
            lastSuccessNoticeAt = now;
            await notify(
                'Stellar VPN is connected again',
                'Your VPN tunnel has been restored.'
            );
        }

        return;
    }

    if (reconnectFlowActive && status.startsWith('error:')) {
        reconnectFlowActive = false;

        if (now - lastFailureNoticeAt > NOTICE_COOLDOWN_MS) {
            lastFailureNoticeAt = now;
            await notify(
                'Stellar VPN could not reconnect',
                'Open Stellar VPN to retry.'
            );
        }
    }
}