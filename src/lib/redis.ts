import Redis, { RedisOptions } from 'ioredis';

const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;
const redisPassword = process.env.REDIS_PASS || undefined;
const redisUsername = process.env.REDIS_USERNAME || undefined;
const redisTlsEnabled = (process.env.REDIS_TLS || 'false').toLowerCase() === 'true';

const commonOptions: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
};

let client: Redis;
if (redisUrl) {
  // Allows rediss:// to enable TLS automatically
  client = new Redis(redisUrl, commonOptions);
} else {
  const redisOptions: RedisOptions = {
    host: redisHost,
    port: redisPort,
    username: redisUsername,
    password: redisPassword,
    ...commonOptions,
  };
  if (redisTlsEnabled) {
    (redisOptions as any).tls = { servername: redisHost };
  }
  client = new Redis(redisOptions);
}

export const redis = client;

export async function checkRedis(): Promise<boolean> {
  try {
    if (!redis.status || redis.status === 'end') {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
