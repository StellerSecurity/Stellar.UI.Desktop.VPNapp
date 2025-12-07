import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";

export const Welcome: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Secure VPN"
      subtitle="Encrypt your internet-traffic with Stellar VPN"
    >
      <div className="flex flex-col gap-3">
        <Button
          fullWidth
          variant="outline"
          className="border-2"
          onClick={() => navigate("/login-account")}
        >
          Log in by account number
        </Button>
        <Button fullWidth onClick={() => navigate("/login")}>
          Log In
        </Button>
        <p className="mt-4 text-center text-xs text-slate-500">
          Don&apos;t have an account?{" "}
          <Link to="/register" className="font-semibold text-[#256BFF]">
            Create an Account
          </Link>
        </p>
      </div>
    </AuthShell>
  );
};
