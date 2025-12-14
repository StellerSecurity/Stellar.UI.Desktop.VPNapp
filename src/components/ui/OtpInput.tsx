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
          className="w-[22%] h-12 rounded-[54px] bg-inputBg text-center text-sm font-normal outline-none text-textDark focus:bg-transparent focus:border focus:border-[#2761FC]"
        />
      ))}
    </div>
  );
};
