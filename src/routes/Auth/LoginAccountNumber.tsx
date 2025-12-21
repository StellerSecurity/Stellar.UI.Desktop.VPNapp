import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { handleAuthSuccess } from "../../utils/auth";
import { useSubscription } from "../../contexts/SubscriptionContext";
import { loginWithAccountNumber } from "../../services/api";

export const LoginAccountNumber: React.FC = () => {
  const navigate = useNavigate();
  const { refreshSubscription, startPolling } = useSubscription();
  const [isLoading, setIsLoading] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      // Remove spaces from account number for API call
      const cleanedAccountNumber = accountNumber.replace(/\s/g, "");

      const authResponse = await loginWithAccountNumber(cleanedAccountNumber);

      if (!authResponse) {
        setError("Login failed. Please check your account number.");
        return;
      }

      // Store token and trigger subscription refresh
      await handleAuthSuccess(authResponse, async () => {
        // Immediately call Home endpoint after successful login
        await refreshSubscription();
        // Start polling
        startPolling();
        // Navigate to dashboard
        navigate("/dashboard");
      });
    } catch (error) {
      console.error("Login error:", error);
      setError("An error occurred during login. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Log in by account number"
      subtitle="Use your Stellar VPN account number to log in"
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && (
          <div className="text-red-500 text-sm text-center">{error}</div>
        )}
        <TextInput
          label="Account number"
          placeholder="XXXX XXXX XXXX XXXX"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          required
        />
        <Button type="submit" fullWidth disabled={isLoading}>
          {isLoading ? "Logging in..." : "Log In"}
        </Button>
        <p className="text-center text-sm text-slate-500 mt-2">
          Or{" "}
          <Link to="/login" className="text-[#2761FC] font-semibold">
            log in with email
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};
