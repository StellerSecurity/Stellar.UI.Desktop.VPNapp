import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";
import { useSubscription } from "../../contexts/SubscriptionContext";
import {
  getAccountNumber,
  getDeviceName,
  clearAuthData,
  getAutoConnect,
  setAutoConnect,
} from "../../services/api";
import { invoke } from "@tauri-apps/api/core";

const isTauri = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const { subscription } = useSubscription();
  const [showLogout, setShowLogout] = useState(false);
  const [autoConnect, setAutoConnectState] = useState(false);
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  // Load account number, device name, and auto connect preference from storage
  useEffect(() => {
    const loadData = async () => {
      const account = await getAccountNumber();
      const device = await getDeviceName();
      const autoConnectPref = await getAutoConnect();
      setAccountNumber(account);
      setDeviceName(device);
      setAutoConnectState(autoConnectPref);
    };
    loadData();
  }, []);

  // Format account number with spaces (XXXX XXXX XXXX XXXX)
  const formatAccountNumber = (account: string | null): string => {
    if (!account) return "N/A";
    const cleaned = account.replace(/\s/g, "");
    return cleaned.match(/.{1,4}/g)?.join(" ") || account;
  };

  // Format expiration date
  const formatExpirationDate = (dateString: string | undefined): string => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString.replace(" ", "T"));
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}.${month}.${day}`;
    } catch {
      return "N/A";
    }
  };

  // Handle logout (disconnect VPN first)
  const handleLogout = async () => {
    // Best-effort VPN disconnect so we don't keep tunneling after logout
    if (isTauri()) {
      try {
        await invoke("vpn_disconnect");
      } catch (e) {
        // Do not block logout if disconnect fails
        console.warn("vpn_disconnect failed during logout:", e);
      }
    }

    // Optional but recommended: disable auto-connect on logout
    try {
      setAutoConnectState(false);
      await setAutoConnect(false);
    } catch (e) {
      console.warn("setAutoConnect(false) failed during logout:", e);
    }

    await clearAuthData();
    navigate("/welcome");
  };

  // Handle copy account number
  const handleCopyAccount = async () => {
    if (!accountNumber) return;

    try {
      const cleaned = accountNumber.replace(/\s/g, "");
      await navigator.clipboard.writeText(cleaned);
      setShowCopiedToast(true);
      setTimeout(() => setShowCopiedToast(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      const textArea = document.createElement("textarea");
      textArea.value = accountNumber.replace(/\s/g, "");
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        setShowCopiedToast(true);
        setTimeout(() => setShowCopiedToast(false), 2000);
      } catch (fallbackErr) {
        console.error("Fallback copy failed:", fallbackErr);
      }
      document.body.removeChild(textArea);
    }
  };

  return (
      <AuthShell title="Profile" onBack={() => navigate("/dashboard")}>
        <div className="space-y-4 flex-1 flex flex-col">
          <div className="px-6 flex flex-col gap-4">
            <div className="bg-white rounded-2xl p-4 text-sm">
              <div className="flex justify-between items-center mb-2">
                <div>
                  <div className="text-[11px] font-normal text-[#62626A] mb-1">
                    Account Name / Number
                  </div>
                  <div className="text-[12px] font-semibold text-[#0B0C19]">
                    {formatAccountNumber(accountNumber)}
                  </div>
                </div>
                {accountNumber && (
                    <div className="relative">
                      <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleCopyAccount();
                          }}
                          className="text-xs flex items-center gap-2 hover:opacity-80 transition-opacity"
                      >
                        <img src="/icons/copy.svg" alt="Copy" className="w-8 h-8" />
                      </button>
                      {showCopiedToast && (
                          <div className="absolute bottom-full right-0 mb-1 z-[9999] pointer-events-none">
                            <div className="bg-[#0B0C19] text-white px-3 py-1.5 rounded-lg text-[10px] font-medium shadow-lg whitespace-nowrap">
                              Copied!
                            </div>
                          </div>
                      )}
                    </div>
                )}
              </div>

              <div className="text-[11px] font-normal text-[#62626A] mb-1">
                Device name:
              </div>
              <div className="text-[14px] text-[#0B0C19] font-semibold">
                {deviceName || "N/A"}
              </div>

              <div className="text-[12px] text-[#62626A] mt-3 pt-3 border-t border-[#EAEAF0]">
                Available for <span className="text-[#2761FC]">5</span> devices
              </div>
            </div>

            <div className="bg-white rounded-2xl flex-col p-4 text-sm flex items-center justify-between">
              <div className="w-full">
                <div className="text-sm text-[#62626A] mb-2">Expires</div>
                <div className="flex items-center justify-between mb-2 w-full">
                  <div className="font-medium flex items-center gap-1">
                    {subscription?.days_remaining !== undefined
                        ? `In ${subscription.days_remaining} ${
                            subscription.days_remaining === 1 ? "day" : "days"
                        }`
                        : "N/A"}
                  </div>
                  <div className="text-sm text-[#62626A]">
                    {formatExpirationDate(subscription?.expires_at)}
                  </div>
                </div>
              </div>
              <Button
                  className="text-[13px] w-full mt-2 h-[42px]"
                  onClick={() => navigate("/subscribe")}
              >
                Add more days
              </Button>
            </div>
          </div>

          <div className="px-5 mt-10 bg-white rounded-2xl flex-1 pt-6 pb-6">
            <div className="flex items-center justify-between text-sm mb-6 pb-6 border-b border-[#EAEAF0]">
            <span className="text-[14px] font-semibold text-[#0B0C19] flex items-center gap-2">
              <img src="/icons/network.svg" alt="Network" className="w-11 h-11" />
              Auto connect
            </span>
              <button
                  type="button"
                  onClick={async () => {
                    const newValue = !autoConnect;
                    setAutoConnectState(newValue);
                    await setAutoConnect(newValue);
                  }}
                  className={`w-[42px] h-[26px] rounded-full flex items-center px-1 transition-colors ${
                      autoConnect ? "bg-[#2761FC]" : "bg-gray-300"
                  }`}
              >
              <span
                  className={`w-[20px] h-[20px] rounded-full bg-white flex items-center justify-center transition-transform ${
                      autoConnect ? "translate-x-4" : "translate-x-0"
                  }`}
              >
                {autoConnect && (
                    <img src="/icons/blue-tick.svg" alt="Tick" className="w-4 h-4" />
                )}
              </span>
              </button>
            </div>

            <button
                type="button"
                onClick={() => setShowLogout(true)}
                className="text-sm text-[#62626A] flex items-center gap-3 pl-2"
            >
              <img src="/icons/logout.svg" alt="Logout" className="w-7 h-7" />
              <span className="text-[14px] font-semibold text-[#62626A]">Logout</span>
            </button>
          </div>
        </div>

        {showLogout && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50">
              <div className="text-center rounded-2xl pt-12 pb-8 px-6 w-full max-w-[280px] mx-4 logout-screen bg-[#F6F6FD]">
                <img src="/icons/logout.svg" alt="Logout" className="w-10 h-10 mx-auto mb-4" />
                <h2 className="text-xl font-bold mb-2">Log out</h2>
                <p className="text-sm text-[#62626A] pb-4 mb-6 border-b border-[#EAEAF0]">
                  Are you sure you want to log out?
                </p>
                <div className="flex justify-end gap-5">
                  <button
                      type="button"
                      className="text-sm font-semibold text-[#62626A]"
                      onClick={() => setShowLogout(false)}
                  >
                    Cancel
                  </button>
                  <button
                      type="button"
                      className="text-sm text-[#2761FC] font-semibold"
                      onClick={handleLogout}
                  >
                    Log out
                  </button>
                </div>
              </div>
            </div>
        )}
      </AuthShell>
  );
};
