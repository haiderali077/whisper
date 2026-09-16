import { createHash } from "node:crypto";
import { config } from "./config.js";
import { redis, redisIsReady } from "./redis.js";

// Fixed window begins with the first request. Increment and expiry cannot race.
const CONSUME_LIMIT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

export const consumeRateLimit = async (client, prefix, policy, identity, limit, windowMs) => {
  const hash = createHash("sha256").update(String(identity)).digest("hex");
  const [hits, ttl] = await client.eval(CONSUME_LIMIT, 1, `${prefix}:rate:${policy}:${hash}`, windowMs);
  return {
    allowed: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
  };
};

export const httpRateLimit = ({ policy, limit, windowMs, identity = (req) => req.ip, skip = () => false }) =>
  async (req, res, next) => {
    if (skip(req)) return next();
    try {
      if (!redisIsReady()) throw new Error("Redis unavailable");
      const result = await consumeRateLimit(redis, config.redisPrefix, policy, identity(req), limit, windowMs);
      res.set({
        "RateLimit-Limit": result.limit,
        "RateLimit-Remaining": result.remaining,
        "RateLimit-Reset": result.retryAfter,
      });
      if (result.allowed) return next();
      res.set("Retry-After", String(result.retryAfter));
      return res.status(429).json({ message: "Too many requests. Please try again later.", retryAfter: result.retryAfter });
    } catch {
      res.set("Retry-After", "5");
      return res.status(503).json({ message: "Rate limiting is temporarily unavailable. Please try again later." });
    }
  };

export const authLimiter = httpRateLimit({ policy: "auth", limit: config.authLimit, windowMs: 15 * 60 * 1000 });
export const apiLimiter = httpRateLimit({ policy: "api", limit: config.apiLimit, windowMs: 60000 });
export const sendLimiter = httpRateLimit({
  policy: "send", limit: config.sendLimit, windowMs: 60000, identity: (req) => req.user._id.toString(),
});
export const uploadLimiter = httpRateLimit({
  policy: "upload", limit: config.uploadLimit, windowMs: 60 * 60 * 1000,
  identity: (req) => req.user._id.toString(),
  skip: (req) => !req.body?.image && !req.body?.profilePic,
});

export const allowReceipt = async (userId, acknowledge) => {
  const respond = typeof acknowledge === "function" ? acknowledge : () => {};
  try {
    if (!redisIsReady()) throw new Error("Redis unavailable");
    const result = await consumeRateLimit(redis, config.redisPrefix, "receipts", userId, config.receiptLimit, 60000);
    if (result.allowed) return true;
    respond({ ok: false, code: "RATE_LIMITED", error: "Too many receipt events", retryAfter: result.retryAfter });
  } catch {
    respond({ ok: false, code: "SERVICE_UNAVAILABLE", error: "Receipt processing is temporarily unavailable" });
  }
  return false;
};
