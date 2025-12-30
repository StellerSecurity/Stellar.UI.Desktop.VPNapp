import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getBearerToken } from "../../services/api";

interface AuthRouteProps {
  children: React.ReactNode;
}

/**
 * Auth route that redirects authenticated users away from auth pages
 * Redirects to /dashboard if token is found
 */
export const AuthRoute: React.FC<AuthRouteProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      const token = await getBearerToken();
      setIsAuthenticated(!!token);
    };
    checkAuth();
  }, []);

  // Show nothing while checking (or show a loading spinner if desired)
  if (isAuthenticated === null) {
    return null; // or <LoadingSpinner />
  }

  // Redirect to dashboard if already authenticated
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  // Render auth page if not authenticated
  return <>{children}</>;
};
