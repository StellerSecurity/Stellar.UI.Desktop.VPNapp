import React from "react";

type Props = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
};

export const AuthShell: React.FC<Props> = ({
  title,
  subtitle,
  children,
  onBack
}) => {
  return (
    <div className="h-full w-full flex flex-col">
      {/* Top logo */}
      <div className="px-6 pt-12">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-white flex items-center justify-center shadow-md">
            <span className="text-[#256BFF] font-bold text-lg">••</span>
          </div>
          <span className="text-white font-semibold text-lg">Stellar VPN</span>
        </div>
      </div>

      {/* Bottom sheet card */}
      <div className="mt-auto bg-white rounded-t-[32px] px-6 pb-8 pt-6 shadow-[0_-10px_40px_rgba(0,0,0,0.25)]">
        <div className="flex items-center mb-6">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mr-2 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-500 text-lg"
            >
              ‹
            </button>
          )}
          <div className="flex-1 text-center">
            <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
          {onBack && <div className="w-9" />}
        </div>
        {children}
      </div>
    </div>
  );
};
