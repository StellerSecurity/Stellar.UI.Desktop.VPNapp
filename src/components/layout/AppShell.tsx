import React from "react";

type Props = {
  children: React.ReactNode;
};

export const AppShell: React.FC<Props> = ({ children }) => {
  return (
    <div className="w-full max-w-5xl h-[620px] bg-gradient-to-b from-[#0646A9] to-[#02163e] rounded-3xl shadow-2xl overflow-hidden flex">
      {children}
    </div>
  );
};
