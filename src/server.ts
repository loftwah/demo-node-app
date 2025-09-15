import './tracing';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import { checkS3, deleteS3Object, getS3Text, putS3Text } from './lib/aws';
import { checkDb, migrate, listItems, getItem, createItem, updateItem, deleteItem } from './lib/db';
import { checkRedis, redis } from './lib/redis';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
// Serve static assets from public/ (robots.txt, favicon.ico, etc.)
app.use(express.static('public'));

const APP_ENV = process.env.APP_ENV || 'staging';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const S3_BUCKET = process.env.S3_BUCKET || '';
const SELF_TEST_ON_BOOT = (process.env.SELF_TEST_ON_BOOT || 'true').toLowerCase() === 'true';
const APP_AUTH_SECRET = process.env.APP_AUTH_SECRET || 'hunter2';
const READYZ_PUBLIC = (process.env.READYZ_PUBLIC || 'false').toLowerCase() === 'true';

const PLATFORM_OVERRIDE = (
  process.env.DEPLOY_PLATFORM ||
  process.env.RUN_PLATFORM ||
  process.env.PLATFORM ||
  ''
).toLowerCase();

type RuntimePlatform = 'ecs' | 'eks' | 'kubernetes' | 'unknown';

function detectRuntimePlatform(): RuntimePlatform {
  // Explicit override takes precedence
  if (
    PLATFORM_OVERRIDE === 'ecs' ||
    PLATFORM_OVERRIDE === 'eks' ||
    PLATFORM_OVERRIDE === 'kubernetes'
  ) {
    return PLATFORM_OVERRIDE as RuntimePlatform;
  }

  // Kubernetes/EKS detection: well-known env and service account mount
  if (
    process.env.KUBERNETES_SERVICE_HOST ||
    fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace')
  ) {
    return 'eks';
  }

  // ECS detection: metadata URI or execution env
  if (
    process.env.ECS_CONTAINER_METADATA_URI_V4 ||
    process.env.ECS_CONTAINER_METADATA_URI ||
    (process.env.AWS_EXECUTION_ENV || '').toUpperCase().includes('ECS')
  ) {
    return 'ecs';
  }

  // Fallback to unknown
  return 'unknown';
}

// In a demo, an explicit override should always win, even if it's an unknown value
const RUNTIME_PLATFORM: string = PLATFORM_OVERRIDE || detectRuntimePlatform();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const CURRENT_LOG_LEVEL = LOG_LEVEL.toLowerCase() as LogLevel;
const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[CURRENT_LOG_LEVEL];
}
function logDebug(...args: any[]) {
  if (shouldLog('debug')) console.log(...args);
}
function logInfo(...args: any[]) {
  if (shouldLog('info')) console.log(...args);
}
function logWarn(...args: any[]) {
  if (shouldLog('warn')) console.warn(...args);
}
function logError(...args: any[]) {
  if (shouldLog('error')) console.error(...args);
}

function isPublicPath(req: Request): boolean {
  if (req.path === '/healthz') return true;
  if (req.path === '/robots.txt') return true;
  if (req.path === '/favicon.ico') return true;
  if (READYZ_PUBLIC && req.path === '/readyz') return true;
  if (req.method === 'GET' && req.path === '/') return true;
  return false;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isPublicPath(req)) return next();

  const headerVal = req.headers['authorization'];
  const queryToken = (req.query.token as string | undefined) || undefined;
  const authHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;

  let authorized = false;
  let username: string | undefined;

  if (queryToken && queryToken === APP_AUTH_SECRET) {
    authorized = true;
  }

  if (!authorized && authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer === APP_AUTH_SECRET) authorized = true;
    } else if (authHeader.includes(':')) {
      const idx = authHeader.lastIndexOf(':');
      const maybeUser = authHeader.slice(0, idx);
      const secret = authHeader.slice(idx + 1);
      if (secret === APP_AUTH_SECRET) {
        authorized = true;
        username = maybeUser || 'loftwah';
      }
    }
  }

  if (!authorized) {
    logWarn(`[auth] unauthorized ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  (req as any).user = { username: username || 'loftwah' };
  next();
}

app.use(authMiddleware);

// Debug HTTP request logging (enabled when LOG_LEVEL=debug)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    logDebug(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Root overview page
app.get('/', (_req: Request, res: Response) => {
  const publicEndpoints = [
    '- GET  /           this overview',
    '- GET  /healthz    liveness (200 when the process is up)',
    '- GET  /robots.txt, /favicon.ico',
  ];
  const protectedEndpoints = [
    '- GET  /selftest   end-to-end CRUD across services',
    '- POST/GET/DELETE /s3/:id',
    '- POST/GET        /db/items',
    '- GET/PUT/DELETE  /db/items/:id',
    '- POST/GET/PUT/DELETE /cache/:key',
  ];
  if (READYZ_PUBLIC) publicEndpoints.push('- GET  /readyz     readiness (checks S3/DB/Redis)');
  else protectedEndpoints.unshift('- GET  /readyz     readiness (checks S3/DB/Redis)');

  const overview = [
    "Loftwah's DevOps Refresher — Demo Node App",
    '',
    'Service: demo-node-app (Express + TypeScript)',
    `Environment: ${APP_ENV}`,
    `Log level: ${LOG_LEVEL}`,
    `Port: ${PORT}`,
    '',
    `- S3 bucket: ${S3_BUCKET || '(not configured)'}`,
    '- RDS Postgres (RDS) for data storage',
    '- ElastiCache Redis for cache/kv',
    '',
    'Public endpoints (no auth required):',
    ...publicEndpoints,
    '',
    'Protected endpoints (auth required):',
    ...protectedEndpoints,
    '',
    'How to authenticate:',
    '- Send Authorization: Bearer <APP_AUTH_SECRET>',
    '- Or append ?token=<APP_AUTH_SECRET> to the URL',
    '',
    'Operational notes:',
    '- Container health check targets /healthz',
    '- Set LOG_LEVEL=debug to enable per-request timing logs',
  ].join('\n');

  logInfo(
    `[root] overview served env=${APP_ENV} platform=${RUNTIME_PLATFORM} override=${PLATFORM_OVERRIDE || '(none)'} ` +
      `signals{k8s=${Boolean(process.env.KUBERNETES_SERVICE_HOST)},ecs_meta=${Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI)},exec_env=${process.env.AWS_EXECUTION_ENV || '(unset)'}}`
  );
  res.type('text/plain').send(overview);
});

// Fast liveness probe for container/ELB health checks
app.get('/healthz', (_req: Request, res: Response) => {
  logDebug('[healthz] liveness check OK');
  res.status(200).type('text/plain').send('ok');
});

// Quiet common anonymous hits
app.get('/robots.txt', (_req: Request, res: Response) => {
  res.type('text/plain').send('User-agent: *\nDisallow:');
});
app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.status(204).end();
});

// Deeper readiness diagnostics (non-blocking for health checks)
app.get('/readyz', async (_req: Request, res: Response) => {
  const started = Date.now();
  const s3Ok = S3_BUCKET ? await checkS3(S3_BUCKET) : false;
  const dbOk = await checkDb();
  const redisOk = await checkRedis();
  const status = dbOk && (!S3_BUCKET || s3Ok) && redisOk ? 'ready' : 'degraded';
  const durationMs = Date.now() - started;
  logInfo(
    `[readyz] status=${status} s3=${s3Ok} db=${dbOk} redis=${redisOk} durationMs=${durationMs}`
  );
  res.json({
    status,
    version: '0.1.0',
    env: APP_ENV,
    services: { s3: s3Ok, db: dbOk, redis: redisOk },
  });
});

// Self-test endpoint to exercise CRUD across S3, Postgres, and Redis
app.get('/selftest', async (_req: Request, res: Response) => {
  try {
    const result = await runSelfTest();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'selftest failed' });
  }
});

// S3 CRUD
app.post('/s3/:id', async (req: Request, res: Response) => {
  if (!S3_BUCKET) return res.status(400).json({ error: 'S3_BUCKET not configured' });
  try {
    const id = req.params.id;
    const key = `app/${id}.txt`;
    const body =
      typeof req.body?.text === 'string'
        ? req.body.text
        : JSON.stringify(req.body || { message: 'hello from Loftwah' });
    await putS3Text(S3_BUCKET, key, body);
    res.json({ ok: true, bucket: S3_BUCKET, key });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'S3 put failed' });
  }
});

app.get('/s3/:id', async (req: Request, res: Response) => {
  if (!S3_BUCKET) return res.status(400).json({ error: 'S3_BUCKET not configured' });
  try {
    const id = req.params.id;
    const key = `app/${id}.txt`;
    const content = await getS3Text(S3_BUCKET, key);
    if (content == null) return res.status(404).json({ error: 'Not found' });
    res.type('text/plain').send(content);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'S3 get failed' });
  }
});

app.delete('/s3/:id', async (req: Request, res: Response) => {
  if (!S3_BUCKET) return res.status(400).json({ error: 'S3_BUCKET not configured' });
  try {
    const id = req.params.id;
    const key = `app/${id}.txt`;
    await deleteS3Object(S3_BUCKET, key);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'S3 delete failed' });
  }
});

// DB CRUD
app.post('/db/items', async (req: Request, res: Response) => {
  const id = req.body?.id || randomUUID();
  const name = req.body?.name || `banana-by-${(req as any).user?.username || 'loftwah'}`;
  const value = req.body?.value ?? { by: (req as any).user?.username || 'loftwah', fun: true };
  const item = await createItem(id, name, value);
  res.json(item);
});

app.get('/db/items', async (_req: Request, res: Response) => {
  const items = await listItems();
  res.json(items);
});

app.get('/db/items/:id', async (req: Request, res: Response) => {
  const item = await getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.put('/db/items/:id', async (req: Request, res: Response) => {
  const name = req.body?.name || `banana-by-${(req as any).user?.username || 'loftwah'}`;
  const value = req.body?.value ?? { updatedBy: (req as any).user?.username || 'loftwah' };
  const item = await updateItem(req.params.id, name, value);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.delete('/db/items/:id', async (req: Request, res: Response) => {
  const ok = await deleteItem(req.params.id);
  res.json({ ok });
});

// Redis CRUD
app.post('/cache/:key', async (req: Request, res: Response) => {
  const key = req.params.key;
  const value =
    typeof req.body?.value === 'string'
      ? req.body.value
      : JSON.stringify(req.body ?? { from: 'Loftwah' });
  if (!redis.status || redis.status === 'end') await redis.connect();
  await redis.set(key, value);
  res.json({ ok: true });
});

app.get('/cache/:key', async (req: Request, res: Response) => {
  if (!redis.status || redis.status === 'end') await redis.connect();
  const value = await redis.get(req.params.key);
  if (value == null) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(value);
});

app.put('/cache/:key', async (req: Request, res: Response) => {
  const key = req.params.key;
  const value =
    typeof req.body?.value === 'string'
      ? req.body.value
      : JSON.stringify(req.body ?? { updatedBy: 'Loftwah' });
  if (!redis.status || redis.status === 'end') await redis.connect();
  await redis.set(key, value);
  res.json({ ok: true });
});

app.delete('/cache/:key', async (req: Request, res: Response) => {
  if (!redis.status || redis.status === 'end') await redis.connect();
  const n = await redis.del(req.params.key);
  res.json({ ok: n > 0 });
});

async function waitForPostgres(maxAttempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = await checkDb();
    if (ok) return true;
    logDebug(`[startup] waiting for Postgres attempt=${attempt}/${maxAttempts}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function start() {
  const dbReady = await waitForPostgres();
  if (!dbReady) throw new Error('Postgres not ready after retries');
  await migrate();
  if (S3_BUCKET) {
    // best-effort wait for S3 bucket (MinIO) to appear in local dev
    for (let attempt = 1; attempt <= 20; attempt++) {
      const ok = await checkS3(S3_BUCKET);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[demo-node-app] env=${APP_ENV} platform=${RUNTIME_PLATFORM} override=${PLATFORM_OVERRIDE || '(none)'} ` +
        `level=${LOG_LEVEL} listening on :${PORT} signals{k8s=${Boolean(process.env.KUBERNETES_SERVICE_HOST)},ecs_meta=${Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI)},exec_env=${process.env.AWS_EXECUTION_ENV || '(unset)'}}`
    );
  });

  if (SELF_TEST_ON_BOOT) {
    // fire-and-forget self-test, log summary
    runSelfTest()
      .then((summary) => {
        // eslint-disable-next-line no-console
        console.log(`[selftest] summary: ${JSON.stringify(summary)}`);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[selftest] error:', err);
      });
  }
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', err);
  process.exit(1);
});

type SelfTestResult = {
  s3: { ok: boolean; bucket?: string; key?: string; error?: string };
  db: { ok: boolean; id?: string; error?: string };
  redis: { ok: boolean; key?: string; error?: string };
};

// End-to-end CRUD across all services, returns a summary and logs steps
async function runSelfTest(): Promise<SelfTestResult> {
  const result: SelfTestResult = {
    s3: { ok: false },
    db: { ok: false },
    redis: { ok: false },
  };

  // S3
  if (S3_BUCKET) {
    const s3Key = `app/selftest-${Date.now()}.txt`;
    try {
      const body = `hello from loftwah selftest ${new Date().toISOString()}`;
      // eslint-disable-next-line no-console
      console.log(`[selftest][s3] put ${S3_BUCKET}/${s3Key}`);
      await putS3Text(S3_BUCKET, s3Key, body);
      // eslint-disable-next-line no-console
      console.log(`[selftest][s3] get ${S3_BUCKET}/${s3Key}`);
      const got = await getS3Text(S3_BUCKET, s3Key);
      if (got !== body) throw new Error('s3 content mismatch');
      // eslint-disable-next-line no-console
      console.log(`[selftest][s3] delete ${S3_BUCKET}/${s3Key}`);
      await deleteS3Object(S3_BUCKET, s3Key);
      result.s3 = { ok: true, bucket: S3_BUCKET, key: s3Key };
    } catch (e: any) {
      result.s3 = { ok: false, bucket: S3_BUCKET, key: s3Key, error: e?.message || String(e) };
      // eslint-disable-next-line no-console
      console.error('[selftest][s3] failed', e);
    }
  } else {
    result.s3 = { ok: false, error: 'S3_BUCKET not configured' };
  }

  // DB
  try {
    const id = randomUUID();
    const name = `selftest-${id.substring(0, 8)}`;
    const value = { hello: 'loftwah', ts: Date.now() };
    // eslint-disable-next-line no-console
    console.log(`[selftest][db] create ${id}`);
    await createItem(id, name, value);
    // eslint-disable-next-line no-console
    console.log(`[selftest][db] get ${id}`);
    const fetched = await getItem(id);
    if (!fetched) throw new Error('db get failed');
    // eslint-disable-next-line no-console
    console.log(`[selftest][db] update ${id}`);
    await updateItem(id, `${name}-updated`, { ...value, updated: true });
    // eslint-disable-next-line no-console
    console.log(`[selftest][db] delete ${id}`);
    const deleted = await deleteItem(id);
    if (!deleted) throw new Error('db delete failed');
    result.db = { ok: true, id };
  } catch (e: any) {
    result.db = { ok: false, error: e?.message || String(e) };
    // eslint-disable-next-line no-console
    console.error('[selftest][db] failed', e);
  }

  // Redis
  try {
    const rKey = `selftest:${randomUUID()}`;
    const val1 = `hi-${Date.now()}`;
    if (!redis.status || redis.status === 'end') await redis.connect();
    // eslint-disable-next-line no-console
    console.log(`[selftest][redis] set ${rKey}`);
    await redis.set(rKey, val1);
    // eslint-disable-next-line no-console
    console.log(`[selftest][redis] get ${rKey}`);
    const got1 = await redis.get(rKey);
    if (got1 !== val1) throw new Error('redis value mismatch');
    // eslint-disable-next-line no-console
    console.log(`[selftest][redis] del ${rKey}`);
    await redis.del(rKey);
    result.redis = { ok: true, key: rKey };
  } catch (e: any) {
    result.redis = { ok: false, error: e?.message || String(e) };
    // eslint-disable-next-line no-console
    console.error('[selftest][redis] failed', e);
  }

  return result;
}
