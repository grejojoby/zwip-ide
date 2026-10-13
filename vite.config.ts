import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { relative } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'application-notice-inputs',
      generateBundle(_options, bundle) {
        const modules = [
          ...new Set(
            Object.values(bundle).flatMap((output) =>
              output.type === 'chunk' ? Object.keys(output.modules) : [],
            ),
          ),
        ]
          .filter((id) => !id.startsWith('\0') && id.includes('/node_modules/'))
          .map((id) => relative(process.cwd(), id.split('?')[0]).replaceAll('\\', '/'))
          .sort();
        this.emitFile({
          type: 'asset',
          fileName: 'application-modules.json',
          source: JSON.stringify(
            { version: 1, build: process.env.VITE_E2E === '1' ? 'e2e' : 'production', modules },
            null,
            2,
          ),
        });
      },
    },
  ],
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  clearScreen: false,
  build: { target: 'safari16', outDir: 'dist/ui' },
});
