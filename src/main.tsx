import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { ConnectionProvider } from "./contexts/ConnectionContext";
import { SubscriptionProvider } from "./contexts/SubscriptionContext";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <ConnectionProvider>
        <SubscriptionProvider>
          <App />
        </SubscriptionProvider>
      </ConnectionProvider>
    </HashRouter>
  </React.StrictMode>
);
