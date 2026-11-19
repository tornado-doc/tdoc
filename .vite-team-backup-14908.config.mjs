import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: "/var/folders/c0/h82hs7bn231_csmp4819038r0000gn/T/tdoc-team-backup-ui-xeo57e", emptyOutDir: true,
  rollupOptions: { input: "/private/tmp/suggest-fix/test/fixtures/ui-harness/team-backup.jsx", output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });
