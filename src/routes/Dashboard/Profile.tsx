import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const [showLogout, setShowLogout] = useState(false);
  const [autoConnect, setAutoConnect] = useState(true);

  return (
    <AuthShell title="Profile" onBack={() => navigate("/dashboard")}>
      <div className="space-y-4 flex-1 flex flex-col">
        <div className="px-6 flex flex-col gap-4">
          <div className="bg-white rounded-2xl p-4 text-sm">
            <div className="flex justify-between items-center mb-2">
              <div>
                <div className="text-[12px] font-normal text-[#62626A] mb-1">
                  Account Name / Number
                </div>
                <div className="text-[14px] font-semibold text-[#0B0C19]">
                  6049 9111 1433 1221
                </div>
              </div>
              <button className="text-xs flex items-center gap-2">
                <img src="/icons/copy.svg" alt="Copy" className="w-6 h-6" />
              </button>
            </div>
            <div className="text-[12px] font-normal text-[#62626A] mb-1">
              Device name:
            </div>
            <div className="text-[14px] text-[#0B0C19] font-semibold">
              Winged Coral
            </div>
            <div className="text-[12px] text-[#62626A] mt-3 pt-3 border-t border-[#EAEAF0]">
              Available for <span className="text-[#2761FC]">5</span> devices
            </div>
          </div>

          <div className="bg-white rounded-2xl flex-col p-4 text-sm flex items-center justify-between">
            <div className="w-full">
              <div className="text-xs text-[#62626A] mb-2">Expires</div>
              <div className="flex items-center justify-between mb-2 w-full">
                <div className="font-medium text-emerald-600">In 30 days</div>
                <div className="text-sm text-[#62626A]">2024.04.04</div>
              </div>
            </div>
            <Button
              className="text-base w-full mt-2"
              onClick={() => navigate("/subscribe")}
            >
              Add more days
            </Button>
          </div>
        </div>

        <div className="px-5 mt-10 bg-white rounded-2xl flex-1 pt-6 pb-6">
          <div className="flex items-center justify-between text-sm mb-6 pb-6 border-b border-[#EAEAF0]">
            <span className="text-[14px] font-semibold text-[#0B0C19] flex items-center gap-2">
              <img src="/icons/network.svg" alt="Network" className="w-8 h-8" />
              Auto connect
            </span>
            <button
              type="button"
              onClick={() => setAutoConnect(!autoConnect)}
              className={`w-[53px] h-[32px] rounded-full flex items-center px-1 transition-colors ${
                autoConnect ? "bg-[#2761FC]" : "bg-gray-300"
              }`}
            >
              <span
                className={`w-[26px] h-[26px] rounded-full bg-white flex items-center justify-center transition-transform ${
                  autoConnect ? "translate-x-5" : "translate-x-0"
                }`}
              >
                {autoConnect && (
                  <img
                    src="/icons/blue-tick.svg"
                    alt="Tick"
                    className="w-3 h-3"
                  />
                )}
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowLogout(true)}
            className="text-sm text-[#62626A] flex items-center gap-3 pl-2"
          >
            <img src="/icons/logout.svg" alt="Logout" className="w-6 h-6" />
            <span className="text-[14px] font-semibold text-[#62626A]">
              Logout
            </span>
          </button>
        </div>
      </div>

      {showLogout && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="text-center rounded-2xl pt-12 pb-8 px-6 w-full max-w-[345px] logout-screen bg-[#F6F6FD]">
            <img
              src="/icons/logout.svg"
              alt="Logout"
              className="w-8 h-8 mx-auto mb-4"
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
                onClick={() => navigate("/welcome")}
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
