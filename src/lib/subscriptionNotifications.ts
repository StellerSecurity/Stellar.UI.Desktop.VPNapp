import { sendNotification } from "@tauri-apps/plugin-notification";
import type { Subscription } from "../services/api";
import {
    ensureVpnNotificationPermission,
    getVpnNotificationsEnabled,
} from "./vpnNotifications";

type ReminderStage = "7d" | "3d" | "1d" | "expired";

const STORAGE_PREFIX = "stellar.subscription.reminder";

function pushDashboardDebugLog(line: string) {
    if (typeof window === "undefined") return;

    try {
        window.dispatchEvent(
            new CustomEvent("stellar-debug-log", {
                detail: line,
            })
        );
    } catch {
        // ignore
    }
}

function debugLog(...parts: unknown[]) {
    console.log(...parts);

    const line = parts
        .map((part) => {
            if (typeof part === "string") return part;
            try {
                return JSON.stringify(part);
            } catch {
                return String(part);
            }
        })
        .join(" ");

    pushDashboardDebugLog(line);
}

function isTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getDaysRemaining(subscription: Subscription | null): number | null {
    const raw = (subscription as any)?.days_remaining;

    if (raw === null || raw === undefined || raw === "") {
        return null;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

function getCycleKey(subscription: Subscription | null): string | null {
    const expiresAt =
        typeof subscription?.expires_at === "string"
            ? subscription.expires_at.trim()
            : "";

    if (expiresAt) {
        return expiresAt;
    }

    const daysRemaining = getDaysRemaining(subscription);
    if (daysRemaining === null) {
        return null;
    }

    return `days:${daysRemaining}`;
}

function getReminderStage(
    subscription: Subscription | null
): ReminderStage | null {
    if (!subscription) return null;

    const daysRemaining = getDaysRemaining(subscription);
    const isExpired =
        (subscription as any)?.expired === true || (daysRemaining ?? 1) <= 0;

    if (isExpired) return "expired";
    if (daysRemaining === null) return null;
    if (daysRemaining <= 1) return "1d";
    if (daysRemaining <= 3) return "3d";
    if (daysRemaining <= 7) return "7d";

    return null;
}

function getStorageKey(cycleKey: string, stage: ReminderStage): string {
    return `${STORAGE_PREFIX}:${cycleKey}:${stage}`;
}

function wasReminderShown(cycleKey: string, stage: ReminderStage): boolean {
    try {
        return localStorage.getItem(getStorageKey(cycleKey, stage)) === "1";
    } catch {
        return false;
    }
}

function markReminderShown(cycleKey: string, stage: ReminderStage): void {
    try {
        localStorage.setItem(getStorageKey(cycleKey, stage), "1");
    } catch {
        // ignore
    }
}

function buildReminder(stage: ReminderStage): { title: string; body: string } {
    switch (stage) {
        case "7d":
            return {
                title: "Stellar VPN",
                body: "Your subscription expires in 7 days.",
            };
        case "3d":
            return {
                title: "Stellar VPN",
                body: "Your subscription expires in 3 days.",
            };
        case "1d":
            return {
                title: "Stellar VPN",
                body: "Your subscription expires tomorrow.",
            };
        case "expired":
            return {
                title: "Stellar VPN",
                body: "Your subscription has expired. Renew to keep using Stellar VPN.",
            };
    }
}

export async function maybeNotifySubscriptionReminder(
    subscription: Subscription | null
): Promise<void> {
    debugLog("[subscriptionNotifications] called", subscription);

    if (!isTauri()) {
        debugLog("[subscriptionNotifications] skip: not tauri");
        return;
    }

    if (!subscription) {
        debugLog("[subscriptionNotifications] skip: no subscription");
        return;
    }

    const enabled = getVpnNotificationsEnabled();
    debugLog("[subscriptionNotifications] notifications enabled =", enabled);

    if (!enabled) {
        debugLog("[subscriptionNotifications] skip: notifications disabled");
        return;
    }

    const cycleKey = getCycleKey(subscription);
    const stage = getReminderStage(subscription);

    debugLog("[subscriptionNotifications] cycleKey =", cycleKey);
    debugLog("[subscriptionNotifications] stage =", stage);

    if (!cycleKey || !stage) {
        debugLog("[subscriptionNotifications] skip: no cycleKey or stage");
        return;
    }

    const alreadyShown = wasReminderShown(cycleKey, stage);
    debugLog("[subscriptionNotifications] alreadyShown =", alreadyShown);

    if (alreadyShown) {
        debugLog("[subscriptionNotifications] skip: already shown");
        return;
    }

    const granted = await ensureVpnNotificationPermission();
    debugLog("[subscriptionNotifications] permission granted =", granted);

    if (!granted) {
        debugLog("[subscriptionNotifications] skip: permission not granted");
        return;
    }

    const { title, body } = buildReminder(stage);
    debugLog("[subscriptionNotifications] sending notification", {
        title,
        body,
    });

    try {
        await sendNotification({ title, body });
        markReminderShown(cycleKey, stage);
        debugLog(
            "[subscriptionNotifications] notification sent and marked shown"
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[subscriptionNotifications] sendNotification failed:", err);
        pushDashboardDebugLog(
            `[subscriptionNotifications] sendNotification failed: ${message}`
        );
    }
}