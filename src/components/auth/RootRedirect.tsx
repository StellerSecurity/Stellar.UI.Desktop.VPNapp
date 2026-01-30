import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getBearerToken } from "../../services/api";

/**
 * Root redirect that checks authentication and redirects accordingly
 */
export const RootRedirect: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      const token = await getBearerToken();
      setIsAuthenticated(!!token);
    };
    checkAuth();
  }, []);

  // Show nothing while checking
  if (isAuthenticated === null) {
    return null;
  }

  // Redirect to dashboard if authenticated, otherwise to welcome
  return <Navigate to={isAuthenticated ? "/dashboard" : "/welcome"} replace />;
};
