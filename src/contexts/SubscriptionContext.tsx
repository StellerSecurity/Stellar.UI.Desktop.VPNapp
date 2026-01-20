import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  fetchHomeData,
  type HomeResponse,
  type Subscription,
  type User,
  getBearerToken,
} from "../services/api";

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

// Cache key (not secrets, just UI state)
const HOME_CACHE_KEY = "stellar_vpn_home_cache_v1";

// How long we allow showing cached data while offline/booting.
// We still revalidate in the background immediately.
const HOME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type HomeCachePayload = {
  v: 1;
  ts: number;
  data: HomeResponse;
};

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

  // Track if we have a token (so we don't refresh while logged out)
  const tokenRef = useRef<string | null>(null);

  // Prevent overlapping refresh calls (React StrictMode + fast navigation)
  const refreshInFlightRef = useRef(false);

  const refreshSubscription = async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchHomeData();

      if (data) {
        setUser(data.user);
        setSubscription(data.subscription);
        writeHomeCache(data);
      } else {
        setError("Failed to fetch subscription data");
        // Keep existing cached state if API fails (stale is better than blank)
      }
    } catch (err) {
      const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMessage);
      console.error("Error refreshing subscription:", err);
    } finally {
      setIsLoading(false);
      refreshInFlightRef.current = false;
    }
  };

  const startPolling = () => {
    if (isPollingRef.current) return;

    isPollingRef.current = true;

    const poll = async () => {
      await refreshSubscription();

      // Poll every 10 minutes
      const interval = 10 * 60 * 1000;

      pollingTimeoutRef.current = setTimeout(poll, interval);
    };

    // Immediate refresh on start
    poll();
  };

  const stopPolling = () => {
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    isPollingRef.current = false;
  };

  useEffect(() => {
    let mounted = true;

    (async () => {
      // IMPORTANT: In Tauri, the token might live in the Tauri Store, not localStorage.
      const token = await getBearerToken();
      if (!mounted) return;

      tokenRef.current = token || null;

      if (!token) {
        // Not logged in -> don't show cached data
        return;
      }

      // Load cached data instantly for UX
      const cached = readHomeCache();
      if (cached) {
        setUser(cached.user);
        setSubscription(cached.subscription);
      }

      // Then revalidate in background + start polling
      startPolling();
    })();

    return () => {
      mounted = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh every time user navigates INTO /dashboard
  useEffect(() => {
    if (location.pathname !== "/dashboard") return;
    if (!tokenRef.current) return;

    // If polling somehow isn't running yet, start it (also refreshes immediately)
    if (!isPollingRef.current) {
      startPolling();
      return;
    }

    // Otherwise just refresh once on dashboard entry
    void refreshSubscription();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.pathname]);

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
