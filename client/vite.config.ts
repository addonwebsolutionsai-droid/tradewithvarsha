import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 2026-06-16 — production build hardening (safe defaults only):
//   - no source maps (no easy source recovery)
//   - esbuild minify (default Vite — already mangles short, no breakage risk)
//   - strip console.log via terser-style esbuild drop config
//   - hash-only chunk filenames (no descriptive hints)
//
// Skipping aggressive terser+mangle/toplevel because it can break React
// runtime / property-name-based serialization in edge cases. The esbuild
// default already minifies + mangles enough for casual protection.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws':  { target: 'ws://localhost:4000',  ws: true },
    },
  },
  esbuild: {
    drop: ['console', 'debugger'],
    legalComments: 'none',
  },
  build: {
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[hash].js',
        entryFileNames: 'assets/[hash].js',
        assetFileNames: 'assets/[hash][extname]',
      },
    },
  },
})
