// Builds the plugin "main" thread (src/main/code.ts) into dist/code.js.
// This code runs in Figma's sandboxed plugin environment: no DOM, no fetch,
// must be a single IIFE bundle (no external chunks, no dynamic import).
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/main/code.ts'),
      formats: ['iife'],
      name: 'CirqleDesignerToolkit',
      fileName: () => 'code.js',
    },
    rollupOptions: {
      output: {
        // Figma's main thread has no module system — force everything into one file.
        inlineDynamicImports: true,
      },
    },
  },
});
