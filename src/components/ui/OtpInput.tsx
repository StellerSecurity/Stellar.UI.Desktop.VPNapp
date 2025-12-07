import React from "react";

type Props = {
  length?: number;
};

export const OtpInput: React.FC<Props> = ({ length = 4 }) => {
  const boxes = Array.from({ length });
  return (
    <div className="flex justify-between gap-3 my-4">
      {boxes.map((_, idx) => (
        <input
          key={idx}
          maxLength={1}
          className="w-12 h-12 rounded-full bg-slate-100 text-center text-lg font-semibold outline-none focus:ring-2 focus:ring-[#256BFF]"
        />
      ))}
    </div>
  );
};
