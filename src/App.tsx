import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useConnection } from "./contexts/ConnectionContext";
import { Welcome } from "./routes/Auth/Welcome";
import { LoginEmail } from "./routes/Auth/LoginEmail";
import { LoginAccountNumber } from "./routes/Auth/LoginAccountNumber";
import { Register } from "./routes/Auth/Register";
import { RegisterOtp } from "./routes/Auth/RegisterOtp";
import { ForgotPassword } from "./routes/Auth/ForgotPassword";
import { PasswordOtp } from "./routes/Auth/PasswordOtp";
import { NewPassword } from "./routes/Auth/NewPassword";
import { Dashboard } from "./routes/Dashboard/Dashboard";
import { ChangeLocation } from "./routes/Dashboard/ChangeLocation";
import { Profile } from "./routes/Dashboard/Profile";
import { Subscribe } from "./routes/Dashboard/Subscribe";

function AppContent() {
  const location = useLocation();
  const { isConnected } = useConnection();
  const isDashboardRoute = location.pathname === "/dashboard";

  // Determine background image
  const getBackgroundImage = () => {
    if (isDashboardRoute && isConnected) {
      return "bg-[url('/icons/dashboard-bg.png')]";
    } else if (isDashboardRoute) {
      return "bg-[url('/icons/dashboard-bg.png')]";
    }
    return "bg-[url('/icons/bg-blue.png')]";
  };

  return (
    <div className="h-screen w-screen bg-slate-900 flex items-center justify-center">
      <div
        className={`w-[390px] h-[800px] ${getBackgroundImage()} bg-cover bg-no-repeat overflow-hidden relative`}
      >
        <div className="relative h-full w-full">
          <Routes>
            <Route path="/" element={<Navigate to="/welcome" replace />} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/login" element={<LoginEmail />} />
            <Route path="/login-account" element={<LoginAccountNumber />} />
            <Route path="/register" element={<Register />} />
            <Route path="/register-otp" element={<RegisterOtp />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/password-otp" element={<PasswordOtp />} />
            <Route path="/new-password" element={<NewPassword />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/change-location" element={<ChangeLocation />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/subscribe" element={<Subscribe />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
