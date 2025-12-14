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
      <div className="flex flex-col gap-4">
        <Button
          fullWidth
          variant="outline"
          onClick={() => navigate("/login-account")}
        >
          Log in by account number
        </Button>
        <Button fullWidth onClick={() => navigate("/login")}>
          Log In
        </Button>
        <p className="mt-0 pt-4 border-t border-[#EAEAF0] text-center text-sm font-poppins font-normal">
          <span className="text-[#0B0C19]">Don&apos;t have an account? </span>
          <Link to="/register" className="font-semibold text-[#2761FC]">
            Create an Account
          </Link>
        </p>
      </div>
    </AuthShell>
  );
};
