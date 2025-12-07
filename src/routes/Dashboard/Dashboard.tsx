import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Status = "disconnected" | "connecting" | "connected";

export const Dashboard: React.FC = () => {
    const [status, setStatus] = useState<Status>("disconnected");
    const navigate = useNavigate();

    const isConnected = status === "connected";
    const isConnecting = status === "connecting";

    // Listen for events from Rust (vpn-status + vpn-log)
    useEffect(() => {
        let unlistenStatus: (() => void) | undefined;
        let unlistenLog: (() => void) | undefined;

        listen<string>("vpn-status", (event) => {
            const s = event.payload;
            if (s === "connected" || s === "connecting" || s === "disconnected") {
                setStatus(s as Status);
            } else if (s.startsWith("error")) {
                console.error("VPN error:", s);
                setStatus("disconnected");
            }
        }).then((fn) => {
            unlistenStatus = fn;
        });

        listen<string>("vpn-log", (event) => {
            // You can show these logs in the UI later – for now we just log to console
            console.log("[VPN]", event.payload);
        }).then((fn) => {
            unlistenLog = fn;
        });

        return () => {
            if (unlistenStatus) unlistenStatus();
            if (unlistenLog) unlistenLog();
        };
    }, []);

    const handleConnectToggle = async () => {
        try {
            if (status === "disconnected") {
                setStatus("connecting");

                await invoke("vpn_connect", {
                    configPath: "/home/bb/Hentet/stellar-vpn-desktop/japan.ovpn"
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
        <div className="h-full w-full flex flex-col text-white">
            {/* Header */}
            <div className="px-6 pt-10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-white flex items-center justify-center shadow">
                        <span className="text-[#256BFF] font-bold text-base">••</span>
                    </div>
                    <span className="text-base font-semibold">Stellar VPN</span>
                </div>
                <div className="flex items-center gap-3">
                    <button className="rounded-full bg-white/10 px-3 py-1 text-[11px]">
                        {isConnected ? "30 days" : "0 days"}
                    </button>
                    <button
                        className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center text-sm"
                        onClick={() => navigate("/profile")}
                    >
                        ☺
                    </button>
                </div>
            </div>

            <div className="px-6 mt-4 text-[11px] text-white/80">
                <span className="text-white/70">Device Name: </span>
                <span className="font-semibold">Winged Coral</span>
            </div>

            {/* Status pill */}
            <div className="px-6 mt-6">
                <div
                    className={`inline-flex items-center rounded-full px-4 py-2 text-xs font-medium ${
                        isConnected
                            ? "bg-emerald-500/20 text-emerald-100"
                            : isConnecting
                                ? "bg-blue-500/20 text-blue-100"
                                : "bg-red-500/20 text-red-100"
                    }`}
                >
                    {isConnected
                        ? "Secured connection"
                        : isConnecting
                            ? "Connecting..."
                            : "Unsecured connection"}
                </div>
            </div>

            {/* Center circle */}
            <div className="flex-1 flex items-center justify-center">
                <div className="h-32 w-32 rounded-full border-4 border-white/40 flex items-center justify-center">
                    <div
                        className={`h-20 w-20 rounded-full flex items-center justify-center ${
                            isConnected ? "bg-emerald-400" : "bg-red-500"
                        }`}
                    >
                        <div className="h-9 w-9 rounded-full bg-white" />
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
                        <span className="text-white/70">Fastest Server</span>
                        <span className="mt-1 text-sm font-semibold">Czechia</span>
                    </div>
                    <span className="text-white/70 text-lg">›</span>
                </button>
                <Button
                    fullWidth
                    variant={isConnected ? "danger" : "primary"}
                    className="text-sm"
                    onClick={handleConnectToggle}
                    disabled={isConnecting}
                >
                    {isConnected ? "Disconnect" : isConnecting ? "Connecting..." : "Connect"}
                </Button>
            </div>
        </div>
    );
};
