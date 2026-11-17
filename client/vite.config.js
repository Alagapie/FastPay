import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // API_URL lets a second copy of the app run against a different API (used for testing).
    proxy: { '/api': process.env.API_URL || 'http://localhost:4000' },
  },
});
