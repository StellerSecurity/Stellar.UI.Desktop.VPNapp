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
  getSelectedServer,
} from "../../services/api";
import { invoke } from "@tauri-apps/api/core";

const isTauri = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEFAULT_OVPN_URL =
    "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const { subscription } = useSubscription();

  const [showLogout, setShowLogout] = useState(false);

  const [autoConnect, setAutoConnectState] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [crashRecovery, setCrashRecovery] = useState(false);

  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      const account = await getAccountNumber();
      const device = await getDeviceName();
      const autoConnectPref = await getAutoConnect();

      setAccountNumber(account);
      setDeviceName(device);
      setAutoConnectState(autoConnectPref);

      if (isTauri()) {
        try {
          const ks = await invoke<boolean>("killswitch_status");
          const cr = await invoke<boolean>("crashrecovery_status");
          setKillSwitch(Boolean(ks));
          setCrashRecovery(Boolean(cr));
        } catch {
          // ignore
        }
      }
    };
    loadData();
  }, []);

  const formatAccountNumber = (account: string | null): string => {
    if (!account) return "N/A";
    const cleaned = account.replace(/\s/g, "");
    return cleaned.match(/.{1,4}/g)?.join(" ") || account;
  };

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

  const handleLogout = async () => {
    if (isTauri()) {
      // Always clean up VPN first
      try {
        await invoke("vpn_disconnect");
      } catch {
        // ignore
      }

      // Optional: disable kill switch on logout to avoid "no internet surprise"
      try {
        await invoke("killswitch_set", {
          enabled: false,
          configPath: null,
          bearerToken: null,
        });
      } catch {
        // ignore
      }

      // Optional: disable crash recovery on logout
      try {
        await invoke("crashrecovery_set", { enabled: false });
      } catch {
        // ignore
      }
    }

    await clearAuthData();
    navigate("/welcome");
  };

  const toggleKillSwitch = async () => {
    const next = !killSwitch;
    setKillSwitch(next);

    if (!isTauri()) return;

    try {
      if (next) {
        const server = await getSelectedServer().catch(() => null);
        const cfg = server?.configUrl ? server.configUrl : DEFAULT_OVPN_URL;

        await invoke("killswitch_set", {
          enabled: true,
          configPath: cfg,
          bearerToken: null,
        });
      } else {
        await invoke("killswitch_set", {
          enabled: false,
          configPath: null,
          bearerToken: null,
        });
      }
    } catch (e: any) {
      console.error("Kill switch error:", e);
      setKillSwitch(!next);

      alert(
          "Kill switch failed.\n\nOn Linux this requires sudo until we ship a privileged helper.\nUse scripts/linux-dev-root.sh for dev."
      );
    }
  };

  const toggleCrashRecovery = async () => {
    const next = !crashRecovery;
    setCrashRecovery(next);

    if (!isTauri()) return;

    try {
      await invoke("crashrecovery_set", { enabled: next });
    } catch (e) {
      console.error("Crash recovery toggle error:", e);
      setCrashRecovery(!next);
      alert("Failed to update crash recovery setting.");
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
                Available for <span className="text-[#2761FC]">6</span> devices
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
            </div>
          </div>

          <div className="px-5 mt-10 bg-white rounded-2xl flex-1 pt-6 pb-6">
            {/* Auto connect */}
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

            {/* Kill switch */}
            <div className="flex items-center justify-between text-sm mb-6 pb-6 border-b border-[#EAEAF0]">
              <div className="flex flex-col">
              <span className="text-[14px] font-semibold text-[#0B0C19] flex items-center gap-2">
                <img src="/icons/network.svg" alt="Kill switch" className="w-11 h-11" />
                Kill switch
              </span>
                <span className="text-[11px] text-[#62626A] mt-1">
                Blocks internet when VPN is down. Linux dev requires sudo.
              </span>
              </div>

              <button
                  type="button"
                  onClick={toggleKillSwitch}
                  className={`w-[42px] h-[26px] rounded-full flex items-center px-1 transition-colors ${
                      killSwitch ? "bg-[#2761FC]" : "bg-gray-300"
                  }`}
              >
              <span
                  className={`w-[20px] h-[20px] rounded-full bg-white flex items-center justify-center transition-transform ${
                      killSwitch ? "translate-x-4" : "translate-x-0"
                  }`}
              >
                {killSwitch && (
                    <img src="/icons/blue-tick.svg" alt="Tick" className="w-4 h-4" />
                )}
              </span>
              </button>
            </div>

            {/* Logout */}
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
                <img
                    src="/icons/logout.svg"
                    alt="Logout"
                    className="w-10 h-10 mx-auto mb-4"
                />
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
