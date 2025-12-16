import React, { useState } from "react";

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
};

export const TextInput: React.FC<Props> = ({ label, type, ...props }) => {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === "password";

  return (
    <label className="flex flex-col gap-2 text-sm text-slate-700">
      {label && <span className="font-medium">{label}</span>}
      <div className="relative">
      <input
          type={isPassword && showPassword ? "text" : type}
          className={`w-full rounded-[54px] bg-inputBg h-[52px] outline-none text-textDark placeholder:text-textDark ${
            isPassword ? "pl-6 pr-12" : "px-6"
          }`}
        {...props}
      />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center"
          >
            <div className="relative">
              <img
                src="/icons/hide.svg"
                alt={showPassword ? "Hide password" : "Show password"}
                className="w-5 h-5"
              />
              {showPassword && (
                <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-textDark transform -translate-y-1/2 rotate-45" />
              )}
            </div>
          </button>
        )}
      </div>
    </label>
  );
};
