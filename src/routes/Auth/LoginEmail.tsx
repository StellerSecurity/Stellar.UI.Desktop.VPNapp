import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";

export const LoginEmail: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Log In"
      subtitle="Please enter your email and password"
      onBack={() => navigate("/welcome")}
    >
      <form className="flex flex-col gap-4">
        <TextInput placeholder="Email" type="email" />
        <TextInput placeholder="Password" type="password" />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => navigate("/forgot-password")}
            className="text-xs font-semibold text-[#256BFF]"
          >
            Forgot Password?
          </button>
        </div>
        <Button type="submit" fullWidth>
          Log In
        </Button>
        <p className="mt-3 text-center text-xs text-slate-500">
          Don&apos;t have an account?{" "}
          <Link to="/register" className="font-semibold text-[#256BFF]">
            Create an Account
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};
