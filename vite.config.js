import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  resolve: {
    alias: {
      '@pbip-lineage/core': path.resolve(__dirname, 'packages/core/src'),
      '@pbip-lineage/core/': path.resolve(__dirname, 'packages/core/src/'),
    }
  }
});
