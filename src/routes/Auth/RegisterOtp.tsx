import React from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { OtpInput } from "../../components/ui/OtpInput";
import { Button } from "../../components/ui/Button";

export const RegisterOtp: React.FC = () => {
  const navigate = useNavigate();
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

      <Button className="mt-6" fullWidth onClick={() => navigate("/dashboard")}>
        Confirm
      </Button>
      <p className="text-sm text-center mt-4">
        <button type="button" className="text-[#2761FC] font-semibold">
          Sign up with different email
        </button>
      </p>
    </AuthShell>
  );
};
