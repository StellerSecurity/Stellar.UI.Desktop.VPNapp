import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",
  },
  server: {
    open: false, // Don't open browser automatically
    strictPort: true,
    port: 5173,
  },
});
