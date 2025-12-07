import React from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthShell
      title="Change location"
      subtitle="Select your preferred server"
      onBack={() => navigate("/dashboard")}
    >
      <div className="mb-4">
        <input
          placeholder="Search for country"
          className="w-full rounded-full bg-slate-100 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-[#256BFF]"
        />
      </div>
      <div className="space-y-3 max-h-80 overflow-auto pr-1 text-sm">
        <div className="bg-slate-50 rounded-2xl p-3">
          <div className="font-semibold mb-2">Fastest</div>
          <div className="text-slate-500">Automatically select the best server</div>
        </div>
        <div className="bg-slate-50 rounded-2xl p-3">
          <div className="font-semibold mb-1">Switzerland</div>
          <div className="pl-4">
            <div className="font-medium text-emerald-600 mb-1">Zurich</div>
            <ul className="space-y-1 text-slate-600 text-xs">
              <li>• se-mm-01235</li>
              <li>• se-mm-01236</li>
              <li>• se-mm-01237</li>
            </ul>
          </div>
        </div>
        <div className="bg-slate-50 rounded-2xl p-3">
          <div className="font-semibold mb-1">Germany</div>
          <div className="text-slate-500 text-xs">Berlin, Frankfurt and more</div>
        </div>
      </div>
    </AuthShell>
  );
};
