import Redis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379;
const redisPassword = process.env.REDIS_PASS || undefined;

export const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
});

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
