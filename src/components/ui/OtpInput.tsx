import React, { useState, useRef, useEffect } from "react";

type Props = {
  length?: number;
  value?: string;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
};

export const OtpInput: React.FC<Props> = ({
  length = 6,
  value: controlledValue,
  onChange,
  onComplete,
}) => {
  const [internalValue, setInternalValue] = useState("");
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const isControlled = controlledValue !== undefined;

  const value = isControlled ? controlledValue : internalValue;

  useEffect(() => {
    inputRefs.current = inputRefs.current.slice(0, length);
  }, [length]);

  const handleChange = (index: number, char: string) => {
    // Only allow numeric characters
    if (char && !/^\d$/.test(char)) {
      return;
    }

    const newValue = value.split("");
    newValue[index] = char;
    const updatedValue = newValue.join("").slice(0, length);

    if (!isControlled) {
      setInternalValue(updatedValue);
    }
    onChange?.(updatedValue);

    // Move to next input
    if (char && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Trigger onComplete when all digits are entered
    if (updatedValue.length === length) {
      onComplete?.(updatedValue);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    
    if (!isControlled) {
      setInternalValue(pastedData);
    }
    onChange?.(pastedData);

    // Focus the next empty input or the last one
    const nextIndex = Math.min(pastedData.length, length - 1);
    inputRefs.current[nextIndex]?.focus();

    if (pastedData.length === length) {
      onComplete?.(pastedData);
    }
  };

  return (
    <div className="flex justify-between gap-3 my-4">
      {Array.from({ length }).map((_, idx) => (
        <input
          key={idx}
          ref={(el) => (inputRefs.current[idx] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[idx] || ""}
          onChange={(e) => handleChange(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={handlePaste}
          className="w-[22%] h-12 rounded-[54px] bg-inputBg text-center text-sm font-normal outline-none text-textDark focus:bg-transparent focus:border focus:border-[#2761FC]"
        />
      ))}
    </div>
  );
};
