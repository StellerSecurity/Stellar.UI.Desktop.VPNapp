/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        stellarBlue: "#2761FC",
        textGray: "#62626A",
        textDark: "#0B0C19",
        inputBg: "#EAEAF0",
      },
      borderRadius: {
        "4xl": "2rem",
      },
      fontFamily: {
        silka: [
          "Silka",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
        poppins: [
          "Poppins",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
      },

      // ✅ Animations for VPN status glow/pulse
      keyframes: {
        "ring-pulse": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.65" },
          "50%": { transform: "scale(1.12)", opacity: "1" },
        },
        "ring-breathe": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.45" },
          "50%": { transform: "scale(1.06)", opacity: "0.85" },
        },
        "dot-beat": {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.25)" },
        },

        // ✅ Skeleton shimmer for “Loading servers…”
        shimmer: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(120%)" },
        },
      },
      animation: {
        "ring-pulse": "ring-pulse 1.2s ease-in-out infinite",
        "ring-breathe": "ring-breathe 1.6s ease-in-out infinite",
        "dot-beat": "dot-beat 0.9s ease-in-out infinite",

        // ✅ Skeleton shimmer
        shimmer: "shimmer 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
