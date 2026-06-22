import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/operator/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 8791,
    proxy: {
      '/agents': 'http://127.0.0.1:8790',
      '/agent-runs': 'http://127.0.0.1:8790',
      '/tasks': 'http://127.0.0.1:8790',
      '/rpc': 'http://127.0.0.1:8790',
      '/operator-config': 'http://127.0.0.1:8790',
    },
  },
});
