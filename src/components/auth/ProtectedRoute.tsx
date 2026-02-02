import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getBearerToken, AUTH_EVENT } from "../../services/api";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      const token = await getBearerToken();
      if (!cancelled) setIsAuthenticated(!!token);
    };

    checkAuth();

    const onAuthChanged = () => checkAuth();
    window.addEventListener(AUTH_EVENT, onAuthChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(AUTH_EVENT, onAuthChanged);
    };
  }, []);

  if (isAuthenticated === null) return null;

  if (!isAuthenticated) return <Navigate to="/welcome" replace />;

  return <>{children}</>;
};
