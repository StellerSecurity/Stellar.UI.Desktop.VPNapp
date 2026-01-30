import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getBearerToken } from "../../services/api";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Protected route that requires authentication
 * Redirects to /welcome if no token is found
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
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

  // Redirect to welcome if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/welcome" replace />;
  }

  // Render protected content if authenticated
  return <>{children}</>;
};
