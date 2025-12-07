import React from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export const NewPassword: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Create new password"
      subtitle="Create a new password for your account"
      onBack={() => navigate("/password-otp")}
    >
      <form className="flex flex-col gap-4">
        <TextInput label="New password" type="password" />
        <TextInput label="Confirm new password" type="password" />
        <Button
          type="submit"
          fullWidth
          onClick={() => navigate("/login")}
        >
          Confirm
        </Button>
      </form>
    </AuthShell>
  );
};
