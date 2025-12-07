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
    >
      <OtpInput length={4} />
      <p className="text-sm text-slate-500">
        Did not receive a code?{" "}
        <button type="button" className="text-[#256BFF] font-semibold">
          Resend code
        </button>
      </p>
      <Button
        className="mt-6"
        fullWidth
        onClick={() => navigate("/dashboard")}
      >
        Confirm
      </Button>
    </AuthShell>
  );
};
