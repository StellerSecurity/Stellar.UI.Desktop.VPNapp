import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  ReactNode,
  useCallback,
} from "react";
import { useLocation } from "react-router-dom";
import {
  fetchHomeData,
  type HomeResponse,
  type Subscription,
  type User,
  getBearerToken,
} from "../services/api";
import { maybeNotifySubscriptionReminder } from "../lib/subscriptionNotifications";

interface SubscriptionContextType {
  user: User | null;
  subscription: Subscription | null;
  isLoading: boolean;
  error: string | null;
  refreshSubscription: () => Promise<void>;
  startPolling: () => void;
}

const SubscriptionContext = createContext<SubscriptionContextType | undefined>(
    undefined
);

const HOME_CACHE_KEY = "stellar_vpn_home_cache_v1";
const HOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FOREGROUND_REFRESH_COOLDOWN_MS = 3000;

type HomeCachePayload = {
  v: 1;
  ts: number;
  data: HomeResponse;
};

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

function readHomeCache(): HomeResponse | null {
  try {
    const raw = window.localStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as HomeCachePayload;
    if (!parsed || parsed.v !== 1 || !parsed.ts || !parsed.data) return null;

    const age = Date.now() - parsed.ts;
    if (age > HOME_CACHE_TTL_MS) return null;

    return parsed.data;
  } catch {
    return null;
  }
}

function writeHomeCache(data: HomeResponse) {
  try {
    const payload: HomeCachePayload = { v: 1, ts: Date.now(), data };
    window.localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export const SubscriptionProvider: React.FC<{ children: ReactNode }> = ({
                                                                          children,
                                                                        }) => {
  const location = useLocation();

  const [user, setUser] = useState<User | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPollingRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const lastForegroundRefreshAtRef = useRef(0);

  const refreshSubscription = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      debugLog("[subscription] refreshSubscription started");

      const data = await fetchHomeData();
      debugLog("[subscription] fetchHomeData result:", data);

      if (data) {
        setUser(data.user);
        setSubscription(data.subscription);
        writeHomeCache(data);

        debugLog(
            "[subscription] calling maybeNotifySubscriptionReminder with:",
            data.subscription
        );

        maybeNotifySubscriptionReminder(data.subscription).catch((err) => {
          console.error("[subscription] reminder notification failed:", err);
          pushDashboardDebugLog(
              `[subscription] reminder notification failed: ${
                  err instanceof Error ? err.message : String(err)
              }`
          );
        });
      } else {
        setError("Failed to fetch subscription data");
        pushDashboardDebugLog("[subscription] fetchHomeData returned null");
      }
    } catch (err) {
      const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMessage);
      console.error("Error refreshing subscription:", err);
      pushDashboardDebugLog(
          `[subscription] refreshSubscription failed: ${errorMessage}`
      );
    } finally {
      setIsLoading(false);
      refreshInFlightRef.current = false;
      pushDashboardDebugLog("[subscription] refreshSubscription finished");
    }
  }, []);

  const startPolling = useCallback(() => {
    if (isPollingRef.current) return;

    isPollingRef.current = true;
    pushDashboardDebugLog("[subscription] polling started");

    const poll = async () => {
      await refreshSubscription();
      const interval = 10 * 60 * 1000;
      pollingTimeoutRef.current = setTimeout(poll, interval);
    };

    poll();
  }, [refreshSubscription]);

  const stopPolling = useCallback(() => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    isPollingRef.current = false;
    pushDashboardDebugLog("[subscription] polling stopped");
  }, []);

  const triggerForegroundRefresh = useCallback(() => {
    if (!tokenRef.current) return;

    const now = Date.now();
    if (
        now - lastForegroundRefreshAtRef.current <
        FOREGROUND_REFRESH_COOLDOWN_MS
    ) {
      return;
    }

    lastForegroundRefreshAtRef.current = now;
    pushDashboardDebugLog("[subscription] foreground refresh triggered");
    void refreshSubscription();
  }, [refreshSubscription]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const token = await getBearerToken();
      if (!mounted) return;

      tokenRef.current = token || null;

      if (!token) {
        pushDashboardDebugLog("[subscription] no bearer token");
        return;
      }

      const cached = readHomeCache();
      if (cached) {
        setUser(cached.user);
        setSubscription(cached.subscription);
        pushDashboardDebugLog("[subscription] restored cached home data");
      }

      startPolling();
    })();

    return () => {
      mounted = false;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  useEffect(() => {
    if (location.pathname !== "/dashboard") return;
    if (!tokenRef.current) return;

    pushDashboardDebugLog("[subscription] dashboard entered");

    if (!isPollingRef.current) {
      startPolling();
      return;
    }

    void refreshSubscription();
  }, [location.key, location.pathname, refreshSubscription, startPolling]);

  useEffect(() => {
    const onFocus = () => {
      triggerForegroundRefresh();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerForegroundRefresh();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [triggerForegroundRefresh]);

  return (
      <SubscriptionContext.Provider
          value={{
            user,
            subscription,
            isLoading,
            error,
            refreshSubscription,
            startPolling,
          }}
      >
        {children}
      </SubscriptionContext.Provider>
  );
};

export const useSubscription = () => {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error("useSubscription must be used within SubscriptionProvider");
  }
  return context;
};