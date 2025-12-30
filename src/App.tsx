import React from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { useConnection } from "./contexts/ConnectionContext";
import { ProtectedRoute } from "./components/auth/ProtectedRoute";
import { AuthRoute } from "./components/auth/AuthRoute";
import { RootRedirect } from "./components/auth/RootRedirect";
import { Welcome } from "./routes/Auth/Welcome";
import { LoginEmail } from "./routes/Auth/LoginEmail";
import { LoginAccountNumber } from "./routes/Auth/LoginAccountNumber";
import { Register } from "./routes/Auth/Register";
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
        className={`w-[312px] h-[640px] ${getBackgroundImage()} bg-cover bg-no-repeat overflow-hidden relative`}
      >
        <div className="relative h-full w-full">
          <Routes>
            <Route path="/" element={<RootRedirect />} />
            <Route
              path="/welcome"
              element={
                <AuthRoute>
                  <Welcome />
                </AuthRoute>
              }
            />
            <Route
              path="/login"
              element={
                <AuthRoute>
                  <LoginEmail />
                </AuthRoute>
              }
            />
            <Route
              path="/login-account"
              element={
                <AuthRoute>
                  <LoginAccountNumber />
                </AuthRoute>
              }
            />
            <Route
              path="/register"
              element={
                <AuthRoute>
                  <Register />
                </AuthRoute>
              }
            />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/password-otp" element={<PasswordOtp />} />
            <Route path="/new-password" element={<NewPassword />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/change-location"
              element={
                <ProtectedRoute>
                  <ChangeLocation />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/subscribe"
              element={
                <ProtectedRoute>
                  <Subscribe />
                </ProtectedRoute>
              }
            />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
