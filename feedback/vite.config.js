import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// One self-contained script, served by the worker at /feedback.js. It goes
// into other people's pages (the one-line install, the bookmarklet), so it
// carries its own React and its own CSS and touches nothing but its root.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: path.resolve(import.meta.dirname, '../server/runtime'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/main.jsx'),
      name: 'TdocFeedback',
      formats: ['iife'],
      fileName: () => 'feedback.js',
    },
  },
});
