import { performance } from "node:perf_hooks";

const integer = (env, name, fallback, min, max) => {
  const raw = String(env[name] ?? fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const readLoadConfig = (env) => {
  // Deliberately Docker-only: never inherit backend/.env or accept public targets.
  if (env.LOAD_LOCAL_ONLY !== "true" || env.LOAD_BASE_URL !== "http://load-balancer" ||
      env.MONGODB_URI !== "mongodb://mongo:27017/whisper_load" ||
      env.REDIS_URL !== "redis://redis:6379" || env.REDIS_PREFIX !== "whisper_load") {
    throw new Error("Use the isolated compose.load.yaml project; demo/public targets are forbidden");
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) throw new Error("A local benchmark JWT_SECRET is required");
  const pairs = integer(env, "LOAD_PAIRS", 25, 1, 100);
  const durationSeconds = integer(env, "LOAD_DURATION_SECONDS", 30, 1, 120);
  const warmupSeconds = integer(env, "LOAD_WARMUP_SECONDS", 5, 0, 60);
  const rates = String(env.LOAD_RATES ?? "10,50,100").split(",").map((raw) =>
    integer({ rate: raw.trim() }, "rate", 10, 1, 1000));
  if (!rates.length || rates.length > 8 || new Set(rates).size !== rates.length) {
    throw new Error("LOAD_RATES must contain 1-8 distinct positive integer rates");
  }
  if (rates.reduce((sum, rate) => sum + rate * durationSeconds, warmupSeconds * Math.min(rates[0], 10)) > 20000) {
    throw new Error("A run is limited to 20,000 messages, including warmup");
  }
  const maxErrorRate = Number(env.LOAD_MAX_ERROR_RATE ?? "0.01");
  if (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 1) {
    throw new Error("LOAD_MAX_ERROR_RATE must be between 0 and 1");
  }
  const label = env.LOAD_RUN_LABEL || "";
  if (label && !/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error("LOAD_RUN_LABEL must be a safe filename label");
  return {
    baseUrl: env.LOAD_BASE_URL, mongoUrl: env.MONGODB_URI, redisUrl: env.REDIS_URL,
    prefix: env.REDIS_PREFIX, jwtSecret: env.JWT_SECRET, pairs, durationSeconds, warmupSeconds, rates,
    timeoutMs: integer(env, "LOAD_MESSAGE_TIMEOUT_MS", 10000, 1000, 30000),
    maxInFlight: integer(env, "LOAD_MAX_IN_FLIGHT", 1000, 1, 5000),
    thresholds: {
      maxErrorRate,
      httpP95Ms: integer(env, "LOAD_MAX_HTTP_P95_MS", 500, 1, 30000),
      readP95Ms: integer(env, "LOAD_MAX_READ_P95_MS", 1000, 1, 30000),
      schedulerP95Ms: integer(env, "LOAD_MAX_SCHEDULER_P95_MS", 20, 1, 30000),
    },
    label, resultsDir: env.LOAD_RESULTS_DIR || "/results",
    sourceRevision: env.LOAD_SOURCE_REVISION || "uncommitted-working-tree",
    hostDescription: env.LOAD_HOST_DESCRIPTION || "not-specified",
  };
};

export const round = (value) => Number(value.toFixed(3));

export const summarize = (values) => {
  if (!values.length) return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return {
    count: sorted.length, min: round(sorted[0]), mean: round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length),
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: round(sorted.at(-1)),
  };
};

const REQUIRED_STAGES = ["http", "receive", "deliveryAck", "readAck", "deliveryReceipt", "readReceipt"];

export class MessageProbe {
  constructor({ startAt, scheduledAt, timeoutMs, onFinish }) {
    this.startAt = startAt;
    this.scheduledAt = scheduledAt;
    this.times = {};
    this.finished = false;
    this.onFinish = onFinish;
    this.done = new Promise((resolve) => { this.resolve = resolve; });
    this.timer = setTimeout(() => this.fail("LIFECYCLE_TIMEOUT"), timeoutMs);
    this.timer.unref();
  }
  mark(stage, at = performance.now()) {
    if (!REQUIRED_STAGES.includes(stage)) throw new Error("Unknown probe stage");
    if (this.finished || this.times[stage] !== undefined) return false;
    this.times[stage] = at;
    if (REQUIRED_STAGES.every((name) => this.times[name] !== undefined)) this.finish(true);
    return true;
  }
  fail(reason) { if (!this.finished) this.finish(false, reason); }
  finish(ok, reason = null) {
    this.finished = true;
    clearTimeout(this.timer);
    const result = { ok, reason, startAt: this.startAt, scheduledAt: this.scheduledAt, times: this.times };
    this.onFinish(result);
    this.resolve(result);
  }
}

export const checkThresholds = (scenario, thresholds) => {
  const failures = [];
  if (!scenario.completed) failures.push("No fully completed messages");
  if (scenario.errorRate > thresholds.maxErrorRate) failures.push("Message error rate exceeded budget");
  if (scenario.dropped) failures.push("Generator dropped arrivals at its in-flight safety cap");
  if (scenario.duplicateDeliveries) failures.push("Duplicate socket deliveries observed");
  for (const [metric, limit, label] of [
    [scenario.latencyMs.http, thresholds.httpP95Ms, "HTTP"],
    [scenario.latencyMs.readReceipt, thresholds.readP95Ms, "Read receipt"],
    [scenario.latencyMs.schedulerLag, thresholds.schedulerP95Ms, "Generator scheduler lag"],
  ]) {
    if (metric.p95 === null || metric.p95 > limit) failures.push(`${label} p95 exceeded budget or had no samples`);
  }
  return { passed: failures.length === 0, failures };
};
