import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { TextInput } from "../../components/ui/TextInput";
import { Button } from "../../components/ui/Button";
import { updatePasswordWithResetCode } from "../../services/api";

export const NewPassword: React.FC = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load email and code from storage
  useEffect(() => {
    const storedEmail = localStorage.getItem("password_reset_email");
    const storedCode = localStorage.getItem("password_reset_code");

    if (!storedEmail || !storedCode) {
      navigate("/forgot-password");
      return;
    }

    setEmail(storedEmail);
    setConfirmationCode(storedCode);
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }

    if (!email || !confirmationCode) {
      setError("Session expired. Please start over.");
      navigate("/forgot-password");
      return;
    }

    setIsLoading(true);

    try {
      const response = await updatePasswordWithResetCode(
        email,
        confirmationCode,
        newPassword
      );

      if (!response) {
        setError("Service unavailable. Please try again.");
        return;
      }

      if (response.response_code === 200) {
        // Clear stored data
        localStorage.removeItem("password_reset_email");
        localStorage.removeItem("password_reset_code");
        // Clear password from memory
        setNewPassword("");
        setConfirmPassword("");
        // Navigate to login
        navigate("/login");
      } else if (response.response_code === 399) {
        setError("Password is too short. Please use at least 8 characters.");
      } else if (response.response_code === 400) {
        setError("Invalid code or expired. Please start over.");
        setTimeout(() => {
          localStorage.removeItem("password_reset_email");
          localStorage.removeItem("password_reset_code");
          navigate("/forgot-password");
        }, 2000);
      } else if (response.response_code === 401) {
        setError("Code expired. Please start over.");
        setTimeout(() => {
          localStorage.removeItem("password_reset_email");
          localStorage.removeItem("password_reset_code");
          navigate("/forgot-password");
        }, 2000);
      } else {
        setError(
          response.response_message || "Failed to update password. Please try again."
        );
      }
    } catch (error) {
      console.error("Error updating password:", error);
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (!email || !confirmationCode) {
    return null; // Will redirect
  }

  return (
    <AuthShell
      title="Create new password"
      subtitle="Create new password for your account"
      onBack={() => navigate("/password-otp")}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && (
          <div className="text-red-500 text-sm text-center">{error}</div>
        )}
        <TextInput
          type="password"
          placeholder="New password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          disabled={isLoading}
        />
        <TextInput
          type="password"
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          disabled={isLoading}
        />
        <Button type="submit" fullWidth disabled={isLoading}>
          {isLoading ? "Updating..." : "Confirm"}
        </Button>
      </form>
    </AuthShell>
  );
};
