import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { sendPasswordResetCode } from "../../services/api";

export const ForgotPassword: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = useState<number | null>(null);

  // Handle rate limiting countdown
  React.useEffect(() => {
    if (rateLimitSeconds !== null && rateLimitSeconds > 0) {
      const timer = setTimeout(() => {
        setRateLimitSeconds(rateLimitSeconds - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (rateLimitSeconds === 0) {
      setRateLimitSeconds(null);
    }
  }, [rateLimitSeconds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const response = await sendPasswordResetCode(email);

      if (!response) {
        setError("Service unavailable. Please try again.");
        return;
      }

      // Handle response codes
      if (response.response_code === 200) {
        // Store email for next steps
        localStorage.setItem("password_reset_email", email);
        navigate("/password-otp");
      } else if (response.response_code === 400) {
        setError(response.response_message || "Invalid email address.");
      } else if (response.response_code === 404) {
        setError("User not found. Please check your email address.");
      } else if (response.response_code === 429) {
        // Extract wait time from response message if available
        const message = response.response_message || "";
        const secondsMatch = message.match(/(\d+)/);
        const waitSeconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 60;
        setRateLimitSeconds(waitSeconds);
        setError(
          `Too many attempts. Please wait ${waitSeconds} seconds before trying again.`
        );
      } else {
        setError(
          response.response_message || "Failed to send reset code. Please try again."
        );
      }
    } catch (error) {
      console.error("Error sending reset code:", error);
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Forgot Password"
      subtitle="Please enter email to receive verification code"
      onBack={() => navigate("/login")}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && (
          <div className="text-red-500 text-sm text-center">
            {error}
            {rateLimitSeconds !== null && rateLimitSeconds > 0 && (
              <div className="mt-1 text-xs">
                Wait {rateLimitSeconds} seconds
              </div>
            )}
          </div>
        )}
        <TextInput
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={isLoading || (rateLimitSeconds !== null && rateLimitSeconds > 0)}
        />
        <Button
          type="submit"
          fullWidth
          disabled={isLoading || (rateLimitSeconds !== null && rateLimitSeconds > 0)}
        >
          {isLoading
            ? "Sending..."
            : rateLimitSeconds !== null && rateLimitSeconds > 0
            ? `Wait ${rateLimitSeconds}s`
            : "Send Code"}
        </Button>
      </form>
    </AuthShell>
  );
};
