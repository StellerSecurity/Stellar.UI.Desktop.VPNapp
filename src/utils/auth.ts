/**
 * Authentication utilities
 * Handles setting bearer token and triggering subscription refresh after login/register
 */

import { storeAuthData, type AuthResponse } from "../services/api";

/**
 * Handle successful authentication
 * Stores the authentication data (token, device_name, account_number) and triggers subscription refresh
 *
 * @param authResponse - Authentication response from login/register API
 * @param onSuccess - Callback to execute after data is stored (e.g., navigate to dashboard)
 */
export async function handleAuthSuccess(
  authResponse: AuthResponse,
  onSuccess?: () => void
): Promise<void> {
  try {
    // Store authentication data in secure storage
    await storeAuthData(
      authResponse.token,
      authResponse.device_name,
      authResponse.vpn_auth,
      authResponse.account_number
    );

    // Trigger callback (e.g., navigate to dashboard)
    // The SubscriptionContext will automatically detect the token and start polling
    if (onSuccess) {
      onSuccess();
    }
  } catch (error) {
    console.error("Error storing authentication data:", error);
    throw error;
  }
}
