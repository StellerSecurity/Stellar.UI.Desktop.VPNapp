import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  envPrefix: ['VITE_'],
  server: {
    host: '127.0.0.1',
    port: 4176,
    strictPort: true,
    fs: { strict: true, deny: ['.env', '.env.*', '**/.git/**', '**/.security-review/**'] },
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**', '**/.security-review/**'] }
  },
  build: { target: ['es2022', 'safari15'], sourcemap: false }
});
