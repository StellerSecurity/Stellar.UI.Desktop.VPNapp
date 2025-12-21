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

/**
 * Get bearer token from secure storage
 */
async function getBearerToken(): Promise<string | null> {
  // Check if running in Tauri
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      // Try to use Tauri's secure storage if available
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = new Store(".stellar-vpn.dat");
      const token = await store.get<string>("bearer_token");
      if (token) {
        return token;
      }
    } catch (error) {
      // If store plugin is not available or fails, use localStorage
      console.warn("Tauri store not available, using localStorage:", error);
    }
    // Fallback to localStorage if store import failed or plugin not available
    return localStorage.getItem("stellar_vpn_bearer_token");
  }

  // Web mode: use localStorage
  return localStorage.getItem("stellar_vpn_bearer_token");
}

/**
 * Get account number from secure storage
 */
export async function getAccountNumber(): Promise<string | null> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = new Store(".stellar-vpn.dat");
      return (await store.get<string>("account_number")) || null;
    } catch (error) {
      console.warn("Tauri store not available, using localStorage:", error);
    }
    return localStorage.getItem("stellar_vpn_account_number");
  }

  return localStorage.getItem("stellar_vpn_account_number");
}

/**
 * Store authentication data in secure storage
 */
export async function storeAuthData(
  token: string,
  deviceName: string,
  accountNumber?: string
): Promise<void> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      // Try to use Tauri's secure storage if available
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = new Store(".stellar-vpn.dat");
      await store.set("bearer_token", token);
      await store.set("device_name", deviceName);
      if (accountNumber) {
        await store.set("account_number", accountNumber);
      }
      await store.save();
      return;
    } catch (error) {
      // If store plugin is not available or fails, use localStorage
      console.warn("Tauri store not available, using localStorage:", error);
    }
    // Fallback to localStorage if store import failed or plugin not available
    localStorage.setItem("stellar_vpn_bearer_token", token);
    localStorage.setItem("stellar_vpn_device_name", deviceName);
    if (accountNumber) {
      localStorage.setItem("stellar_vpn_account_number", accountNumber);
    }
    return;
  }

  localStorage.setItem("stellar_vpn_bearer_token", token);
  localStorage.setItem("stellar_vpn_device_name", deviceName);
  if (accountNumber) {
    localStorage.setItem("stellar_vpn_account_number", accountNumber);
  }
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
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      // Try to use Tauri's secure storage if available
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = new Store(".stellar-vpn.dat");
      await store.delete("bearer_token");
      await store.delete("device_name");
      await store.delete("account_number");
      await store.save();
      return;
    } catch (error) {
      // If store plugin is not available or fails, use localStorage
      console.warn("Tauri store not available, using localStorage:", error);
    }
    // Fallback to localStorage if store import failed or plugin not available
    localStorage.removeItem("stellar_vpn_bearer_token");
    localStorage.removeItem("stellar_vpn_device_name");
    localStorage.removeItem("stellar_vpn_account_number");
    return;
  }

  localStorage.removeItem("stellar_vpn_bearer_token");
  localStorage.removeItem("stellar_vpn_device_name");
  localStorage.removeItem("stellar_vpn_account_number");
}

/**
 * Remove bearer token from storage (legacy function for backward compatibility)
 */
export async function clearBearerToken(): Promise<void> {
  await clearAuthData();
}

/**
 * Call the Home endpoint to get user and subscription status
 * @returns HomeResponse or null if request fails
 */
export async function fetchHomeData(): Promise<HomeResponse | null> {
  try {
    const token = await getBearerToken();

    if (!token) {
      console.error("No bearer token found in storage");
      return null;
    }

    const response = await fetch(`${API_BASE_URL}/dashboardcontroller/home`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired or invalid
        await clearAuthData();
        console.error("Authentication failed: token expired or invalid");
      } else {
        console.error(
          `Home API request failed: ${response.status} ${response.statusText}`
        );
      }
      return null;
    }

    const data: HomeResponse = await response.json();
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

    if (!response.ok) {
      console.error(`Login failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const data: AuthResponse = await response.json();
    if (data.response_code === 200) {
      return data;
    }

    return null;
  } catch (error) {
    console.error("Error during login:", error);
    return null;
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

    if (!response.ok) {
      console.error(
        `Registration failed: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data: AuthResponse = await response.json();
    if (data.response_code === 200) {
      return data;
    }

    return null;
  } catch (error) {
    console.error("Error during registration:", error);
    return null;
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

    if (!response.ok) {
      console.error(
        `Anonymous registration failed: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data: AuthResponse = await response.json();
    if (data.response_code === 200) {
      return data;
    }

    return null;
  } catch (error) {
    console.error("Error during anonymous registration:", error);
    return null;
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

    if (!response.ok) {
      console.error(
        `Account number login failed: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data: AuthResponse = await response.json();
    if (data.response_code === 200) {
      return data;
    }

    return null;
  } catch (error) {
    console.error("Error during account number login:", error);
    return null;
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
      // Handle non-JSON responses (gateway errors, outages)
      console.error("Failed to parse response as JSON:", parseError);
      return {
        response_code: 500,
        response_message: "Service unavailable, try again",
      };
    }

    // response_code is the source of truth, not HTTP status
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
