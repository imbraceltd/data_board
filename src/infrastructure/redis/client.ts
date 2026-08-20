import Redis from "ioredis";
import config from "../../config";
import logger from "../logging/logger";

let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_client) {
    _client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
    });

    _client.on("error", (err) => {
      logger.error("Redis client error:", err);
    });
  }
  return _client;
}
