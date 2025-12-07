/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        stellarBlue: "#256BFF"
      },
      borderRadius: {
        "4xl": "2rem"
      }
    }
  },
  plugins: []
};
