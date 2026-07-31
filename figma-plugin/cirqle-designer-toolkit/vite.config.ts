// Builds the UI (React app that runs inside Figma's iframe) into a single
// self-contained dist/ui.html — Figma plugin UIs cannot load external files
// at runtime, so everything (JS + CSS) must be inlined.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import fs from 'node:fs';

// Rollup names the emitted page after its input (index.html), but the
// manifest points Figma at dist/ui.html — rename on the way out.
const emitAsUiHtml = (): Plugin => ({
  name: 'cdt-emit-as-ui-html',
  closeBundle() {
    const from = path.resolve(__dirname, 'dist/index.html');
    const to = path.resolve(__dirname, 'dist/ui.html');
    if (fs.existsSync(from)) fs.renameSync(from, to);
  },
});

export default defineConfig({
  root: '.',
  plugins: [react(), viteSingleFile(), emitAsUiHtml()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@ui': path.resolve(__dirname, 'src/ui'),
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
});
