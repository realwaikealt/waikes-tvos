import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: /api goes to the bridge on this computer (port 5400), or BRIDGE=http://host:port npm run dev. Production: the bridge serves dist/ itself.
const target = process.env.BRIDGE || 'http://127.0.0.1:5400';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5402,
    proxy: { '/api': target },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
