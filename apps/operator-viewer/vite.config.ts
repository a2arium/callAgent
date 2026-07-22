import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/operator/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 8791,
    proxy: {
      '/operator-api': 'http://127.0.0.1:8790',
    },
  },
});
