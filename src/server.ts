import express, { Request, Response, NextFunction } from 'express';
import { checkS3, deleteS3Object, getS3Text, putS3Text } from './lib/aws';
import { checkDb, migrate, listItems, getItem, createItem, updateItem, deleteItem } from './lib/db';
import { checkRedis, redis } from './lib/redis';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const APP_ENV = process.env.APP_ENV || 'staging';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const S3_BUCKET = process.env.S3_BUCKET || '';
const SELF_TEST_ON_BOOT = (process.env.SELF_TEST_ON_BOOT || 'true').toLowerCase() === 'true';

// Simple fun auth fallback: if Authorization missing or invalid, default to Loftwah/hunter2
function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const auth = req.headers['authorization'] || (req.query.token as string | undefined);
  if (!auth) {
    (req as any).user = { username: 'loftwah' };
    return next();
  }
  try {
    const token = Array.isArray(auth) ? auth[0] : auth;
    if (token === 'Bearer demo' || token === 'loftwah:hunter2') {
      (req as any).user = { username: 'loftwah' };
    } else {
      (req as any).user = { username: 'anonymous' };
    }
  } catch {
    (req as any).user = { username: 'loftwah' };
  }
  next();
}

app.use(authMiddleware);

app.get('/healthz', async (_req: Request, res: Response) => {
  const s3Ok = S3_BUCKET ? await checkS3(S3_BUCKET) : false;
  const dbOk = await checkDb();
  const redisOk = await checkRedis();
  res.json({
    status: 'ok',
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
    console.log(`[demo-node-app] env=${APP_ENV} level=${LOG_LEVEL} listening on :${PORT}`);
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
