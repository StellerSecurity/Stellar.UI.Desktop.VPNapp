import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export const LoginAccountNumber: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Log in by account number"
      subtitle="Use your Stellar VPN account number to log in"
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4">
        <TextInput label="Account number" placeholder="XXXX XXXX XXXX XXXX" />
        <Button type="submit" fullWidth onClick={() => navigate("/dashboard")}>
          Log In
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
