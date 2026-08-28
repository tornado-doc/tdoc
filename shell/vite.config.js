import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../server/runtime'),
    emptyOutDir: true,
    manifest: 'manifest.json',
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'src/main.jsx'),
      output: {
        entryFileNames: 'shell.[hash].js',
        assetFileNames: 'shell.[hash][extname]',
      },
    },
  },
});
