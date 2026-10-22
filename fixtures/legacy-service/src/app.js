import { createServer } from 'node:http';
import { generateCode } from './codegen.js';
import { MemoryStore } from './store.js';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createApp(store = new MemoryStore()) {
  return createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/shorten') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let url;
        try {
          url = JSON.parse(body).url;
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        if (!url) return json(res, 400, { error: 'url is required' });
        const code = generateCode();
        store.set(code, { url, clicks: 0 });
        return json(res, 201, { code });
      });
      return;
    }

    const match = req.url.match(/^\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && match) {
      const link = store.get(match[1]);
      if (!link) return json(res, 404, { error: 'not found' });
      link.clicks += 1;
      res.writeHead(302, { location: link.url });
      return res.end();
    }
    return json(res, 404, { error: 'not found' });
  });
}
