import "dotenv/config";
import { randomUUID } from "node:crypto";

export const positiveInteger = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const heartbeatMs = positiveInteger("PRESENCE_HEARTBEAT_MS", 10000);
const leaseMs = positiveInteger("PRESENCE_LEASE_MS", 30000);
if (leaseMs < heartbeatMs * 3) {
  throw new Error("PRESENCE_LEASE_MS must be at least three heartbeat intervals");
}

export const config = {
  port: positiveInteger("PORT", 5001),
  instanceId: process.env.INSTANCE_ID || randomUUID(),
  redisUrl: process.env.REDIS_URL,
  redisPrefix: process.env.REDIS_PREFIX || "whisper",
  heartbeatMs,
  leaseMs,
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Set only when the backend is reachable exclusively through that many proxies.
  trustProxy: process.env.TRUST_PROXY === undefined
    ? false
    : positiveInteger("TRUST_PROXY", 1),
  serveFrontend: process.env.SERVE_FRONTEND === "true" || process.env.NODE_ENV === "production",
  authLimit: positiveInteger("RATE_LIMIT_AUTH", 20),
  apiLimit: positiveInteger("RATE_LIMIT_API", 300),
  sendLimit: positiveInteger("RATE_LIMIT_SEND", 60),
  uploadLimit: positiveInteger("RATE_LIMIT_UPLOAD", 10),
  receiptLimit: positiveInteger("RATE_LIMIT_RECEIPTS", 120),
  handshakeLimit: positiveInteger("RATE_LIMIT_HANDSHAKES", 60),
};

export const validateEnvironment = () => {
  for (const name of ["MONGODB_URI", "JWT_SECRET", "REDIS_URL"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(config.redisPrefix)) {
    throw new Error("REDIS_PREFIX must contain only letters, numbers, underscores, or hyphens");
  }
  try {
    const url = new URL(config.redisUrl);
    if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
};
