import { defineConfig } from 'vite';
import path from 'node:path';

// The push service worker, one self-contained script served by the worker at
// /tdoc-sw.js. Not content-hashed: a service worker's URL is its identity, so
// the name never changes and the browser's own update check picks up a fix.
export default defineConfig({
  build: {
    outDir: path.resolve(import.meta.dirname, '../server/runtime'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/push-sw.js'),
      name: 'TdocPushWorker',
      formats: ['iife'],
      fileName: () => 'tdoc-sw.js',
    },
  },
});
