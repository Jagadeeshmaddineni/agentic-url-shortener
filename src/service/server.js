import { createServer } from 'node:http';
import { createApp } from './app.js';
import { FileStore, MemoryStore } from './store.js';
import { RateLimiter } from './ratelimiter.js';
import { loadSpecConfig } from './defaults.js';

const env = process.env;
const config = loadSpecConfig();
const production = env.NODE_ENV === 'production';

if (production && !env.API_KEY) {
  console.error('API_KEY is required when NODE_ENV=production');
  process.exit(1);
}
const apiKey = env.API_KEY ?? 'dev-key';
if (!env.API_KEY) console.warn('[warn] API_KEY not set, using insecure development key');

const port = Number(env.PORT ?? 3000);
const baseUrl = env.BASE_URL ?? `http://localhost:${port}`;
const store = env.DATA_FILE ? new FileStore(env.DATA_FILE) : new MemoryStore();
const rateLimiter = new RateLimiter({ capacity: config.rateLimit.capacity, refillPerSecond: config.rateLimit.refillPerMinute / 60 });
const log = (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));

const server = createServer(createApp({ store, baseUrl, apiKey, rateLimiter, config, log }));
server.listen(port, () => log({ level: 'info', msg: 'listening', port, persistence: env.DATA_FILE ? 'file' : 'memory' }));

function shutdown(signal) {
  log({ level: 'info', msg: 'shutting_down', signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
