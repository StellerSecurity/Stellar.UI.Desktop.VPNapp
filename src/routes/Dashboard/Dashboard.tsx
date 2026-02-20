import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useConnection } from "../../contexts/ConnectionContext";
import { useSubscription } from "../../contexts/SubscriptionContext";
import {
  getAccountNumber,
  getSelectedServer,
  getDeviceName,
  fetchServerList,
  getAutoConnect,
  getVpnAuth,
} from "../../services/api";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VpnWorldMap } from "../../components/VpnWorldMap";

// OTA updater (Tauri)
import { check } from "@tauri-apps/plugin-updater";

const isTauri = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEFAULT_OVPN_URL =
    "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

const CONNECT_TIMEOUT_MS = 10_000;

type UiStatus = "disconnected" | "connecting" | "connected";

const normalizeStatus = (s: unknown): UiStatus | null => {
  if (typeof s !== "string") return null;
  if (s === "connected" || s === "connecting" || s === "disconnected") return s;
  return null;
};

// Local persisted flags (preferences, not secrets)
const LS_MANUAL_DISABLED = "vpn_manual_disabled";
const LS_HAS_CONNECTED_ONCE = "vpn_has_connected_once";

const lsGetBool = (key: string): boolean => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(key) === "1";
};

const lsSetBool = (key: string, v: boolean) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, v ? "1" : "0");
};

const Spinner: React.FC<{ className?: string }> = ({ className = "" }) => (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" aria-label="Loading">
      <circle
          className="opacity-20"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
      />
      <path
          className="opacity-80"
          fill="currentColor"
          d="M12 2a10 10 0 0 1 10 10h-4a6 6 0 0 0-6-6V2z"
      />
    </svg>
);

// Flag helper
const flagSrcForCountryCode = (cc?: string | null) => {
  const raw = (cc || "").trim().toLowerCase();
  if (!raw) return "/icons/flag.svg";

  const map: Record<string, string> = {
    uk: "gb",
  };

  const code = map[raw] || raw;
  return `/flags/${code}.svg`;
};

export const Dashboard: React.FC = () => {
  const { status, setStatus } = useConnection();
  const { subscription } = useSubscription();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();


  // Navigation flags
  const navState = (location.state as any) || {};
  const skipAutoConnect = navState?.skipAutoConnect === true;

  const [showCongrats, setShowCongrats] = useState(false);
  const [accountNumber, setAccountNumber] = useState<string | null>(null);

  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [selectedServerCountryCode, setSelectedServerCountryCode] = useState<string | null>(null);

  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  const [vpnLogs, setVpnLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [listenersReady, setListenersReady] = useState(false);

  const [showExpiredModal, setShowExpiredModal] = useState(false);

  // --- Mullvad-style update UI (manual install) ---
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);
  const [updateCmd, setUpdateCmd] = useState<string | null>(null);

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  // Treat expired as either explicit `expired === true` OR days_remaining <= 0
  const isExpired =
      (subscription as any)?.expired === true || (subscription?.days_remaining ?? 0) <= 0;

  // Focus country (temporary animation target when returning from ChangeLocation)
  const [focusCountryCode, setFocusCountryCode] = useState<string | null>(null);

  const [mapFocusCountryCode, setMapFocusCountryCode] = useState<string | null>(null);
  const [mapAnimateKey, setMapAnimateKey] = useState(0);

  const getSelectedConfigPath = (s: any): string => {
    const v = s?.configUrl ?? s?.config_url; // support both shapes
    return typeof v === "string" ? v.trim() : "";
  };

  // Clear skipAutoConnect state immediately so it never lingers
  useEffect(() => {
    if (!skipAutoConnect) return;
    navigate(location.pathname, { replace: true, state: {} });
  }, [skipAutoConnect, navigate, location.pathname]);

  useEffect(() => {
    const st = (location.state as any) || {};
    const cc = String(st?.focusCountryCode || "").trim().toUpperCase();

    if (!cc) return;

    setMapFocusCountryCode(cc);
    setMapAnimateKey((k) => k + 1);

    // After the fly-to, let selectedCountry take over again
    const t = window.setTimeout(() => setMapFocusCountryCode(null), 1400);
    return () => clearTimeout(t);
  }, [location.key]);

  // Keep latest status in a ref (avoids stale closure problems)
  const statusRef = useRef<UiStatus>("disconnected");
  useEffect(() => {
    statusRef.current = normalizeStatus(status) ?? "disconnected";
  }, [status]);

  // Manual disable + hasConnectedOnce refs (persisted)
  const manualDisabledRef = useRef<boolean>(lsGetBool(LS_MANUAL_DISABLED));
  const hasConnectedOnceRef = useRef<boolean>(lsGetBool(LS_HAS_CONNECTED_ONCE));

  const setManualDisabled = useCallback((v: boolean) => {
    manualDisabledRef.current = v;
    lsSetBool(LS_MANUAL_DISABLED, v);
  }, []);

  const setHasConnectedOnce = useCallback((v: boolean) => {
    hasConnectedOnceRef.current = v;
    lsSetBool(LS_HAS_CONNECTED_ONCE, v);
  }, []);

  const appendLog = useCallback((line: string) => {
    setVpnLogs((prev) => {
      const next = [...prev, line];
      return next.length > 250 ? next.slice(next.length - 250) : next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setVpnLogs([]);
    setConnectError(null);
  }, []);

  const copyLogs = useCallback(async () => {
    const text = ["=== Stellar VPN Logs ===", connectError ? `ERROR: ${connectError}` : "", ...vpnLogs]
        .filter(Boolean)
        .join("\n");

    try {
      await navigator.clipboard.writeText(text);
      appendLog("[ui] Logs copied to clipboard.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        appendLog("[ui] Logs copied to clipboard.");
      } catch {
        appendLog("[ui] Failed to copy logs.");
      }
      document.body.removeChild(ta);
    }
  }, [vpnLogs, connectError, appendLog]);

  const refreshSelectedServer = useCallback(async () => {
    const server = await getSelectedServer();
    setSelectedServerName(server?.name ?? null);
    setSelectedServerCountryCode(server?.countryCode ?? null);

    // ChangeLocation updates localStorage directly, so resync refs here
    manualDisabledRef.current = lsGetBool(LS_MANUAL_DISABLED);
    hasConnectedOnceRef.current = lsGetBool(LS_HAS_CONNECTED_ONCE);
  }, []);

  useEffect(() => {
    refreshSelectedServer();
  }, [location.key, refreshSelectedServer]);

  // Pick up focusCountryCode from navigation state (ChangeLocation -> Dashboard)
  useEffect(() => {
    const st = (location.state as any)?.focusCountryCode;
    if (typeof st === "string" && st.trim().length > 0) {
      setFocusCountryCode(st.trim());

      const t = window.setTimeout(() => setFocusCountryCode(null), 1400);
      return () => clearTimeout(t);
    }
  }, [location.key]);

  const syncBackendStatus = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const s = await invoke<string>("vpn_status");
      const ui = normalizeStatus(s);

      if (s.startsWith("error")) {
        console.error("VPN backend error:", s);
        setConnectError(s);
        setShowLogs(true);
        setStatus("disconnected");
      }
    } catch (e) {
      console.warn("vpn_status sync failed:", e);
    }
  }, [setStatus]);

  // Load account number, device name, and selected server
  useEffect(() => {
    const loadData = async () => {
      const account = await getAccountNumber();
      const device = await getDeviceName();
      setAccountNumber(account);
      setDeviceName(device);

      const server = await getSelectedServer();
      setSelectedServerName(server?.name ?? null);
      setSelectedServerCountryCode(server?.countryCode ?? null);

      const isNewUser =
          searchParams.get("newUser") === "true" && searchParams.get("oneClick") === "true";

      if (isNewUser) {
        setHasConnectedOnce(false);
        setManualDisabled(true);

        if (isTauri()) {
          try {
            await invoke("vpn_disconnect");
          } catch {
            // ignore
          }
        }

        setStatus("disconnected");
        setShowCongrats(true);
        setSearchParams({});
      }
    };

    loadData();
  }, [searchParams, setSearchParams, setStatus, setHasConnectedOnce, setManualDisabled]);

  // Prefetch server list
  useEffect(() => {
    fetchServerList().catch((err) => {
      console.warn("Failed to prefetch server list:", err);
    });
  }, []);

  // OTA update check (runs when user enters Dashboard)
  // Mullvad-style: show Update available, user installs manually (deb)
  const otaCheckedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;

    if (otaCheckedKeyRef.current === location.key) return;
    otaCheckedKeyRef.current = location.key;

    (async () => {
      try {
        setShowLogs(true);
        appendLog("[ui] Checking for updates...");

        const update = await check();

        appendLog(`[ui] check() finished. update=${update ? "YES" : "NO"}`);

        if (!update) {
          appendLog("[ui] No updates available.");
          setUpdateAvailable(false);
          setUpdateVersion(null);
          setUpdateUrl(null);
          setUpdateCmd(null);
          return;
        }

        const v = String(update.version ?? "").trim() || "unknown";

        const url = `https://desktopreleasesprod.stellarsecurity.com/vpn/${v}/Stellar%20VPN_${v}_amd64.deb`;

        const cmd =
            `cd /tmp && ` +
            `wget -O stellar-vpn.deb "${url}" && ` +
            `sudo apt-get install -y ./stellar-vpn.deb`;

        appendLog(`[ui] Update available: ${v}`);
        appendLog(`[ui] Download URL: ${url}`);
        appendLog("[ui] Waiting for user to install (manual).");

        setUpdateAvailable(true);
        setUpdateVersion(v);
        setUpdateUrl(url);
        setUpdateCmd(cmd);
      } catch (e: any) {
        const msg =
            typeof e === "string" ? e : e?.message ? String(e.message) : JSON.stringify(e);
        console.warn("Update check failed:", e);
        appendLog(`[ui] Update check failed: ${msg}`);
        setShowLogs(true);
      }
    })();
  }, [location.key, appendLog]);

  // Connect attempt tracking + watchdog (prevents infinite "Connecting...")
  const connectAttemptIdRef = useRef<number>(0);

  const startConnectWatchdog = useCallback(
      (attemptId: number) => {
        window.setTimeout(async () => {
          if (connectAttemptIdRef.current !== attemptId) return;
          if (statusRef.current !== "connecting") return;

          try {
            appendLog(`[ui] Connect watchdog fired after ${CONNECT_TIMEOUT_MS}ms`);
            await invoke("vpn_disconnect").catch(() => {});
          } finally {
            setConnectError("VPN connect timed out. Check OpenVPN logs and kill switch permissions.");
            setShowLogs(true);
            setStatus("disconnected");
            setManualDisabled(true);
          }
        }, CONNECT_TIMEOUT_MS);
      },
      [appendLog, setStatus, setManualDisabled]
  );

  const startConnect = useCallback(
      async (configPath: string) => {
        if (!isTauri()) return;

        connectAttemptIdRef.current += 1;
        const attemptId = connectAttemptIdRef.current;

        setConnectError(null);
        setShowLogs(true);
        setStatus("connecting");
        startConnectWatchdog(attemptId);

        appendLog(`[ui] Connecting using config: ${configPath}`);

        const vpnAuth = await getVpnAuth();

        if (!vpnAuth?.username || !vpnAuth?.password) {
          const msg = "Missing VPN credentials. Please log in again.";
          appendLog(`[ui] ${msg}`);
          setConnectError(msg);
          setShowLogs(true);
          setStatus("disconnected");
          setManualDisabled(true);
          return;
        }

        try {
          await invoke("vpn_connect", {
            configPath,
            username: vpnAuth.username,
            password: vpnAuth.password,
          });
        } catch (e: any) {
          const msg =
              typeof e === "string" ? e : e?.message ? String(e.message) : "Unknown error";

          appendLog(`[ui] vpn_connect failed: ${msg}`);
          setConnectError(msg);
          setShowLogs(true);
          setStatus("disconnected");
          setManualDisabled(true);
        }
      },
      [appendLog, setStatus, startConnectWatchdog, setManualDisabled]
  );

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

          if (ui === "connected") {
            setConnectError(null);
            setHasConnectedOnce(true);
            setManualDisabled(false);
          }

          return;
        }

        if (s.startsWith("error")) {
          console.error("VPN error:", s);
          setConnectError(s);
          setShowLogs(true);
          setStatus("disconnected");
        }
      });

      unlistenLog = await listen<string>("vpn-log", (event) => {
        appendLog(event.payload);
      });

      if (!mounted) return;

      setListenersReady(true);
      console.log('sync', 1);
      await syncBackendStatus();
    })();

    return () => {
      mounted = false;
      if (unlistenStatus) unlistenStatus();
      if (unlistenLog) unlistenLog();
    };
  }, [appendLog, setStatus, syncBackendStatus, setHasConnectedOnce, setManualDisabled]);

  // Tray events (Mullvad-style menu)
  const trayConnect = useCallback(async () => {
    if (!isTauri()) return;

    setManualDisabled(false);

    await syncBackendStatus();
    const current = statusRef.current;
    if (current === "connected" || current === "connecting") return;

    if (isExpired) {
      setShowExpiredModal(true);
      return;
    }

    const selectedServer = await getSelectedServer();
    const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

    await startConnect(configPath);
  }, [startConnect, syncBackendStatus, setManualDisabled, isExpired]);

  const trayDisconnect = useCallback(async () => {
    if (!isTauri()) return;

    setManualDisabled(true);

    await invoke("vpn_disconnect").catch(() => {});
    setStatus("disconnected");
  }, [setStatus, setManualDisabled]);

  const trayReconnect = useCallback(async () => {
    if (!isTauri()) return;

    setManualDisabled(false);

    if (isExpired) {
      setShowExpiredModal(true);
      return;
    }

    await invoke("vpn_disconnect").catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    const selectedServer = await getSelectedServer();
    const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

    await startConnect(configPath);
  }, [startConnect, setManualDisabled, isExpired]);

  useEffect(() => {
    if (!isTauri()) return;

    let unlistenConnect: (() => void) | undefined;
    let unlistenDisconnect: (() => void) | undefined;
    let unlistenReconnect: (() => void) | undefined;

    (async () => {
      unlistenConnect = await listen("tray-connect", () => {
        trayConnect().catch((e) => console.error("tray-connect failed:", e));
      });

      unlistenDisconnect = await listen("tray-disconnect", () => {
        trayDisconnect().catch((e) => console.error("tray-disconnect failed:", e));
      });

      unlistenReconnect = await listen("tray-reconnect", () => {
        trayReconnect().catch((e) => console.error("tray-reconnect failed:", e));
      });
    })();

    return () => {
      if (unlistenConnect) unlistenConnect();
      if (unlistenDisconnect) unlistenDisconnect();
      if (unlistenReconnect) unlistenReconnect();
    };
  }, [trayConnect, trayDisconnect, trayReconnect]);

  // connectNow runs once per navigation, then clears state
  const connectNowHandledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    if (!listenersReady) return;

    const st = (location.state as any) || {};
    if (st?.connectNow !== true) return;

    if (connectNowHandledKeyRef.current === location.key) return;
    connectNowHandledKeyRef.current = location.key;

    navigate(location.pathname, { replace: true, state: {} });

    (async () => {
      await syncBackendStatus();

      if (isExpired) {
        setShowExpiredModal(true);
        return;
      }

      setManualDisabled(false);

      const selectedServer = await getSelectedServer();
      const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

      const current = statusRef.current;
      if (current === "connected" || current === "connecting") {
        await invoke("vpn_disconnect").catch(() => {});
        setStatus("disconnected");
        await new Promise((r) => setTimeout(r, 250));
      }

      await startConnect(configPath);
    })().catch((e) => console.error("connectNow failed:", e));
  }, [
    location.key,
    location.pathname,
    listenersReady,
    syncBackendStatus,
    startConnect,
    setManualDisabled,
    isExpired,
    setStatus,
    navigate,
  ]);

  // Auto-connect (blocked when skipAutoConnect is set)
  useEffect(() => {
    if (!isTauri()) return;
    if (!listenersReady) return;
    if (skipAutoConnect) return;

    let cancelled = false;

    (async () => {
      try {
        const isNewUser = searchParams.get("newUser") === "true";
        if (isNewUser) return;

        const autoConnectEnabled = await getAutoConnect();
        if (!autoConnectEnabled || cancelled) return;

        if (manualDisabledRef.current) return;
        if (!hasConnectedOnceRef.current) return;
        if (isExpired) return;

        const backend = await invoke<string>("vpn_status").catch(() => "");
        const backendUi = normalizeStatus(backend);
        const current = backendUi ?? statusRef.current;

        if (current === "connecting") return;
        if (current !== "disconnected") return;

        const selectedServer = await getSelectedServer();
        const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

        await startConnect(configPath);
      } catch (error) {
        console.error("Auto connect failed:", error);
        if (!cancelled) setStatus("disconnected");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [listenersReady, searchParams, setStatus, startConnect, isExpired, skipAutoConnect]);

  // Reconnect on unexpected drops (blocked when skipAutoConnect is set)
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    if (!listenersReady) return;
    if (skipAutoConnect) return;

    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    if (statusRef.current !== "disconnected") return;

    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const isNewUser = searchParams.get("newUser") === "true";
        if (isNewUser) return;

        const autoConnectEnabled = await getAutoConnect();
        if (!autoConnectEnabled || cancelled) return;

        if (manualDisabledRef.current) return;
        if (!hasConnectedOnceRef.current) return;
        if (isExpired) return;

        const backend = await invoke<string>("vpn_status").catch(() => "");
        const backendUi = normalizeStatus(backend) ?? statusRef.current;
        if (backendUi !== "disconnected") return;

        const selectedServer = await getSelectedServer();
        const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

        await startConnect(configPath);
      } catch {
        // ignore
      }
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [status, listenersReady, searchParams, startConnect, isExpired, skipAutoConnect]);

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

  const handleConnectToggle = async () => {
    if (!isTauri()) {
      if (status === "disconnected") {
        if (isExpired) {
          setShowExpiredModal(true);
          return;
        }
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
        if (isExpired) {
          setShowExpiredModal(true);
          return;
        }

        setManualDisabled(false);

        const selectedServer = await getSelectedServer();
        const configPath = getSelectedConfigPath(selectedServer) || DEFAULT_OVPN_URL;

        await startConnect(configPath);
      } else {
        await invoke("vpn_disconnect").catch(() => {});
        setManualDisabled(true);
        setStatus("disconnected");
      }
    } catch (e) {
      console.error("VPN connect error:", e);
      setStatus("disconnected");
    }
  };

  const copyUpdateCommand = useCallback(async () => {
    if (!updateCmd) return;
    try {
      await navigator.clipboard.writeText(updateCmd);
      appendLog("[ui] Update command copied to clipboard.");
      setShowLogs(true);
    } catch {
      appendLog("[ui] Failed to copy update command.");
      setShowLogs(true);
    }
  }, [updateCmd, appendLog]);

  const openUpdateUrl = useCallback(async () => {
    if (!updateUrl) return;

    try {
      window.open(updateUrl, "_blank", "noopener,noreferrer");
      appendLog("[ui] Opened download URL.");
      setShowLogs(true);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message ? String(e.message) : JSON.stringify(e);
      appendLog(`[ui] Failed to open URL: ${msg}`);
      setShowLogs(true);
    }
  }, [updateUrl, appendLog]);

  return (
      <div className="w-[312px] h-[640px] overflow-hidden relative bg-[#0037A3]">
        {/* Map background */}
        <div className="absolute inset-0 z-0">
          <div className="absolute inset-0 bg-[#0037A3]" />

          <div className="absolute inset-0 opacity-[1] scale-[1.02]">
            <VpnWorldMap
                height={640}
                focusCountryCode={focusCountryCode}
                selectedCountryCode={selectedServerCountryCode}
                animateKey={mapAnimateKey}
                connectionStatus={status}
            />
          </div>

          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(255,255,255,0.08),rgba(0,0,0,0.22)_58%,rgba(0,0,0,0.45)_100%)]" />
        </div>

        {/* Status gradient overlay */}
        <div
            className={`absolute top-0 left-0 w-full h-[280px] z-10 ${
                isConnected
                    ? "bg-[linear-gradient(to_bottom,rgba(0,178,82,0.62)_0%,rgba(0,178,82,0)_100%)]"
                    : isConnecting
                        ? "bg-[linear-gradient(to_bottom,rgba(11,12,25,0.55)_0%,rgba(11,12,25,0)_100%)]"
                        : "bg-[linear-gradient(to_bottom,rgba(225,0,0,0.60)_0%,rgba(225,0,0,0)_100%)]"
            }`}
        />

        {/* Foreground content */}
        <div className="relative z-20 h-full w-full flex flex-col text-white">
          {/* Header */}
          <div className="px-6 pt-10 flex items-center justify-between">
            <div className="flex items-center logo-container">
              <img src="/icons/dashboard-icon.svg" alt="Dashboard" className="h-20 w-20 inline-block" />
              <span className="text-[14px] font-semibold font-silka">Stellar VPN</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                  className="rounded-full bg-white px-3 py-1 text-[11px]"
                  onClick={() => navigate("/profile")}
                  type="button"
              >
              <span
                  className={`font-semibold flex items-center gap-1 ${
                      (subscription?.days_remaining ?? 0) === 0 ? "!text-red-500" : "text-[#00B252]"
                  }`}
              >
                {subscription?.days_remaining !== undefined ? `${subscription.days_remaining} days` : "0 days"}
              </span>
              </button>

              <button
                  className="rounded-full flex items-center justify-center"
                  onClick={() => navigate("/profile")}
                  type="button"
              >
                <img src="/icons/user.svg" alt="Profile" className="w-[25px] h-[25px]" />
              </button>
            </div>
          </div>

          <div className="px-6 mt-4 text-[11px] text-white/80">
            <span className="text-[#D6D6E0] text-[12px]">Device Name: </span>
            <span className="font-semibold text-[12px] text-white">{deviceName || "N/A"}</span>
          </div>

          {/* Status pill */}
          <div className="px-6 mt-6 text-center">
            <div className="bg-[rgba(0,0,0,0.10)] inline-flex items-center gap-2 rounded-full px-4 pr-6 py-2 text-md text-white font-semibold backdrop-blur-[18px]">
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

          {/* Center circle */}
          <div className="flex-1 flex items-center justify-center">
            <div className="relative h-24 w-24 flex items-center justify-center">
              <div
                  className={`absolute inset-0 rounded-full blur-md ${
                      isConnected
                          ? "bg-emerald-400/25 animate-ring-pulse motion-reduce:animate-none"
                          : isConnecting
                              ? "bg-[#62626A]/25 animate-ring-breathe motion-reduce:animate-none"
                              : "bg-[#E10000]/20"
                  }`}
              />

              <div
                  className={`relative h-20 w-20 rounded-full flex items-center justify-center ${
                      isConnected
                          ? "bg-[radial-gradient(circle,rgba(0,178,82,0)_0%,rgba(0,178,82,0)_40%,rgba(0,178,82,0.6)_100%)] animate-ring-pulse motion-reduce:animate-none"
                          : isConnecting
                              ? "bg-[radial-gradient(circle,rgba(98,98,106,0)_0%,rgba(98,98,106,0)_40%,rgba(98,98,106,1)_100%)] animate-ring-breathe motion-reduce:animate-none"
                              : "bg-[radial-gradient(circle,rgba(225,0,0,0)_0%,rgba(225,0,0,0)_40%,rgba(225,0,0,0.6)_100%)]"
                  }`}
              >
                <div className="h-9 w-9 rounded-full flex items-center justify-center bg-white">
                  <div
                      className={`h-5 w-5 rounded-full ${
                          isConnected
                              ? "bg-emerald-400 animate-dot-beat motion-reduce:animate-none"
                              : isConnecting
                                  ? "bg-[#62626A] animate-dot-beat motion-reduce:animate-none"
                                  : "bg-[#E10000]"
                      }`}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Fastest server card + connect button */}
          <div className="px-6 pb-15">
            <button
                type="button"
                onClick={() => navigate("/change-location")}
                className="mb-4 w-full rounded-full bg-white/10 px-5 py-4 text-xs flex items-center justify-between hover:bg-white/15 transition-colors"
            >
              <div className="flex flex-col">
                <span className="text-[#D6D6E0] text-[12px]">Fastest Server</span>
                <span className="mt-1 text-sm font-semibold text-[#EAEAF0] flex items-center gap-2">
                <img
                    src={flagSrcForCountryCode(selectedServerCountryCode)}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src = "/icons/flag.svg";
                    }}
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
                    isConnecting && "!bg-white border !disabled:opacity-100 border-gray-300 !text-gray-500"
                }`}
                onClick={handleConnectToggle}
                disabled={isConnecting}
            >
              {isConnected ? (
                  "Disconnect"
              ) : isConnecting ? (
                  <span className="inline-flex items-center justify-center gap-2">
                <Spinner className="w-4 h-4" />
                <span>Connecting</span>
              </span>
              ) : (
                  "Connect"
              )}
            </Button>
          </div>

          {/* Congrats Modal */}
          {showCongrats && (
              <div className="absolute inset-0 flex items-end justify-center bg-black/40 z-50">
                <div className="w-full bg-white rounded-t-3xl px-6 pt-6 pb-12 animate-slide-up">
                  <div className="flex flex-col items-center">
                    <img src="/icons/green-tick.svg" alt="Success" className="w-12 h-12 mb-2" />

                    <h2 className="text-xl font-bold text-[#0B0C19] mb-2 font-poppins">Congrats!</h2>

                    <p className="text-sm text-[#62626A] mb-6 text-center font-poppins">
                      {accountNumber ? "Here's your account number. Save it!" : "Welcome! Your account has been created."}
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

                    <Button fullWidth onClick={() => setShowCongrats(false)} className="h-[42px] text-base font-poppins">
                      Got It
                    </Button>
                  </div>
                </div>
              </div>
          )}

          {/* Expired Modal */}
          {showExpiredModal && (
              <div className="absolute inset-0 flex items-end justify-center bg-black/40 z-50">
                <div className="w-full bg-white rounded-t-3xl px-6 pt-6 pb-12 animate-slide-up">
                  <div className="flex flex-col items-center text-center">
                    <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-3">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-red-500">
                        <path
                            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
                         10-4.48 10-10S17.52 2 12 2Zm3.54 13.54-1.41 1.41L12 13.41
                         9.88 16.95l-1.41-1.41L10.59 12 8.47 9.88l1.41-1.41L12 10.59
                         l2.12-2.12 1.41 1.41L13.41 12l2.13 3.54Z"
                            fill="currentColor"
                        />
                      </svg>
                    </div>

                    <h2 className="text-xl font-bold text-[#0B0C19] mb-2 font-poppins">Subscription expired</h2>

                    <p className="text-sm text-[#62626A] mb-6 font-poppins">
                      No time available. Renew your plan to connect.
                    </p>

                    <Button fullWidth onClick={() => setShowExpiredModal(false)} className="h-[42px] text-base font-poppins">
                      OK
                    </Button>
                  </div>
                </div>
              </div>
          )}
        </div>

        {/* Update Modal (manual .deb install) */}
        {updateAvailable && updateVersion && updateUrl && updateCmd && (
            <div className="absolute inset-0 z-[998] bg-black/50 flex items-end justify-center">
              <div className="w-full bg-white rounded-t-3xl px-6 pt-6 pb-8">
                <div className="flex items-start justify-between">
                  <div className="pr-4">
                    <div className="text-[#0B0C19] font-bold text-[16px]">Update available</div>
                    <div className="text-[#62626A] text-[12px] mt-1">
                      Version <span className="font-semibold">{updateVersion}</span> is ready. Install it in terminal.
                    </div>
                  </div>

                  <button
                      type="button"
                      onClick={() => setUpdateAvailable(false)}
                      className="text-[#0B0C19] text-[12px] px-3 py-1 rounded-full bg-black/5 hover:bg-black/10 transition-colors"
                  >
                    Close
                  </button>
                </div>

                <div className="mt-4 rounded-2xl bg-[#0B0C19] text-white px-4 py-3">
                  <div className="text-[11px] text-white/70 mb-2">Run this:</div>
                  <pre className="text-[11px] whitespace-pre-wrap break-words leading-relaxed">{updateCmd}</pre>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                      type="button"
                      onClick={() => openUpdateUrl()}
                      className="flex-1 rounded-full bg-[#0B0C19] hover:bg-black text-white px-4 py-2 text-[12px] transition-colors"
                  >
                    Open download
                  </button>

                  <button
                      type="button"
                      onClick={() => copyUpdateCommand()}
                      className="flex-1 rounded-full bg-black/5 hover:bg-black/10 text-[#0B0C19] px-4 py-2 text-[12px] transition-colors"
                  >
                    Copy command
                  </button>
                </div>

                <div className="mt-3 text-[11px] text-[#62626A]">
                  Tip: users can paste it into Terminal. The app does not install updates automatically.
                </div>
              </div>
            </div>
        )}

        {/* Logs Panel */}
        {showLogs && (
            <div className="absolute inset-x-0 bottom-0 z-[997] bg-[#0B0C19] text-white rounded-t-3xl px-4 pt-4 pb-4 max-h-[55%] flex flex-col shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="text-[13px] font-semibold">Connection Logs</div>
                <div className="flex items-center gap-2">
                  <button
                      onClick={copyLogs}
                      className="text-[11px] px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 transition"
                  >
                    Copy
                  </button>
                  <button
                      onClick={clearLogs}
                      className="text-[11px] px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 transition"
                  >
                    Clear
                  </button>
                  <button
                      onClick={() => setShowLogs(false)}
                      className="text-[11px] px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 transition"
                  >
                    Close
                  </button>
                </div>
              </div>

              {/* Error */}
              {connectError && <div className="mb-2 text-[11px] text-red-400">ERROR: {connectError}</div>}

              {/* Log Output */}
              <div className="flex-1 overflow-y-auto bg-black/40 rounded-xl p-3 text-[11px] font-mono leading-relaxed space-y-1">
                {vpnLogs.length === 0 ? (
                    <div className="text-white/50">No logs yet…</div>
                ) : (
                    vpnLogs.map((line, i) => (
                        <div key={i} className="break-words">
                          {line}
                        </div>
                    ))
                )}
              </div>
            </div>
        )}
      </div>
  );
};