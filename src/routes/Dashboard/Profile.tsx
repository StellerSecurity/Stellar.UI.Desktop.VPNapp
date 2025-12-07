import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const [showLogout, setShowLogout] = useState(false);

  return (
    <AuthShell
      title="Profile"
      subtitle="Manage your Stellar VPN account"
      onBack={() => navigate("/dashboard")}
    >
      <div className="space-y-4">
        <div className="bg-slate-50 rounded-2xl p-4 text-sm">
          <div className="flex justify-between items-center mb-2">
            <div>
              <div className="text-xs text-slate-500">Account number</div>
              <div className="font-semibold">6049 9111 1433 1221</div>
            </div>
            <button className="text-xs text-[#256BFF]">Copy</button>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Device name: <span className="font-medium">Winged Coral</span>
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Available for <span className="font-medium">5 devices</span>.
          </div>
        </div>

        <div className="bg-slate-50 rounded-2xl p-4 text-sm flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500">Expires</div>
            <div className="font-medium text-emerald-600">In 30 days</div>
            <div className="text-xs text-slate-400">2024.04.04</div>
          </div>
          <Button onClick={() => navigate("/subscribe")}>Add more days</Button>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span>Auto connect</span>
          <button className="w-12 h-7 rounded-full bg-[#256BFF] flex items-center px-1">
            <span className="w-5 h-5 rounded-full bg-white translate-x-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowLogout(true)}
          className="text-sm text-red-500"
        >
          Logout
        </button>
      </div>

      {showLogout && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-semibold mb-2">Log out</h2>
            <p className="text-sm text-slate-500 mb-4">
              Are you sure you want to log out?
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className="text-sm text-slate-500"
                onClick={() => setShowLogout(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="text-sm text-[#256BFF] font-semibold"
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
