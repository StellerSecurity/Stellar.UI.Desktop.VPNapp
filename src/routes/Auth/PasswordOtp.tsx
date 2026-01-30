import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { OtpInput } from "../../components/ui/OtpInput";
import { Button } from "../../components/ui/Button";
import { verifyPasswordResetCode, sendPasswordResetCode } from "../../services/api";

export const PasswordOtp: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = useState<number | null>(null);

  // Load email from storage
  useEffect(() => {
    const storedEmail = localStorage.getItem("password_reset_email");
    if (!storedEmail) {
      navigate("/forgot-password");
      return;
    }
    setEmail(storedEmail);
  }, [navigate]);

  // Handle rate limiting countdown
  useEffect(() => {
    if (rateLimitSeconds !== null && rateLimitSeconds > 0) {
      const timer = setTimeout(() => {
        setRateLimitSeconds(rateLimitSeconds - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (rateLimitSeconds === 0) {
      setRateLimitSeconds(null);
    }
  }, [rateLimitSeconds]);

  const handleVerify = async (code?: string) => {
    if (!email) return;

    const codeToVerify = code || confirmationCode;
    if (!codeToVerify || codeToVerify.length < 6) {
      setError("Please enter a valid 6-8 digit code");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await verifyPasswordResetCode(email, codeToVerify);

      if (!response) {
        setError("Service unavailable. Please try again.");
        return;
      }

      if (response.response_code === 200) {
        // Store confirmation code for next step
        localStorage.setItem("password_reset_code", codeToVerify);
        navigate("/new-password");
      } else if (response.response_code === 400) {
        setError("Invalid code. Please check and try again.");
      } else if (response.response_code === 401) {
        setError("Code expired. Please request a new code.");
        // Navigate back to forgot password
        setTimeout(() => navigate("/forgot-password"), 2000);
      } else if (response.response_code === 402) {
        setError("Code already used or invalid. Please request a new code.");
        setTimeout(() => navigate("/forgot-password"), 2000);
      } else if (response.response_code === 429) {
        const message = response.response_message || "";
        const secondsMatch = message.match(/(\d+)/);
        const waitSeconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 60;
        setRateLimitSeconds(waitSeconds);
        setError(`Too many attempts. Please wait ${waitSeconds} seconds.`);
      } else {
        setError(response.response_message || "Verification failed. Please try again.");
      }
    } catch (error) {
      console.error("Error verifying code:", error);
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email) return;

    setIsResending(true);
    setError(null);

    try {
      const response = await sendPasswordResetCode(email);

      if (response?.response_code === 200) {
        setError(null);
        // Clear current code input
        setConfirmationCode("");
      } else if (response?.response_code === 429) {
        const message = response.response_message || "";
        const secondsMatch = message.match(/(\d+)/);
        const waitSeconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 60;
        setRateLimitSeconds(waitSeconds);
        setError(`Too many attempts. Please wait ${waitSeconds} seconds.`);
      } else {
        setError(response?.response_message || "Failed to resend code. Please try again.");
      }
    } catch (error) {
      console.error("Error resending code:", error);
      setError("An error occurred. Please try again.");
    } finally {
      setIsResending(false);
    }
  };

  if (!email) {
    return null; // Will redirect
  }

  return (
    <AuthShell
      title="Please input code"
      subtitle="We sent a password reset code to your email"
      onBack={() => navigate("/forgot-password")}
      icon="/icons/msg.svg"
    >
      {error && (
        <div className="text-red-500 text-sm text-center mb-2">
          {error}
          {rateLimitSeconds !== null && rateLimitSeconds > 0 && (
            <div className="mt-1 text-xs">Wait {rateLimitSeconds} seconds</div>
          )}
        </div>
      )}
      <OtpInput
        length={8}
        value={confirmationCode}
        onChange={setConfirmationCode}
        onComplete={handleVerify}
      />
      <p className="text-sm text-center">
        <span className="text-textDark">Did not receive a code? </span>
        <button
          type="button"
          className="text-[#2761FC] font-semibold"
          onClick={handleResend}
          disabled={isResending || (rateLimitSeconds !== null && rateLimitSeconds > 0)}
        >
          {isResending ? "Resending..." : "Resend code"}
        </button>
      </p>

      <Button
        className="mt-6"
        fullWidth
        onClick={() => handleVerify()}
        disabled={isLoading || confirmationCode.length < 6 || (rateLimitSeconds !== null && rateLimitSeconds > 0)}
      >
        {isLoading ? "Verifying..." : "Confirm"}
      </Button>
      <p className="text-sm text-center mt-4">
        <button
          type="button"
          className="text-[#2761FC] font-semibold"
          onClick={() => {
            localStorage.removeItem("password_reset_email");
            navigate("/forgot-password");
          }}
        >
          Use different email
        </button>
      </p>
    </AuthShell>
  );
};
