import Redis, { RedisOptions } from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;
const redisPassword = process.env.REDIS_PASS || undefined;
const redisUsername = process.env.REDIS_USERNAME || undefined;
const redisTlsEnabled = (process.env.REDIS_TLS || 'false').toLowerCase() === 'true';

const redisOptions: RedisOptions = {
  host: redisHost,
  port: redisPort,
  username: redisUsername,
  password: redisPassword,
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
};

if (redisTlsEnabled) {
  // AWS ElastiCache with in-transit encryption requires TLS
  // Node will validate AWS CA by default; SNI via servername is important
  (redisOptions as any).tls = { servername: redisHost };
}

export const redis = new Redis(redisOptions);

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
