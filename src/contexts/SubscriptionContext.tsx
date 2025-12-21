import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import {
  fetchHomeData,
  SubscriptionStatus,
  type HomeResponse,
  type Subscription,
  type User,
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

export const SubscriptionProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);

  /**
   * Fetch subscription data from API
   */
  const refreshSubscription = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchHomeData();

      if (data) {
        setUser(data.user);
        setSubscription(data.subscription);
      } else {
        setError("Failed to fetch subscription data");
        // Don't clear existing data on temporary failures
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMessage);
      console.error("Error refreshing subscription:", err);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Start polling with randomized interval (15-20 minutes)
   */
  const startPolling = () => {
    if (isPollingRef.current) {
      return; // Already polling
    }

    isPollingRef.current = true;

    const poll = async () => {
      await refreshSubscription();

      // Randomize interval between 15-20 minutes (900000-1200000 ms)
      const minInterval = 15 * 60 * 1000; // 15 minutes
      const maxInterval = 20 * 60 * 1000; // 20 minutes
      const randomInterval =
        Math.floor(Math.random() * (maxInterval - minInterval + 1)) +
        minInterval;

      pollingIntervalRef.current = setTimeout(poll, randomInterval);
    };

    // Initial call
    poll();
  };

  /**
   * Stop polling
   */
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearTimeout(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    isPollingRef.current = false;
  };

  /**
   * Check if user is authenticated (has bearer token)
   */
  const isAuthenticated = () => {
    return (
      typeof window !== "undefined" &&
      localStorage.getItem("stellar_vpn_bearer_token") !== null
    );
  };

  // Start polling when component mounts if authenticated
  useEffect(() => {
    if (isAuthenticated()) {
      // Initial fetch
      refreshSubscription();
      // Start polling
      startPolling();
    }

    return () => {
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
