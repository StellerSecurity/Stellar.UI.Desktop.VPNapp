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
    "inline-flex items-center justify-center rounded-full px-6 py-3 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    primary: "bg-[#256BFF] text-white hover:bg-[#1e56cc]",
    outline:
      "border border-[#256BFF] text-[#256BFF] bg-white hover:bg-[#eef3ff]",
    danger: "bg-[#FF3B30] text-white hover:bg-[#d63129]"
  };

  return (
    <button
      className={[
        base,
        variants[variant] ?? variants.primary,
        fullWidth ? "w-full" : "",
        className
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
};
