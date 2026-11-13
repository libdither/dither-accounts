import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5321,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8486', changeOrigin: false },
      '/oauth': { target: 'http://127.0.0.1:8486', changeOrigin: false },
    },
  },
});
