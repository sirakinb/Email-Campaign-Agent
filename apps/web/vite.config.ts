import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const { PENNY_HOSTED_URL } = loadEnv(mode, process.cwd(), 'PENNY_');
  return {
    plugins: [react(), {
      name: 'hosted-app-redirect',
      apply: 'serve',
      configureServer(server) {
        if (!PENNY_HOSTED_URL) return;
        const destination = new URL(PENNY_HOSTED_URL);
        if (destination.protocol !== 'https:') throw new Error('PENNY_HOSTED_URL must use HTTPS.');
        server.middlewares.use((req, res, next) => {
          // Redirect navigation only; never forward passwords or other API requests.
          if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
          const source = new URL(req.url ?? '/', 'http://localhost');
          const target = new URL(destination.origin);
          target.pathname = source.pathname;
          target.search = source.search;
          res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' });
          res.end();
        });
      },
    }],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:8787', changeOrigin: false },
        '/oauth': { target: 'http://localhost:8787', changeOrigin: false },
      },
    },
  };
});
