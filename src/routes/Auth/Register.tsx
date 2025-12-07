import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export const Register: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Create an account"
      subtitle="Please enter email and password to create your free account."
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4">
        <Button
          type="button"
          fullWidth
          variant="outline"
          className="border-2 flex items-center justify-center gap-2"
          onClick={() => navigate("/register-otp")}
        >
          <span>⚡</span>
          <span>One-Click Register</span>
        </Button>

        <div className="my-1 flex items-center gap-3 text-[11px] text-slate-400">
          <div className="h-px flex-1 bg-slate-200" />
          <span>Or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <TextInput placeholder="Email" type="email" />
        <TextInput placeholder="Password" type="password" />
        <Button type="submit" fullWidth onClick={() => navigate("/register-otp")}>
          Create Account
        </Button>

        <p className="mt-3 text-center text-xs text-slate-500">
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-[#256BFF]">
            Log in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};
