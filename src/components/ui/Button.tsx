import React from "react";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "danger";
  fullWidth?: boolean;
};

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = "primary",
  fullWidth,
  className = "",
  ...props
}) => {
  const base =
    "inline-flex items-center justify-center rounded-full px-6 h-[42px] text-sm font-poppins font-semibold transition disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    primary: "bg-[#2761FC] text-white hover:bg-[#1e56cc]",
    outline:
      "border border-[#2761FC] text-[#2761FC] bg-white hover:bg-[#eef3ff]",
    danger: "bg-[#FF3B30] text-white hover:bg-[#d63129]",
  };

  return (
    <button
      className={[
        base,
        variants[variant] ?? variants.primary,
        fullWidth ? "w-full" : "",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
};
