import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { handleAuthSuccess } from "../../utils/auth";
import { useSubscription } from "../../contexts/SubscriptionContext";
import { register, registerWithAccountNumber } from "../../services/api";

export const Register: React.FC = () => {
  const navigate = useNavigate();
  const { refreshSubscription, startPolling } = useSubscription();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleOneClickRegister = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const authResponse = await registerWithAccountNumber();

      if (!authResponse) {
        setError("Service unavailable. Please try again.");
        return;
      }

      // Check response code
      if (authResponse.response_code !== 200) {
        setError(
          authResponse.response_message ||
            "Registration failed. Please try again."
        );
        return;
      }

      // Store token and trigger subscription refresh
      await handleAuthSuccess(authResponse, async () => {
        // Immediately call Home endpoint after successful registration
        await refreshSubscription();
        // Start polling
        startPolling();
        // Navigate to dashboard with oneClick flag to show account number popup
        navigate("/dashboard?newUser=true&oneClick=true");
      });
    } catch (error) {
      console.error("One-click register error:", error);
      setError("An error occurred during registration. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const authResponse = await register(email, password);

      if (!authResponse) {
        setError("Service unavailable. Please try again.");
        return;
      }

      // Check response code
      if (authResponse.response_code !== 200) {
        setError(
          authResponse.response_message ||
            "Registration failed. Please check your information."
        );
        return;
      }

      // Store token and trigger subscription refresh
      await handleAuthSuccess(authResponse, async () => {
        // Immediately call Home endpoint after successful registration
        await refreshSubscription();
        // Start polling
        startPolling();
        // Navigate to dashboard without oneClick flag (no account number popup for email/password registration)
        navigate("/dashboard");
      });
    } catch (error) {
      console.error("Register error:", error);
      setError("An error occurred during registration. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Create an account"
      subtitle="Please enter email and password to create your free account."
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4" onSubmit={handleEmailRegister}>
        {error && (
          <div className="text-red-500 text-sm text-center">{error}</div>
        )}
        <Button
          type="button"
          fullWidth
          variant="outline"
          className="gap-2"
          onClick={handleOneClickRegister}
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="spinner spinner-outline"></span>
          ) : (
            <>
              <img src="/icons/light.svg" alt="Light" className="w-5 h-5" />
              <span>One-Click Register</span>
            </>
          )}
        </Button>

        <div className="my-1 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-sm text-textDark">Or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

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
        <Button type="submit" fullWidth disabled={isLoading}>
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="spinner"></span>
            </span>
          ) : (
            "Create Account"
          )}
        </Button>

        <p className="mt-3 text-center text-sm font-poppins font-normal">
          <span className="text-textDark">Already have an account? </span>
          <Link to="/login" className="font-medium text-[#2761FC]">
            Log in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};
