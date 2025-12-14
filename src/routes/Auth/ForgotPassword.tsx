import React from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export const ForgotPassword: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Forgot Password"
      subtitle="Please enter email to receive verification code"
      onBack={() => navigate("/login")}
    >
      <form className="flex flex-col gap-4">
        <TextInput type="email" placeholder="you@example.com" />
        <Button
          type="submit"
          fullWidth
          onClick={() => navigate("/password-otp")}
        >
          Send Code
        </Button>
      </form>
    </AuthShell>
  );
};
