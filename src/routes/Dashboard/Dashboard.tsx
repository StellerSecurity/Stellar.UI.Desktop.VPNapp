import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { useConnection } from "../../contexts/ConnectionContext";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Check if running in Tauri
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const Dashboard: React.FC = () => {
  const { status, setStatus, isConnected } = useConnection();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCongrats, setShowCongrats] = useState(false);

  const isConnecting = status === "connecting";

  // Check if user just registered
  useEffect(() => {
    if (searchParams.get("newUser") === "true") {
      setShowCongrats(true);
      // Remove query param from URL
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  const handleCopyAccount = () => {
    const accountNumber = "6049 9111 1433 1221";
    navigator.clipboard.writeText(accountNumber).then(() => {
      // You could add a toast notification here if needed
    });
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

        await invoke("vpn_connect", {
          configPath: "/home/bb/Hentet/stellar-vpn-desktop/japan.ovpn",
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

      {/* Header */}
      <div className="px-6 pt-10 flex items-center justify-between relative z-10">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-white flex items-center justify-center shadow overflow-hidden">
            <img
              src="/icons/dashboard-icon.svg"
              alt="Dashboard"
              className="h-full w-full object-contain"
            />
          </div>
          <span className="text-sm font-semibold font-silka">Stellar VPN</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="rounded-full bg-white px-3 py-1 text-[12px]">
            <span className="text-[#00B252] font-semibold">
              {isConnected ? "30 days" : "0 days"}
            </span>
          </button>
          <button
            className="rounded-full flex items-center justify-center"
            onClick={() => navigate("/profile")}
          >
            <img
              src="/icons/user.svg"
              alt="Profile"
              className="w-[20px] h-[20px]"
            />
          </button>
        </div>
      </div>

      <div className="px-6 mt-4 text-[11px] text-white/80 relative z-10">
        <span className="text-[#D6D6E0] text-[12px]">Device Name: </span>
        <span className="font-semibold text-[12px] text-white">
          Winged Coral
        </span>
      </div>

      {/* Status pill */}
      <div className="px-6 mt-6 text-center">
        <div className="bg-[rgba(0,0,0,0.08)] inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs text-white font-semibold backdrop-blur-[18px]">
          {isConnected ? (
            <>
              <img src="/icons/secured.svg" alt="Secured" className="w-6 h-6" />
              <span>Secured connection</span>
            </>
          ) : isConnecting ? (
            <span>Connecting...</span>
          ) : (
            <>
              <img
                src="/icons/unsecured.svg"
                alt="Unsecured"
                className="w-6 h-6"
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
              Czechia
            </span>
          </div>
          <img src="/icons/right-arrow.svg" alt="Arrow" className="w-5 h-4" />
        </button>
        <Button
          fullWidth
          variant={isConnected ? "danger" : "primary"}
          className={`!text-[16px] h-[54px] ${
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

      {/* Congrats Modal */}
      {showCongrats && (
        <div className="absolute inset-0 flex items-end justify-center bg-black/40 z-50">
          <div className="w-full bg-white rounded-t-3xl px-6 pt-8 pb-10 animate-slide-up">
            <div className="flex flex-col items-center">
              {/* Green checkmark icon */}
              <img
                src="/icons/green-tick.svg"
                alt="Success"
                className="w-10 h-10 mb-4"
              />

              {/* Heading */}
              <h2 className="text-xl font-bold text-[#0B0C19] mb-2 font-poppins">
                Congrats!
              </h2>

              {/* Subtitle */}
              <p className="text-sm text-[#62626A] mb-6 text-center font-poppins">
                Here&apos;s your account number. Save it!
              </p>

              {/* Account Number Input */}
              <div className="w-full mb-6">
                <div className="text-[12px] font-normal text-[#62626A] mb-2 font-poppins">
                  Account Name / Number
                </div>
                <div className="flex items-center gap-2 bg-[#EAEAF0] rounded-2xl px-4 py-3">
                  <span className="flex-1 text-[14px] font-semibold text-[#0B0C19] font-poppins">
                    6049 9111 1433 1221
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyAccount}
                    className="flex items-center justify-center"
                  >
                    <img src="/icons/copy.svg" alt="Copy" className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Got It Button */}
              <Button
                fullWidth
                onClick={() => setShowCongrats(false)}
                className="h-[52px] text-base font-poppins"
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
