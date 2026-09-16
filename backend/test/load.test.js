import test from "node:test";
import assert from "node:assert/strict";
import { readLoadConfig, summarize, MessageProbe, checkThresholds } from "../load/lib.js";

const localEnv = {
  LOAD_LOCAL_ONLY: "true", LOAD_BASE_URL: "http://load-balancer",
  MONGODB_URI: "mongodb://mongo:27017/whisper_load", REDIS_URL: "redis://redis:6379",
  REDIS_PREFIX: "whisper_load", JWT_SECRET: "unit-test-local-only-secret",
};

test("load runner only accepts its isolated Docker targets", () => {
  assert.equal(readLoadConfig(localEnv).pairs, 25);
  for (const override of [
    { LOAD_LOCAL_ONLY: "false" }, { LOAD_BASE_URL: "https://public.example" },
    { LOAD_BASE_URL: "http://localhost:8080" }, { MONGODB_URI: "mongodb://mongo:27017/whisper" },
    { REDIS_PREFIX: "whisper" }, { REDIS_URL: "redis://public.example:6379" },
  ]) assert.throws(() => readLoadConfig({ ...localEnv, ...override }), /isolated/);
});

test("load configuration rejects invalid and unbounded work", () => {
  for (const override of [
    { LOAD_PAIRS: "0" }, { LOAD_RATES: "10,10" }, { LOAD_RATES: "1.5" },
    { LOAD_DURATION_SECONDS: "121" }, { LOAD_RATES: "1000", LOAD_DURATION_SECONDS: "30" },
    { LOAD_MAX_ERROR_RATE: "NaN" }, { LOAD_RUN_LABEL: "../overwrite" },
  ]) assert.throws(() => readLoadConfig({ ...localEnv, ...override }));
  assert.equal(readLoadConfig({ ...localEnv, LOAD_WARMUP_SECONDS: "0" }).warmupSeconds, 0);
});

test("latency summaries use nearest-rank percentiles and preserve their input", () => {
  const input = [100, 2, 4, 1, 3];
  assert.deepEqual(summarize(input), { count: 5, min: 1, mean: 22, p50: 3, p95: 100, p99: 100, max: 100 });
  assert.deepEqual(input, [100, 2, 4, 1, 3]);
  assert.equal(summarize([]).p95, null, "missing samples must not look like zero latency");
});

test("HTTP success alone cannot complete a messaging probe", async () => {
  let finishes = 0;
  const probe = new MessageProbe({ startAt: 0, scheduledAt: 0, timeoutMs: 1000, onFinish: () => { finishes += 1; } });
  probe.mark("http", 1);
  assert.equal(finishes, 0);
  for (const stage of ["readReceipt", "receive", "readAck", "deliveryAck", "deliveryReceipt"]) probe.mark(stage, 2);
  assert.equal((await probe.done).ok, true);
  assert.equal(finishes, 1);
  probe.fail("late failure");
  probe.mark("http", 3);
  assert.equal(finishes, 1);
});

test("failed probes cannot turn into successes on late events", async () => {
  const probe = new MessageProbe({ startAt: 0, scheduledAt: 0, timeoutMs: 1000, onFinish() {} });
  probe.fail("HTTP_429");
  for (const stage of ["http", "receive", "readReceipt", "readAck", "deliveryAck", "deliveryReceipt"]) probe.mark(stage, 2);
  assert.equal((await probe.done).reason, "HTTP_429");
});

test("unfinished probe stages fail at the lifecycle deadline", async () => {
  const probe = new MessageProbe({ startAt: 0, scheduledAt: 0, timeoutMs: 20, onFinish() {} });
  probe.timer.ref();
  probe.mark("http", 1);
  const result = await probe.done;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "LIFECYCLE_TIMEOUT");
});

test("thresholds fail for dropped arrivals, errors, and missing samples", () => {
  const good = { completed: 10, errorRate: 0, dropped: 0, duplicateDeliveries: 0,
    latencyMs: { http: summarize([10]), readReceipt: summarize([20]), schedulerLag: summarize([1]) } };
  const thresholds = { maxErrorRate: 0.01, httpP95Ms: 500, readP95Ms: 1000, schedulerP95Ms: 20 };
  assert.equal(checkThresholds(good, thresholds).passed, true);
  for (const override of [
    { completed: 0 }, { errorRate: 0.1 }, { dropped: 1 }, { duplicateDeliveries: 1 },
    { latencyMs: { ...good.latencyMs, http: summarize([]) } },
  ]) assert.equal(checkThresholds({ ...good, ...override }, thresholds).passed, false);
});
