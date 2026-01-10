import React, { useEffect, useRef, useState, useCallback } from "react";
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

const isTauri = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEFAULT_OVPN_URL =
    "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

// TEMP TEST CREDS (do NOT ship this)
const DEFAULT_OVPN_USERNAME = "stvpn_eu_test_1";
const DEFAULT_OVPN_PASSWORD = "testpassword";

type UiStatus = "disconnected" | "connecting" | "connected";

const normalizeStatus = (s: unknown): UiStatus | null => {
  if (typeof s !== "string") return null;
  if (s === "connected" || s === "connecting" || s === "disconnected") return s;
  return null;
};

const pickConfigUrl = (selectedServer: any): string => {
  const u = selectedServer?.configUrl;
  if (typeof u === "string" && u.trim().length > 0) return u.trim();
  return DEFAULT_OVPN_URL;
};

export const Dashboard: React.FC = () => {
  const { status, setStatus } = useConnection();
  const { subscription } = useSubscription();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showCongrats, setShowCongrats] = useState(false);
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  const [vpnLogs, setVpnLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  // Keep latest status in a ref (avoids stale closure problems)
  const statusRef = useRef<UiStatus>("disconnected");
  useEffect(() => {
    statusRef.current = normalizeStatus(status) ?? "disconnected";
  }, [status]);

  const syncBackendStatus = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const s = await invoke<string>("vpn_status");
      const ui = normalizeStatus(s);

      if (ui) {
        setStatus(ui);
        return;
      }

      if (typeof s === "string" && s.startsWith("error")) {
        console.error("VPN backend error:", s);
        setStatus("disconnected");
      }
    } catch (e) {
      console.warn("vpn_status sync failed:", e);
    }
  }, [setStatus]);

  // Load account number, device name, and selected server from storage
  useEffect(() => {
    const loadData = async () => {
      const account = await getAccountNumber();
      const device = await getDeviceName();
      setAccountNumber(account);
      setDeviceName(device);

      const server = await getSelectedServer();
      setSelectedServerName(server?.name ?? null);

      if (
          searchParams.get("newUser") === "true" &&
          searchParams.get("oneClick") === "true"
      ) {
        setShowCongrats(true);
        setSearchParams({});
      }
    };

    loadData();
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    fetchServerList().catch((err) => {
      console.warn("Failed to prefetch server list:", err);
    });
  }, []);

  // Register listeners FIRST, then sync backend status
  useEffect(() => {
    if (!isTauri()) return;

    let mounted = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenLog: (() => void) | undefined;

    (async () => {
      unlistenStatus = await listen<string>("vpn-status", (event) => {
        const s = event.payload;
        const ui = normalizeStatus(s);
        if (ui) {
          setStatus(ui);
          return;
        }

        if (typeof s === "string" && s.startsWith("error")) {
          console.error("VPN error:", s);
          setStatus("disconnected");
        }
      });

      unlistenLog = await listen<string>("vpn-log", (event) => {
        const line = event.payload;
        setVpnLogs((prev) => {
          const next = [...prev, line];
          return next.length > 250 ? next.slice(next.length - 250) : next;
        });
      });

      if (!mounted) return;

      setListenersReady(true);
      await syncBackendStatus();
    })();

    return () => {
      mounted = false;
      if (unlistenStatus) unlistenStatus();
      if (unlistenLog) unlistenLog();
    };
  }, [setStatus, syncBackendStatus]);

  // Poll while connecting (backup). Only starts after listeners are ready.
  useEffect(() => {
    if (!isTauri()) return;
    if (!listenersReady) return;
    if (statusRef.current !== "connecting") return;

    let alive = true;
    const id = setInterval(async () => {
      if (!alive) return;
      await syncBackendStatus();

      const now = statusRef.current;
      if (now === "connected" || now === "disconnected") {
        clearInterval(id);
      }
    }, 900);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [listenersReady, syncBackendStatus]);

  // Auto connect (always-on): uses selected server configUrl
  useEffect(() => {
    if (!isTauri()) return;
    if (!listenersReady) return;

    let cancelled = false;

    (async () => {
      try {
        const autoConnectEnabled = await getAutoConnect();
        if (!autoConnectEnabled || cancelled) return;

        // Trust backend status
        const backend = await invoke<string>("vpn_status").catch(() => "");
        const backendUi = normalizeStatus(backend) ?? statusRef.current;

        if (backendUi !== "disconnected") return;

        const selected = await getSelectedServer();
        const configPath = pickConfigUrl(selected);

        setStatus("connecting");
        await invoke("vpn_connect", {
          configPath,
          username: DEFAULT_OVPN_USERNAME,
          password: DEFAULT_OVPN_PASSWORD,
        });
      } catch (error) {
        console.error("Auto connect failed:", error);
        if (!cancelled) setStatus("disconnected");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [listenersReady, setStatus]);

  const formatAccountNumber = (account: string | null): string => {
    if (!account) return "N/A";
    const cleaned = account.replace(/\s/g, "");
    return cleaned.match(/.{1,4}/g)?.join(" ") || account;
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
    }
  };

  const handleConnectToggle = async () => {
    if (!isTauri()) {
      if (status === "disconnected") {
        setStatus("connecting");
        setTimeout(() => setStatus("connected"), 1500);
      } else {
        setStatus("disconnected");
      }
      return;
    }

    try {
      await syncBackendStatus();
      const current = statusRef.current;

      if (current === "disconnected") {
        setStatus("connecting");

        const selected = await getSelectedServer();
        const configPath = pickConfigUrl(selected);

        console.log("Selected server:", selected);
        console.log("Config path used:", configPath);

        await invoke("vpn_connect", {
          configPath,
          username: DEFAULT_OVPN_USERNAME,
          password: DEFAULT_OVPN_PASSWORD,
        });
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

        <div className="px-6 pt-10 flex items-center justify-between relative z-10">
          <div className="flex items-center logo-container">
            <img
                src="/icons/dashboard-icon.svg"
                alt="Dashboard"
                className="h-20 w-20 inline-block"
            />
            <span className="text-[14px] font-semibold font-silka">Stellar VPN</span>
          </div>

          <div className="flex items-center gap-2">
            <button className="rounded-full bg-white px-3 py-1 text-[11px]">
            <span
                className={`font-semibold flex items-center gap-1 ${
                    subscription?.days_remaining === 0 ? "!text-red-500" : "text-[#00B252]"
                }`}
            >
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
              <img src="/icons/user.svg" alt="Profile" className="w-[25px] h-[25px]" />
            </button>
          </div>
        </div>

        <div className="px-6 mt-4 text-[11px] text-white/80 relative z-10">
          <span className="text-[#D6D6E0] text-[12px]">Device Name: </span>
          <span className="font-semibold text-[12px] text-white">
          {deviceName || "N/A"}
        </span>
        </div>

        <div className="px-6 mt-6 text-center">
          <div className="bg-[rgba(0,0,0,0.08)] inline-flex items-center gap-2 rounded-full px-4 pr-6 py-2 text-md text-white font-semibold backdrop-blur-[18px]">
            {isConnected ? (
                <>
                  <img src="/icons/secured.svg" alt="Secured" className="w-10 h-10" />
                  <span>Secured connection</span>
                </>
            ) : isConnecting ? (
                <span>Connecting...</span>
            ) : (
                <>
                  <img src="/icons/unsecured.svg" alt="Unsecured" className="w-10 h-10" />
                  <span>Unsecured connection</span>
                </>
            )}
          </div>
        </div>

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
            <div className="h-7 w-7 rounded-full flex items-center justify-center bg-white">
              <div
                  className={`h-4 w-4 rounded-full ${
                      isConnected ? "bg-emerald-400" : isConnecting ? "bg-[#62626A]" : "bg-[#E10000]"
                  }`}
              />
            </div>
          </div>
        </div>

        <div className="px-6 pb-10">
          <button
              type="button"
              onClick={() => navigate("/change-location")}
              className="mb-4 w-full rounded-full bg-white/10 px-5 py-4 text-xs flex items-center justify-between"
          >
            <div className="flex flex-col">
              <span className="text-[#D6D6E0] text-[12px]">Fastest Server</span>
              <span className="mt-1 text-sm font-semibold text-[#EAEAF0] flex items-center gap-2">
              <img src="/icons/flag.svg" alt="Flag" className="w-6 h-6 rounded-full" />
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
            {isConnected ? "Disconnect" : isConnecting ? "Connecting..." : "Connect"}
          </Button>

          {isTauri() && (
              <button
                  type="button"
                  className="mt-3 w-full rounded-full bg-white/10 px-5 py-3 text-xs text-[#EAEAF0]"
                  onClick={() => setShowLogs((v) => !v)}
              >
                {showLogs ? "Hide logs" : "Show logs"}
              </button>
          )}

          {showLogs && (
              <div className="mt-3 rounded-2xl bg-black/40 p-3 text-[11px] max-h-[180px] overflow-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white/80">OpenVPN logs</span>
                  <button className="text-white/70 hover:text-white" onClick={() => setVpnLogs([])}>
                    Clear
                  </button>
                </div>
                <pre className="whitespace-pre-wrap text-white/80 font-mono">
              {vpnLogs.length ? vpnLogs.join("\n") : "No logs yet..."}
            </pre>
              </div>
          )}
        </div>

        {showCongrats && (
            <div className="absolute inset-0 flex items-end justify-center bg-black/40 z-50">
              <div className="w-full bg-white rounded-t-3xl px-6 pt-6 pb-7 animate-slide-up">
                <div className="flex flex-col items-center">
                  <img src="/icons/green-tick.svg" alt="Success" className="w-12 h-12 mb-2" />

                  <h2 className="text-xl font-bold text-[#0B0C19] mb-2 font-poppins">
                    Congrats!
                  </h2>

                  <p className="text-sm text-[#62626A] mb-6 text-center font-poppins">
                    {accountNumber
                        ? "Here's your account number. Save it!"
                        : "Welcome! Your account has been created."}
                  </p>

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
                                  handleCopyAccount();
                                }}
                                className="flex items-center justify-center hover:opacity-80 transition-opacity"
                            >
                              <img src="/icons/copy.svg" alt="Copy" className="w-7 h-7" />
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
                  </div>

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
