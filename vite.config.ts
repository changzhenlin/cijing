import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { index: resolve(import.meta.dirname, 'index.html'), popup: resolve(import.meta.dirname, 'popup.html') },
    },
  },
});
