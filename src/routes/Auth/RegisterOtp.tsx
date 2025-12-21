import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { OtpInput } from "../../components/ui/OtpInput";
import { Button } from "../../components/ui/Button";
import { handleAuthSuccess } from "../../utils/auth";
import { useSubscription } from "../../contexts/SubscriptionContext";

export const RegisterOtp: React.FC = () => {
  const navigate = useNavigate();
  const { refreshSubscription, startPolling } = useSubscription();
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    setIsLoading(true);

    try {
      // TODO: Replace with actual OTP verification API call
      // For now, using a mock token - replace this with actual API response
      const mockToken = "mock_bearer_token_from_register_otp_api";

      // Store token and trigger subscription refresh
      await handleAuthSuccess(mockToken, async () => {
        // Immediately call Home endpoint after successful registration
        await refreshSubscription();
        // Start polling
        startPolling();
        // Navigate to dashboard
        navigate("/dashboard");
      });
    } catch (error) {
      console.error("OTP verification error:", error);
      // Handle error (show error message to user)
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title="Please input code"
      subtitle="We sent a verification code to your email"
      onBack={() => navigate("/register")}
      icon="/icons/msg.svg"
    >
      <OtpInput length={4} />
      <p className="text-sm text-center">
        <span className="text-textDark">Did not receive a code? </span>
        <button type="button" className="text-[#2761FC] font-semibold">
          Resend code
        </button>
      </p>

      <Button
        className="mt-6"
        fullWidth
        onClick={handleConfirm}
        disabled={isLoading}
      >
        {isLoading ? "Verifying..." : "Confirm"}
      </Button>
      <p className="text-sm text-center mt-4">
        <button type="button" className="text-[#2761FC] font-semibold">
          Sign up with different email
        </button>
      </p>
    </AuthShell>
  );
};
