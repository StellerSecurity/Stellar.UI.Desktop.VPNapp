import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useConnection } from "../../contexts/ConnectionContext";
import { useSubscription } from "../../contexts/SubscriptionContext";
import {
  getAccountNumber,
  getSelectedServer,
  getDeviceName,
  fetchServerList,
  getAutoConnect,
} from "../../services/api";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Check if running in Tauri
const isTauri = () =>
    typeof window !== "undefined" &&
    ((window as any).__TAURI__ !== undefined ||
        (window as any).__TAURI_INTERNALS__ !== undefined);


export const Dashboard: React.FC = () => {
  const { status, setStatus, isConnected } = useConnection();
  const { subscription, refreshSubscription } = useSubscription();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCongrats, setShowCongrats] = useState(false);
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    null
  );
  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  const isConnecting = status === "connecting";

  const DEFAULT_OVPN_URL =
      "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

// DEV ONLY. Remove before shipping.
  const TEST_OVPN_USERNAME = "stvpn_eu_test_1";
  const TEST_OVPN_PASSWORD = "testpassword";

  const syncStatus = async () => {
    try {
      const s = await invoke<string>("vpn_status");
      if (s === "connected" || s === "connecting" || s === "disconnected") {
        setStatus(s as any);
      } else if (typeof s === "string" && s.startsWith("error")) {
        setStatus("disconnected");
      }
    } catch {
      // ignore
    }
  };

  // Load account number, device name, and selected server from storage
  useEffect(() => {
    const loadData = async () => {
      const account = await getAccountNumber();
      const device = await getDeviceName();
      setAccountNumber(account);
      setDeviceName(device);

      const server = await getSelectedServer();
      const configPath = DEFAULT_OVPN_URL;
      setSelectedServerName(server.name);

      // Show congrats modal only for one-click registration (when oneClick=true)
      if (
        searchParams.get("newUser") === "true" &&
        searchParams.get("oneClick") === "true"
      ) {
        setShowCongrats(true);
        // Remove query params from URL
        setSearchParams({});
      }
    };
    loadData();
  }, [searchParams, setSearchParams]);

  // Prefetch server list in the background when dashboard loads
  useEffect(() => {
    const prefetchServers = async () => {
      try {
        // Fetch in background - don't await, just trigger the fetch
        // This will populate the cache for when ChangeLocation opens
        fetchServerList().catch((err) => {
          console.warn("Failed to prefetch server list:", err);
          // Silently fail - ChangeLocation will retry when opened
        });
      } catch (err) {
        console.warn("Error prefetching server list:", err);
      }
    };
    prefetchServers();
  }, []);

  // Auto connect if enabled when dashboard loads
  useEffect(() => {
    let mounted = true;

    const attemptAutoConnect = async () => {
      // Only auto-connect if:
      // 1. Running in Tauri (not web mode)
      // 2. Auto connect is enabled
      // 3. Currently disconnected
      // 4. A server is selected
      if (!isTauri()) {
        return;
      }

      const autoConnectEnabled = await getAutoConnect();
      if (!autoConnectEnabled || !mounted) {
        return;
      }

      // Check current status
      if (status !== "disconnected") {
        return; // Already connected or connecting
      }

      const server = await getSelectedServer();
      if (!server.configUrl || !mounted) {
        return; // No server selected
      }

      const configPath = DEFAULT_OVPN_URL;


      // Auto connect
      try {
        setStatus("connecting");
        await invoke("vpn_connect", {
          configPath,
          username: TEST_OVPN_USERNAME,
          password: TEST_OVPN_PASSWORD,
        });

        await syncStatus();

      } catch (error) {
        console.error("Auto connect failed:", error);
        if (mounted) {
          setStatus("disconnected");
        }
      }
    };

    // Small delay to ensure status is initialized and data is loaded
    const timer = setTimeout(() => {
      attemptAutoConnect();
    }, 1000);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Format account number with spaces (XXXX XXXX XXXX XXXX)
  const formatAccountNumber = (account: string | null): string => {
    if (!account) return "N/A";
    // Remove existing spaces and add them back in groups of 4
    const cleaned = account.replace(/\s/g, "");
    return cleaned.match(/.{1,4}/g)?.join(" ") || account;
  };

  const handleCopyAccount = async () => {
    if (accountNumber) {
      try {
        // Copy the raw account number (without spaces) to clipboard
        const cleaned = accountNumber.replace(/\s/g, "");
        await navigator.clipboard.writeText(cleaned);
        // Show toast notification
        console.log("Copy successful, showing toast");
        setShowCopiedToast(true);
        setTimeout(() => {
          setShowCopiedToast(false);
        }, 2000); // Hide after 2 seconds
      } catch (err) {
        console.error("Failed to copy:", err);
        // Fallback for older browsers or when clipboard API fails
        const textArea = document.createElement("textarea");
        textArea.value = accountNumber.replace(/\s/g, "");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand("copy");
          console.log("Copy successful (fallback), showing toast");
          setShowCopiedToast(true);
          setTimeout(() => {
            setShowCopiedToast(false);
          }, 2000);
        } catch (fallbackErr) {
          console.error("Fallback copy failed:", fallbackErr);
        }
        document.body.removeChild(textArea);
      }
    } else {
      console.log("No account number to copy");
    }
  };

  // Listen for events from Rust (vpn-status + vpn-log)
  useEffect(() => {
    if (!isTauri()) {
      console.log("Running in web mode - Tauri events disabled");
      return;
    }

    let unlistenStatus: (() => void) | undefined;
    let unlistenLog: (() => void) | undefined;

    (async () => {
      unlistenStatus = await listen<string>("vpn-status", (event) => {
        const s = event.payload;

        if (s === "connected" || s === "connecting" || s === "disconnected") {
          setStatus(s as "disconnected" | "connecting" | "connected");
        } else if (typeof s === "string" && s.startsWith("error")) {
          console.error("VPN error:", s);
          setStatus("disconnected");
        }
      });

      unlistenLog = await listen<string>("vpn-log", (event) => {
        console.log("[VPN]", event.payload);
      });
    })();

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenLog) unlistenLog();
    };
  }, [setStatus]);

  const handleConnectToggle = async () => {
    if (!isTauri()) {
      // Web mode: just toggle the UI state for demo purposes
      if (status === "disconnected") {
        setStatus("connecting");
        setTimeout(() => setStatus("connected"), 1500);
      } else {
        setStatus("disconnected");
      }
      return;
    }

    try {
      if (status === "disconnected") {
        setStatus("connecting");

        // Get selected server config URL
        const server = await getSelectedServer();
        const configPath = DEFAULT_OVPN_URL;

        setStatus("connecting");
        await invoke("vpn_connect", {
          configPath,
          username: TEST_OVPN_USERNAME,
          password: TEST_OVPN_PASSWORD,
        });

        await syncStatus();

      } else {
        await invoke("vpn_disconnect");
        setStatus("disconnected");
      }
    } catch (e) {
      console.error("VPN connect error:", e);
      setStatus("disconnected");
    }
  };

  return (
    <div className="h-full w-full flex flex-col text-white relative">
      <div
        className={`absolute top-0 left-0 w-full h-[280px] z-0 ${
          isConnected
            ? "bg-[linear-gradient(to_bottom,#00B252B8_0%,rgba(0,178,82,0)_100%)]"
            : isConnecting
            ? "bg-[linear-gradient(to_bottom,#0B0C19B8_0%,rgba(11,12,25,0)_100%)]"
            : "bg-[linear-gradient(to_bottom,#E10000B8_0%,rgba(225,0,0,0)_100%)]"
        }`}
      />

      {/* Header */}
      <div className="px-6 pt-10 flex items-center justify-between relative z-10">
        <div className="flex items-center logo-container">
          {/* <div className="rounded-2xl bg-white h-auto w-auto shadow overflow-hidden"> */}
          <img
            src="/icons/dashboard-icon.svg"
            alt="Dashboard"
            className="h-20 w-20 inline-block"
          />
          {/* </div> */}
          <span className="text-[14px] font-semibold font-silka">
            Stellar VPN
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-full bg-white px-3 py-1 text-[11px]">
            <span
              className={`font-semibold flex items-center gap-1 ${
                subscription?.days_remaining === 0
                  ? "!text-red-500"
                  : "text-[#00B252]"
              }`}
            >
              {subscription?.days_remaining === 0 && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M8 6.00003V8.6667M8 10.6667V10.6734M2 8.00003C2 8.78796 2.15519 9.56818 2.45672 10.2961C2.75825 11.0241 3.20021 11.6855 3.75736 12.2427C4.31451 12.7998 4.97595 13.2418 5.7039 13.5433C6.43185 13.8448 7.21207 14 8 14C8.78793 14 9.56815 13.8448 10.2961 13.5433C11.0241 13.2418 11.6855 12.7998 12.2426 12.2427C12.7998 11.6855 13.2417 11.0241 13.5433 10.2961C13.8448 9.56818 14 8.78796 14 8.00003C14 7.2121 13.8448 6.43188 13.5433 5.70393C13.2417 4.97598 12.7998 4.31454 12.2426 3.75739C11.6855 3.20024 11.0241 2.75828 10.2961 2.45675C9.56815 2.15523 8.78793 2.00003 8 2.00003C7.21207 2.00003 6.43185 2.15523 5.7039 2.45675C4.97595 2.75828 4.31451 3.20024 3.75736 3.75739C3.20021 4.31454 2.75825 4.97598 2.45672 5.70393C2.15519 6.43188 2 7.2121 2 8.00003Z"
                    stroke="#E10000"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {subscription?.days_remaining !== undefined
                ? `${subscription.days_remaining} days`
                : isConnected
                ? "30 days"
                : "0 days"}
            </span>
          </button>
          <button
            className="rounded-full flex items-center justify-center"
            onClick={() => navigate("/profile")}
          >
            <img
              src="/icons/user.svg"
              alt="Profile"
              className="w-[25px] h-[25px]"
            />
          </button>
        </div>
      </div>

      <div className="px-6 mt-4 text-[11px] text-white/80 relative z-10">
        <span className="text-[#D6D6E0] text-[12px]">Device Name: </span>
        <span className="font-semibold text-[12px] text-white">
          {deviceName || "N/A"}
        </span>
      </div>

      {/* Status pill */}
      <div className="px-6 mt-6 text-center">
        <div className="bg-[rgba(0,0,0,0.08)] inline-flex items-center gap-2 rounded-full px-4 pr-6 py-2 text-md text-white font-semibold backdrop-blur-[18px]">
          {isConnected ? (
            <>
              <img
                src="/icons/secured.svg"
                alt="Secured"
                className="w-10 h-10"
              />
              <span>Secured connection</span>
            </>
          ) : isConnecting ? (
            <span>Connecting...</span>
          ) : (
            <>
              <img
                src="/icons/unsecured.svg"
                alt="Unsecured"
                className="w-10 h-10"
              />
              <span>Unsecured connection</span>
            </>
          )}
        </div>
      </div>

      {/* Center circle */}
      <div className="flex-1 flex items-center justify-center">
        <div
          className={`h-16 w-16 rounded-full flex items-center justify-center ${
            isConnected
              ? "bg-[radial-gradient(circle,rgba(0,178,82,0)_0%,rgba(0,178,82,0)_40%,rgba(0,178,82,0.6)_100%)]"
              : isConnecting
              ? "bg-[radial-gradient(circle,rgba(98,98,106,0)_0%,rgba(98,98,106,0)_40%,rgba(98,98,106,1)_100%)]"
              : "bg-[radial-gradient(circle,rgba(225,0,0,0)_0%,rgba(225,0,0,0)_40%,rgba(225,0,0,0.6)_100%)]"
          }`}
        >
          <div
            className={`h-7 w-7 rounded-full flex items-center justify-center ${
              isConnected ? "bg-white" : isConnecting ? "bg-white" : "bg-white"
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full ${
                isConnected
                  ? "bg-emerald-400"
                  : isConnecting
                  ? "bg-[#62626A]"
                  : "bg-[#E10000]"
              }`}
            />
          </div>
        </div>
      </div>

      {/* Fastest server card + connect button */}
      <div className="px-6 pb-10">
        <button
          type="button"
          onClick={() => navigate("/change-location")}
          className="mb-4 w-full rounded-full bg-white/10 px-5 py-4 text-xs flex items-center justify-between"
        >
          <div className="flex flex-col">
            <span className="text-[#D6D6E0] text-[12px]">Fastest Server</span>
            <span className="mt-1 text-sm font-semibold text-[#EAEAF0] flex items-center gap-2">
              <img
                src="/icons/flag.svg"
                alt="Flag"
                className="w-6 h-6 rounded-full"
              />
              {selectedServerName || "Select Location"}
            </span>
          </div>
          <img src="/icons/right-arrow.svg" alt="Arrow" className="w-5 h-4" />
        </button>
        <Button
          fullWidth
          variant={isConnected ? "danger" : "primary"}
          className={`!text-[15px] h-[46px] ${
            isConnected && "!bg-white border border-[#E10000] !text-[#E10000]"
          } ${
            isConnecting &&
            "!bg-white border !disabled:opacity-100 border-gray-300 !text-gray-500"
          }`}
          onClick={handleConnectToggle}
          disabled={isConnecting}
        >
          {isConnected
            ? "Disconnect"
            : isConnecting
            ? "Connecting..."
            : "Connect"}
        </Button>
      </div>

      {/* Congrats Modal - Show for all new users */}
      {showCongrats && (
        <div className="absolute inset-0 flex items-end justify-center bg-black/40 z-50">
          <div className="w-full bg-white rounded-t-3xl px-6 pt-6 pb-7 animate-slide-up">
            <div className="flex flex-col items-center">
              {/* Green checkmark icon */}
              <img
                src="/icons/green-tick.svg"
                alt="Success"
                className="w-12 h-12 mb-2"
              />

              {/* Heading */}
              <h2 className="text-xl font-bold text-[#0B0C19] mb-2 font-poppins">
                Congrats!
              </h2>

              {/* Subtitle */}
              <p className="text-sm text-[#62626A] mb-6 text-center font-poppins">
                {accountNumber
                  ? "Here's your account number. Save it!"
                  : "Welcome! Your account has been created."}
              </p>

              {/* Account Number Input */}
              <div className="w-full mb-6 relative">
                <div className="text-[11px] font-normal text-[#62626A] mb-2 font-poppins">
                  Account Name / Number
                </div>
                <div className="flex items-center gap-2 bg-[#EAEAF0] rounded-2xl px-4 py-3">
                  <span className="flex-1 text-[13px] font-semibold text-[#0B0C19] font-poppins">
                    {formatAccountNumber(accountNumber)}
                  </span>
                  {accountNumber && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log("Copy button clicked");
                          handleCopyAccount();
                        }}
                        className="flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <img
                          src="/icons/copy.svg"
                          alt="Copy"
                          className="w-7 h-7"
                        />
                      </button>
                      {/* Copied Toast Notification - Right above button */}
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
              </div>

              {/* Got It Button */}
              <Button
                fullWidth
                onClick={() => setShowCongrats(false)}
                className="h-[42px] text-base font-poppins"
              >
                Got It
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
