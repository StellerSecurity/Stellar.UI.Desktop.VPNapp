import React, { createContext, useContext, useState, ReactNode } from "react";

type Status = "disconnected" | "connecting" | "connected";

interface ConnectionContextType {
  status: Status;
  setStatus: (status: Status) => void;
  isConnected: boolean;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(
  undefined
);

export const ConnectionProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [status, setStatus] = useState<Status>("disconnected");
  const isConnected = status === "connected";

  return (
    <ConnectionContext.Provider value={{ status, setStatus, isConnected }}>
      {children}
    </ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error("useConnection must be used within ConnectionProvider");
  }
  return context;
};
