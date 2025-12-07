import React from "react";

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
};

export const TextInput: React.FC<Props> = ({ label, ...props }) => {
  return (
    <label className="flex flex-col gap-2 text-sm text-slate-700">
      {label && <span className="font-medium">{label}</span>}
      <input
        className="w-full rounded-full bg-slate-100 px-4 py-3 outline-none focus:ring-2 focus:ring-[#256BFF]"
        {...props}
      />
    </label>
  );
};
