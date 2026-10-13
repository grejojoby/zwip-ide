import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./site', import.meta.url)),
  base: './',
  server: { host: '127.0.0.1', port: 1421, strictPort: true },
  preview: { host: '127.0.0.1', port: 1422, strictPort: true },
  build: { target: 'safari16', outDir: '../dist/site', emptyOutDir: true },
});
