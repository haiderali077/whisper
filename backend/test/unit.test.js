import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { positiveInteger, validateEnvironment } from "../src/lib/config.js";
import { presenceMember, createPresenceManager } from "../src/lib/presence.js";
import { consumeRateLimit, httpRateLimit, allowReceipt } from "../src/lib/rateLimit.js";
import { closeRedis } from "../src/lib/redis.js";

test.after(closeRedis);

test("environment validation rejects missing infrastructure configuration", () => {
  const old = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  assert.throws(validateEnvironment, /is required/);
  if (old === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = old;
});

test("configuration does not accept invalid intervals", () => {
  assert.equal(positiveInteger("MILESTONE_UNIT_INTERVAL", 10), 10);
  process.env.MILESTONE_UNIT_INTERVAL = "0";
  assert.throws(() => positiveInteger("MILESTONE_UNIT_INTERVAL", 10), /positive integer/);
  delete process.env.MILESTONE_UNIT_INTERVAL;
});

test("the backend exits rather than listening without Redis configuration", () => {
  const result = spawnSync(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: "5001", NODE_ENV: "development", MONGODB_URI: "mongodb://127.0.0.1:1/unit", JWT_SECRET: "unit-test-only", REDIS_URL: "" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /startup failed/);
  assert.ok(!result.stdout.includes("Listening"));
});

test("presence identifies individual connections, not just a user", () => {
  assert.notEqual(presenceMember("alice", "tab1"), presenceMember("alice", "tab2"));
});

test("rate-limit identities are hashed and counters report exhaustion", async () => {
  const commands = [];
  const fake = { eval: async (...args) => { commands.push(args); return [4, 1500]; } };
  const result = await consumeRateLimit(fake, "test", "send", "private-user-id", 3, 60000);
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
  assert.equal(result.retryAfter, 2);
  assert.match(commands[0][2], /^test:rate:send:[a-f0-9]{64}$/);
  assert.ok(!commands[0][2].includes("private-user-id"));
});

test("HTTP limiting fails closed when Redis is unavailable", async () => {
  let status;
  let body;
  const res = {
    set() { return this; },
    status(value) { status = value; return this; },
    json(value) { body = value; },
  };
  await httpRateLimit({ policy: "unit", limit: 3, windowMs: 1000 })({ ip: "127.0.0.1" }, res, () => assert.fail("must not bypass limiter"));
  assert.equal(status, 503);
  assert.match(body.message, /unavailable/);
});

test("receipt limiting fails closed and acknowledges the failure", async () => {
  let acknowledgement;
  assert.equal(await allowReceipt("alice", (value) => { acknowledgement = value; }), false);
  assert.equal(acknowledgement.code, "SERVICE_UNAVAILABLE");
});

test("queued presence operations cannot resurrect an already disconnected socket", async () => {
  const sockets = new Map([["tab1", { id: "tab1", data: { userId: "alice" } }]]);
  const calls = [];
  const manager = createPresenceManager({
    client: { eval: async (...args) => { calls.push(args); return ["epoch", String(calls.length), "alice"]; } },
    prefix: "unit", leaseMs: 30000, heartbeatMs: 10000,
    io: { of: () => ({ sockets }), emit: () => {} },
    isReady: () => true,
  });
  const first = manager.update();
  sockets.delete("tab1");
  await manager.update(["alice:tab1"]);
  await first;
  await manager.stop();
  assert.deepEqual(calls[0].slice(8), []);
  assert.deepEqual(calls[1].slice(8), ["alice:tab1"]);
});
