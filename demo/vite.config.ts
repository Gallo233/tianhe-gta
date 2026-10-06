import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { npcBrainPlugin } from './server/npcBrain';

/** Dev-only: POST a canvas dataURL to /__shot?name=x and it lands in artifacts/shots/x.png. */
function shotSink(): Plugin {
  return {
    name: 'tianhe-shot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          const dir = join(process.cwd(), 'artifacts', 'shots');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, Buffer.from(body.slice(body.indexOf(',') + 1), 'base64'));
          res.end(file);
        });
      });
    },
  };
}

/** Dev-only: the page POSTs each distinct uncaught error to /__err (src/core/ErrorReport.ts); one JSON line each in
 *  guangzhou/logs/client_errors.log, and a line in this terminal. */
function errorSink(): Plugin {
  return {
    name: 'tianhe-error-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__err', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString().replace(/\s*\n\s*/g, ' ');
          const dir = join(process.cwd(), '..', 'logs');
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, 'client_errors.log'), body + '\n');
          try { const e = JSON.parse(body); server.config.logger.error(`[页面报错] ${e.kind}：${e.msg}`, { timestamp: true }); } catch { /* not JSON */ }
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [shotSink(), errorSink(), npcBrainPlugin()],
  server: { host: '127.0.0.1', port: 5288, strictPort: true },
  preview: { host: '127.0.0.1', port: 4288, strictPort: true },
  // relative asset URLs: the published world (Chrona, any static host) may live under a sub-path
  base: './',
  build: { sourcemap: false, chunkSizeWarningLimit: 1200 },
});
