import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const developmentCsp = {
  name: 'nexus-development-csp',
  transformIndexHtml(html: string, context: { server?: unknown }) {
    if (!context.server) return html;
    return html
      .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      .replace("connect-src 'self' ws://localhost:* ws://127.0.0.1:*;", "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss:;");
  },
};

export default defineConfig({
  // Electron loads the production renderer with file://, so built asset URLs must be relative.
  base: './',
  plugins: [react(), developmentCsp],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
