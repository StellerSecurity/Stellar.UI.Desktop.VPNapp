/**
 * API Service for Stellar VPN Desktop
 * Handles all API communication with the backend
 */

const API_BASE_URL =
    "https://stellaruidesktopvpnapiprod.azurewebsites.net/api/v1";

export enum SubscriptionStatus {
  INACTIVE = 0,
  ACTIVE = 1,
  TRIAL = 2,
}

export interface User {
  username: string;
}

export interface Subscription {
  id?: string; // Subscription ID
  expires_at: string; // e.g., "2025-12-18 00:29:06"
  status: SubscriptionStatus;
  days_remaining: number;
  expired: boolean;
}

export interface HomeResponse {
  user: User;
  subscription: Subscription;
}

// Authentication interfaces
export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface LoginWithAccountNumberRequest {
  account_number: string;
}

export interface AuthResponse {
  response_code: number;
  token: string;
  device_name: string;
  account_number?: string; // Only present for account number flows
  response_message?: string; // Error message if response_code !== 200
}

// Password Reset interfaces
export interface StellarResponse {
  response_code: number;
  response_message?: string;
  [k: string]: any;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface VerifyCodeRequest {
  email: string;
  confirmation_code: string;
}

export interface UpdatePasswordRequest {
  email: string;
  confirmation_code: string;
  new_password: string;
}

// Server List interfaces
export interface VpnServer {
  id: string;
  name: string; // e.g., "Switzerland – Zurich"
  country: string; // Country code e.g., "CH", "US"
  lat: number;
  lon: number;
  protocols: string[]; // e.g., ["udp", "tcp"]
  config_url: string; // URL to .ovpn config file
}

// ---------- Storage helpers (Tauri v2 Store plugin + web fallback) ----------

const STORE_FILE = ".stellar-vpn.dat";

const LS_KEYS = {
  bearerToken: "stellar_vpn_bearer_token",
  deviceName: "stellar_vpn_device_name",
  accountNumber: "stellar_vpn_account_number",
  autoConnect: "stellar_vpn_auto_connect",
} as const;

const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type KVStore = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  save(): Promise<void>;
};

let _storePromise: Promise<KVStore> | null = null;

async function getStore(): Promise<KVStore> {
  if (_storePromise) return _storePromise;

  _storePromise = (async () => {
    const mod = await import("@tauri-apps/plugin-store");
    const store = (await mod.load(STORE_FILE, { autoSave: false })) as KVStore;
    return store;
  })();

  return _storePromise;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ---------- Token / identity ----------

/**
 * Get bearer token from secure storage
 */
export async function getBearerToken(): Promise<string | null> {
  if (isTauri) {
    try {
      const store = await getStore();
      const token = await store.get<string>("bearer_token");
      if (token) return token;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }
    return lsGet(LS_KEYS.bearerToken);
  }

  return lsGet(LS_KEYS.bearerToken);
}

/**
 * Get account number from secure storage
 */
export async function getAccountNumber(): Promise<string | null> {
  if (isTauri) {
    try {
      const store = await getStore();
      return (await store.get<string>("account_number")) || null;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }
    return lsGet(LS_KEYS.accountNumber);
  }

  return lsGet(LS_KEYS.accountNumber);
}

/**
 * Get device name from secure storage
 */
export async function getDeviceName(): Promise<string | null> {
  if (isTauri) {
    try {
      const store = await getStore();
      return (await store.get<string>("device_name")) || null;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }
    return lsGet(LS_KEYS.deviceName);
  }

  return lsGet(LS_KEYS.deviceName);
}

/**
 * Store authentication data in secure storage
 */
export async function storeAuthData(
    token: string,
    deviceName: string,
    accountNumber?: string
): Promise<void> {
  if (isTauri) {
    try {
      const store = await getStore();
      await store.set("bearer_token", token);
      await store.set("device_name", deviceName);
      if (accountNumber) {
        await store.set("account_number", accountNumber);
      }
      await store.save();
      return;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }

    lsSet(LS_KEYS.bearerToken, token);
    lsSet(LS_KEYS.deviceName, deviceName);
    if (accountNumber) lsSet(LS_KEYS.accountNumber, accountNumber);
    return;
  }

  lsSet(LS_KEYS.bearerToken, token);
  lsSet(LS_KEYS.deviceName, deviceName);
  if (accountNumber) lsSet(LS_KEYS.accountNumber, accountNumber);
}

/**
 * Store bearer token in secure storage (legacy function for backward compatibility)
 */
export async function setBearerToken(token: string): Promise<void> {
  await storeAuthData(token, "");
}

/**
 * Clear all authentication data from storage
 */
export async function clearAuthData(): Promise<void> {
  if (isTauri) {
    try {
      const store = await getStore();
      await store.delete("bearer_token");
      await store.delete("device_name");
      await store.delete("account_number");
      await store.save();
      return;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }

    lsRemove(LS_KEYS.bearerToken);
    lsRemove(LS_KEYS.deviceName);
    lsRemove(LS_KEYS.accountNumber);
    return;
  }

  lsRemove(LS_KEYS.bearerToken);
  lsRemove(LS_KEYS.deviceName);
  lsRemove(LS_KEYS.accountNumber);
}

/**
 * Remove bearer token from storage (legacy function for backward compatibility)
 */
export async function clearBearerToken(): Promise<void> {
  await clearAuthData();
}

// ---------- VPN preferences ----------

/**
 * Store selected VPN server location
 */
export type SelectedServer = {
  name: string;
  configUrl: string;
  countryCode?: string | null; // lowercase, e.g. "ch"
};

const LS_SELECTED_SERVER = "stellar_vpn_selected_server_v1";

// Backward-compat legacy keys (if you ever stored them)
const LS_LEGACY_SERVER_NAME = "stellar_vpn_selected_server_name";
const LS_LEGACY_SERVER_CFG = "stellar_vpn_selected_server_config_url";

function normalizeCountryCode(cc?: string | null): string | null {
  const raw = (cc || "").trim().toLowerCase();
  return raw ? raw : null;
}

export async function setSelectedServer(
    name: string,
    configUrl: string,
    countryCode?: string | null
): Promise<void> {
  const payload: SelectedServer = {
    name,
    configUrl,
    countryCode: normalizeCountryCode(countryCode),
  };

  // Prefer Tauri store when possible
  if (isTauri) {
    try {
      const store = await getStore();
      await store.set("selected_server", payload);
      await store.save();

      // Same-tab refresh trigger
      window.dispatchEvent(new Event("stellar:selected-server"));
      return;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }
  }

  // localStorage fallback
  try {
    window.localStorage.setItem(LS_SELECTED_SERVER, JSON.stringify(payload));

    // Also write legacy fields to avoid breaking old reads elsewhere
    window.localStorage.setItem(LS_LEGACY_SERVER_NAME, name);
    window.localStorage.setItem(LS_LEGACY_SERVER_CFG, configUrl);

    window.dispatchEvent(new Event("stellar:selected-server"));
  } catch {
    // ignore
  }
}

export async function getSelectedServer(): Promise<SelectedServer | null> {
  // 1) Try Tauri store first
  if (isTauri) {
    try {
      const store = await getStore();
      const obj = await store.get<any>("selected_server");
      if (obj && typeof obj === "object") {
        const name = typeof obj.name === "string" ? obj.name : "";
        const configUrl =
            typeof obj.configUrl === "string"
                ? obj.configUrl
                : typeof obj.config_url === "string"
                    ? obj.config_url
                    : "";

        const countryCode =
            typeof obj.countryCode === "string"
                ? obj.countryCode
                : typeof obj.country_code === "string"
                    ? obj.country_code
                    : null;

        if (name && configUrl) {
          return {
            name,
            configUrl,
            countryCode: normalizeCountryCode(countryCode),
          };
        }
      }
    } catch (error) {
      console.warn("Tauri store read failed, using localStorage:", error);
    }
  }

  // 2) localStorage current key
  try {
    const raw = window.localStorage.getItem(LS_SELECTED_SERVER);
    if (raw) {
      const obj = JSON.parse(raw) as any;

      const name = typeof obj?.name === "string" ? obj.name : "";
      const configUrl =
          typeof obj?.configUrl === "string"
              ? obj.configUrl
              : typeof obj?.config_url === "string"
                  ? obj.config_url
                  : "";

      const countryCode =
          typeof obj?.countryCode === "string"
              ? obj.countryCode
              : typeof obj?.country_code === "string"
                  ? obj.country_code
                  : null;

      if (name && configUrl) {
        return {
          name,
          configUrl,
          countryCode: normalizeCountryCode(countryCode),
        };
      }
    }
  } catch {
    // ignore
  }

  // 3) Legacy fallback (name+config separate keys)
  const legacyName = lsGet(LS_LEGACY_SERVER_NAME);
  const legacyCfg = lsGet(LS_LEGACY_SERVER_CFG);
  if (legacyName && legacyCfg) {
    return {
      name: legacyName,
      configUrl: legacyCfg,
      countryCode: null,
    };
  }

  return null;
}

// ---------- Auto connect preference ----------

/**
 * Get auto connect preference from storage
 */
export async function getAutoConnect(): Promise<boolean> {
  if (isTauri) {
    try {
      const store = await getStore();
      const autoConnect = await store.get<boolean>("auto_connect");
      return autoConnect ?? false;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }

    return lsGet(LS_KEYS.autoConnect) === "true";
  }

  return lsGet(LS_KEYS.autoConnect) === "true";
}

/**
 * Set auto connect preference in storage
 */
export async function setAutoConnect(enabled: boolean): Promise<void> {
  if (isTauri) {
    try {
      const store = await getStore();
      await store.set("auto_connect", enabled);
      await store.save();
      return;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }

    lsSet(LS_KEYS.autoConnect, enabled.toString());
    return;
  }

  lsSet(LS_KEYS.autoConnect, enabled.toString());
}

// ---------- API calls ----------

/**
 * Call the Home endpoint to get user and subscription status
 * @returns HomeResponse or null if request fails
 */
export async function fetchHomeData(): Promise<HomeResponse | null> {
  console.log('Getting home data');
  try {
    const token = await getBearerToken();

    if (!token) {
      console.error("No bearer token found in storage");
      return null;
    }

    const response = await fetch(`${API_BASE_URL}/dashboardcontroller/home`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    let data: HomeResponse;
    try {
      data = await response.json();
      console.log('Home data', data);
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      if (response.status === 401) {
        await clearAuthData();
        console.error("Authentication failed: token expired or invalid");
      }
      return null;
    }

    if (response.status === 401 || (data as any).response_code === 401) {
      await clearAuthData();
      console.error("Authentication failed: token expired or invalid");
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error fetching home data:", error);
    return null;
  }
}

/**
 * Login with email and password
 */
export async function login(
    username: string,
    password: string
): Promise<AuthResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/logincontroller/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    let data: AuthResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      } as AuthResponse;
    }

    return data;
  } catch (error) {
    console.error("Error during login:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    } as AuthResponse;
  }
}

/**
 * Register with email and password
 */
export async function register(
    username: string,
    password: string
): Promise<AuthResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/logincontroller/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    let data: AuthResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      } as AuthResponse;
    }

    return data;
  } catch (error) {
    console.error("Error during registration:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    } as AuthResponse;
  }
}

/**
 * Anonymous account registration (one-click register)
 */
export async function registerWithAccountNumber(): Promise<AuthResponse | null> {
  try {
    const response = await fetch(
        `${API_BASE_URL}/logincontroller/register/withaccountnumber`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
    );

    let data: AuthResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      } as AuthResponse;
    }

    return data;
  } catch (error) {
    console.error("Error during anonymous registration:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    } as AuthResponse;
  }
}

/**
 * Login with account number
 */
export async function loginWithAccountNumber(
    accountNumber: string
): Promise<AuthResponse | null> {
  try {
    const response = await fetch(
        `${API_BASE_URL}/logincontroller/login/withaccountnumber`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ account_number: accountNumber }),
        }
    );

    let data: AuthResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      } as AuthResponse;
    }

    return data;
  } catch (error) {
    console.error("Error during account number login:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    } as AuthResponse;
  }
}

/**
 * Send password reset code to email
 */
export async function sendPasswordResetCode(
    email: string
): Promise<StellarResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/password/forgot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

    let data: StellarResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      };
    }

    return data;
  } catch (error) {
    console.error("Error sending password reset code:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    };
  }
}

/**
 * Verify password reset code
 */
export async function verifyPasswordResetCode(
    email: string,
    confirmationCode: string
): Promise<StellarResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/password/verifycode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        confirmation_code: confirmationCode,
      }),
    });

    let data: StellarResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      };
    }

    return data;
  } catch (error) {
    console.error("Error verifying password reset code:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    };
  }
}

/**
 * Update password with reset code
 */
export async function updatePasswordWithResetCode(
    email: string,
    confirmationCode: string,
    newPassword: string
): Promise<StellarResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/password/updatepassword`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        confirmation_code: confirmationCode,
        new_password: newPassword,
      }),
    });

    let data: StellarResponse;
    try {
      data = await response.json();
    } catch (parseError) {
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      };
    }

    // Clear password from memory after request
    newPassword = "";

    return data;
  } catch (error) {
    console.error("Error updating password:", error);
    return {
      response_code: 500,
      response_message: "Service unavailable, try again",
    };
  }
}

// Cache for server list to avoid repeated API calls
let serverListCache: VpnServer[] | null = null;
let serverListCacheTime: number = 0;
const SERVER_LIST_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch VPN server list (with caching)
 * @param forceRefresh - If true, bypass cache and fetch fresh data
 * @returns Array of VPN servers or null if request fails
 */
export async function fetchServerList(
    forceRefresh: boolean = false
): Promise<VpnServer[] | null> {
  const now = Date.now();
  if (
      !forceRefresh &&
      serverListCache &&
      now - serverListCacheTime < SERVER_LIST_CACHE_DURATION
  ) {
    return serverListCache;
  }

  try {
    const token = await getBearerToken();

    if (!token) {
      console.error("No bearer token found in storage");
      return null;
    }

    const response = await fetch(`${API_BASE_URL}/vpncontroller/server-list`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        await clearAuthData();
        console.error("Authentication failed: token expired or invalid");
      } else {
        console.error(
            `Server list API request failed: ${response.status} ${response.statusText}`
        );
      }
      return null;
    }

    const data: VpnServer[] = await response.json();

    serverListCache = data;
    serverListCacheTime = Date.now();

    return data;
  } catch (error) {
    console.error("Error fetching server list:", error);
    return null;
  }
}
