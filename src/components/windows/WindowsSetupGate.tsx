import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type WindowsSetupStatus = {
  supported: boolean;
  ready: boolean;
  openvpn_installed: boolean;
  helper_running: boolean;
  message: string;
};

type WindowsSetupGateProps = {
  children: React.ReactNode;
};

const readyStatus: WindowsSetupStatus = {
  supported: false,
  ready: true,
  openvpn_installed: true,
  helper_running: true,
  message: "Windows setup is not required on this platform.",
};

export const WindowsSetupGate: React.FC<WindowsSetupGateProps> = ({ children }) => {
  const [status, setStatus] = useState<WindowsSetupStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setIsChecking(true);
    setError(null);

    try {
      const nextStatus = await invoke<WindowsSetupStatus>("windows_setup_status");
      setStatus(nextStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(readyStatus);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const startSetup = useCallback(async () => {
    setIsSettingUp(true);
    setError(null);

    try {
      const nextStatus = await invoke<WindowsSetupStatus>("windows_setup_start");
      setStatus(nextStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refreshStatus();
    } finally {
      setIsSettingUp(false);
    }
  }, [refreshStatus]);

  const setupCopy = useMemo(() => {
    if (status?.message) return status.message;
    return "Stellar VPN needs one-time administrator permission to complete secure setup on Windows.";
  }, [status]);

  if (isChecking && status === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#F6F8FF] px-6">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 rounded-full border border-[#DCE5FF] border-t-[#2761FC] animate-spin" />
          <p className="font-silka text-[13px] text-[#5D6680]">Checking Windows setup...</p>
        </div>
      </div>
    );
  }

  if (!status || !status.supported || status.ready) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full w-full flex-col bg-[#F6F8FF] px-6 py-7 text-[#111827]">
      <div className="flex flex-1 flex-col justify-center">
        <div className="mb-7 flex justify-center">
          <div className="relative flex h-[78px] w-[78px] items-center justify-center rounded-[28px] bg-white shadow-[0_18px_45px_rgba(39,97,252,0.14)]">
            <div className="absolute inset-[10px] rounded-[22px] bg-[#EEF3FF]" />
            <svg
              className="relative h-9 w-9 text-[#2761FC]"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M12 3.25L18.75 6.25V11.25C18.75 15.45 16.1 19.35 12 20.75C7.9 19.35 5.25 15.45 5.25 11.25V6.25L12 3.25Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              <path
                d="M9.25 12.1L11.1 13.95L15.15 9.9"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        <p className="mb-3 text-center font-silka text-[11px] font-semibold uppercase tracking-[0.22em] text-[#2761FC]">
          Windows setup
        </p>
        <h1 className="mb-3 text-center font-silka text-[25px] font-semibold leading-[1.12] tracking-[-0.03em] text-[#111827]">
          Set up secure connection
        </h1>
        <p className="mx-auto mb-7 max-w-[245px] text-center font-silka text-[13px] leading-[1.55] text-[#5D6680]">
          To protect your traffic on Windows, Stellar VPN needs to install its secure connection components.
          This requires administrator permission once during setup.
        </p>

        <div className="mb-6 rounded-[26px] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
          <div className="space-y-3">
            <SetupItem label="Install the Stellar VPN helper" done={status.helper_running} />
            <SetupItem label="Install the Windows VPN engine" done={status.openvpn_installed} />
            <SetupItem label="Required only once" done />
            <SetupItem label="No permission prompts during normal connection" done />
          </div>
        </div>

        <p className="mb-5 min-h-[38px] rounded-[18px] bg-[#EEF3FF] px-4 py-3 text-center font-silka text-[12px] leading-[1.35] text-[#3D4B73]">
          {isSettingUp ? "Windows will show a system permission prompt. Accept it to finish setup." : setupCopy}
        </p>

        {error ? (
          <p className="mb-4 rounded-[16px] bg-[#FFECEC] px-4 py-3 text-center font-silka text-[12px] leading-[1.35] text-[#B42318]">
            {error}
          </p>
        ) : null}
      </div>

      <div className="pb-2">
        <button
          type="button"
          disabled={isSettingUp}
          onClick={() => void startSetup()}
          className="mb-3 flex h-[48px] w-full items-center justify-center rounded-full bg-[#2761FC] px-5 font-silka text-[14px] font-semibold text-white shadow-[0_14px_32px_rgba(39,97,252,0.28)] transition hover:bg-[#1F55E8] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isSettingUp ? "Setting up..." : "Continue"}
        </button>
        <button
          type="button"
          disabled={isSettingUp}
          onClick={() => void refreshStatus()}
          className="flex h-[42px] w-full items-center justify-center rounded-full font-silka text-[13px] font-semibold text-[#5D6680] transition hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-70"
        >
          Check again
        </button>
        <p className="mt-2 text-center font-silka text-[10px] leading-[1.35] text-[#8A93A8]">
          Windows controls the permission prompt. Stellar asks first so the setup is never unexpected.
        </p>
      </div>
    </div>
  );
};

const SetupItem: React.FC<{ label: string; done?: boolean }> = ({ label, done }) => (
  <div className="flex items-center gap-3">
    <div
      className={[
        "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border",
        done ? "border-[#2761FC] bg-[#2761FC]" : "border-[#D8DEF0] bg-white",
      ].join(" ")}
    >
      {done ? (
        <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.25L4.85 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <div className="h-2 w-2 rounded-full bg-[#D8DEF0]" />
      )}
    </div>
    <p className="font-silka text-[12.5px] leading-[1.25] text-[#2F3748]">{label}</p>
  </div>
);
