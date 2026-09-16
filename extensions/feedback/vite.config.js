import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: import.meta.dirname,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/content.jsx'),
      name: 'TdocFeedback',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
