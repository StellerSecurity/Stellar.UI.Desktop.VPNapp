import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { handleAuthSuccess } from "../../utils/auth";
import { useSubscription } from "../../contexts/SubscriptionContext";
import { login } from "../../services/api";

export const LoginEmail: React.FC = () => {
  const navigate = useNavigate();
  const { refreshSubscription, startPolling } = useSubscription();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const authResponse = await login(email, password);

      if (!authResponse) {
        setError("Service unavailable. Please try again.");
        return;
      }

      // Check response code
      if (authResponse.response_code !== 200) {
        setError(
          authResponse.response_message ||
            "Login failed. Please check your credentials."
        );
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
      title="Log In"
      subtitle="Please enter your email and password"
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && (
          <div className="text-red-500 text-sm text-center">{error}</div>
        )}
        <TextInput
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextInput
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => navigate("/forgot-password")}
            className="text-xs font-poppins font-semibold text-[#2761FC]"
          >
            Forgot Password?
          </button>
        </div>
        <Button type="submit" fullWidth disabled={isLoading}>
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="spinner"></span>
            </span>
          ) : (
            "Log In"
          )}
        </Button>
        <p className="mt-3 text-center text-sm font-poppins font-normal">
          <span className="text-[#0B0C19]">Don&apos;t have an account? </span>
          <Link to="/register" className="font-semibold text-[#2761FC]">
            Create an Account
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};
