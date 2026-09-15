import Redis from "ioredis";
import { config } from "./config.js";

const createRedisConnection = (role) => {
  const client = new Redis(config.redisUrl || "redis://127.0.0.1:6379", {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  client.on("error", () => console.error(`[${config.instanceId}] Redis ${role} connection error`));
  return client;
};

export const redis = createRedisConnection("commands");
export const redisPublisher = createRedisConnection("publisher");
export const redisSubscriber = createRedisConnection("subscriber");
const clients = [redis, redisPublisher, redisSubscriber];

export const redisIsReady = () => clients.every((client) => client.status === "ready");

export const connectRedis = async () => {
  await Promise.all(clients.map((client) => client.connect()));
};

export const closeRedis = async () => {
  await Promise.allSettled(clients.map(async (client) => {
    try {
      if (client.status === "ready") await client.quit();
    } finally {
      client.disconnect();
    }
  }));
};
