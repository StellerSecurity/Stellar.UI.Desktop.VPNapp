/** @type {import('tailwindcss').Config} */
module.exports = {
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
    },
  },
  plugins: [],
};
