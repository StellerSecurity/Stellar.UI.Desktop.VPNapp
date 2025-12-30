import React from "react";
import { useLocation } from "react-router-dom";

type Props = {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  onBack?: () => void;
  icon?: string;
};

export const AuthShell: React.FC<Props> = ({
  title,
  subtitle,
  children,
  onBack,
  icon,
}) => {
  const location = useLocation();
  const isChangeLocation = location.pathname === "/change-location";
  const isProfile = location.pathname === "/profile";
  const isSubscribe = location.pathname === "/subscribe";

  return (
    <div
      className={`h-full w-full flex flex-col ${
        isSubscribe ? "subscribe-container" : ""
      }`}
    >
      {isSubscribe ? (
        <div className="flex justify-center flex-col items-center mt-auto gap-4">
          <div className="flex items-center mt-20">
            <div className="overflow-hidden">
              <img
                src="/icons/logo.svg"
                alt="Stellar VPN Logo"
                className="h-14 w-14 object-contain"
              />
            </div>
            <span className="!text-white font-semibold text-md font-silka">
              Stellar VPN
            </span>
          </div>
          <div className="flex flex-col items-start gap-2 text-left w-full px-6">
            <h2 className="text-white text-[18px] font-bold font-poppins my-2">
              Get started with Stellar VPN!
            </h2>
            <div className="flex flex-col gap-5 mt-2">
              <div className="flex items-center gap-2">
                <img
                  src="/icons/world-check2.svg"
                  alt="Worldwide servers"
                  className="w-6 h-6 bg-transparent"
                />
                <span className="text-white text-sm font-poppins font-semibold">
                  Worldwide Server!
                </span>
              </div>
              <div className="flex items-center gap-2">
                <img
                  src="/icons/devices2.svg"
                  alt="Multi-device compatibility"
                  className="w-6 h-6 bg-transparent"
                />
                <span className="text-white text-sm font-poppins font-semibold">
                  Multi-device Compatibility!
                </span>
              </div>
              <div className="flex items-center gap-2">
                <img
                  src="/icons/no-file2.svg"
                  alt="No logging"
                  className="w-6 h-6 bg-transparent"
                />
                <span className="text-white text-sm font-poppins font-semibold">
                  No Logging
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex justify-center items-center mt-auto">
          <div className="flex items-center gap-3 mt-20">
            <div className="h-11 w-11 rounded-2xl bg-white flex items-center justify-center shadow-md overflow-hidden">
              <img
                src="/icons/logo.svg"
                alt="Stellar VPN Logo"
                className="h-full w-full object-contain"
              />
            </div>
            <span className="text-white font-semibold text-xl font-silka">
              Stellar VPN
            </span>
          </div>
        </div>
      )}

      <div
        className={`mt-auto relative bg-white rounded-t-[32px] px-6 pb-14 pt-10 ${
          isChangeLocation ? "change-location-special" : ""
        } ${isProfile ? "profile-special" : ""} ${
          isSubscribe ? "subscribe-special" : ""
        }`}
      >
        <div className="mb-6 relative back-btn">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className={`mr-2 flex items-center justify-center absolute ${
                isChangeLocation
                  ? "left-1 top-[4px]"
                  : isProfile
                  ? "left-5 top-[4px]"
                  : isSubscribe
                  ? "left-5 top-[4px]"
                  : "left-0 top-0"
              }`}
            >
              <img src="/icons/back.svg" alt="Back" className="w-4 h-5" />
            </button>
          )}
          <div
            className={`w-full ${
              isChangeLocation
                ? "text-left pl-4"
                : isProfile
                ? "text-left pl-4"
                : isSubscribe
                ? "text-left pl-4"
                : "text-center"
            }`}
          >
            {icon && (
              <div className="flex justify-center mb-4">
                <img src={icon} alt="Icon" className="w-11 h-11" />
              </div>
            )}
            {title && (
              <h1
                className={`text-xl ${
                  isChangeLocation
                    ? "font-normal pl-4"
                    : isProfile
                    ? "font-normal pl-[1.8rem]"
                    : isSubscribe
                    ? "font-normal pl-[1.8rem]"
                    : "font-bold"
                } text-slate-900`}
              >
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-1 block w-full text-center text-sm font-poppins font-normal text-textGray px-4">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
};
