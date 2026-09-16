import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Redis from "ioredis";
import { io } from "socket.io-client";
import User from "../src/models/user.model.js";
import Message from "../src/models/message.model.js";
import { readLoadConfig, MessageProbe, summarize, round, checkThresholds } from "./lib.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const increment = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };

const fingerprint = async () => {
  const hash = createHash("sha256");
  const walk = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) await walk(path);
      else { hash.update(fileURLToPath(path).split("/backend/").at(-1)); hash.update(await readFile(path)); }
    }
  };
  await walk(new URL("../src/", import.meta.url));
  await walk(new URL("./", import.meta.url));
  return hash.digest("hex");
};

const newScenario = (rate, durationSeconds) => ({
  targetMessagesPerSecond: rate, durationSeconds, offered: rate * durationSeconds,
  started: 0, completed: 0, failed: 0, dropped: 0, duplicateDeliveries: 0, socketDisconnects: 0,
  peakInFlight: 0, httpStatuses: {}, failureReasons: {},
  samples: { http: [], socketDelivery: [], deliveryReceipt: [], readReceipt: [],
    scheduledToReadReceipt: [], schedulerLag: [] },
});

export const executeLoad = async (config) => {
  const runId = randomUUID();
  const users = [];
  const sessions = [];
  const pairs = [];
  const pending = new Map();
  const byMongoId = new Map();
  const received = new Map();
  const receiptTasks = new Set();
  const controllers = new Set();
  let activeScenario;
  let stopping = false;
  let interrupted = false;
  const redis = new Redis(config.redisUrl, { lazyConnect: true, connectTimeout: 5000,
    commandTimeout: 3000, maxRetriesPerRequest: 1 });
  redis.on("error", () => {});
  const report = {
    schemaVersion: 1, runId, startedAt: new Date().toISOString(), passed: false,
    configuration: { target: config.baseUrl, pairs: config.pairs, connectedSockets: config.pairs * 2,
      rates: config.rates, durationSeconds: config.durationSeconds, warmupSeconds: config.warmupSeconds,
      messageTimeoutMs: config.timeoutMs, maxInFlight: config.maxInFlight, thresholds: config.thresholds,
      transport: "websocket", payload: "short text; no images", trafficModel: "open-loop paced arrivals",
      fixtureSetup: "MongoDB-seeded users with valid signed JWTs; signup/login excluded",
      rateLimits: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("RATE_LIMIT_"))),
      presenceHeartbeatMs: Number(process.env.PRESENCE_HEARTBEAT_MS), presenceLeaseMs: Number(process.env.PRESENCE_LEASE_MS) },
    environment: { sourceRevision: config.sourceRevision, hostDescription: config.hostDescription,
      nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      generatorVisibleLogicalCpus: os.cpus().length, generatorVisibleMemoryBytes: os.totalmem() },
    nodeDistribution: {}, crossInstancePairs: 0, scenarios: [], cleanup: { errors: [] },
  };
  const onSignal = () => {
    interrupted = true;
    for (const probe of [...pending.values()]) probe.fail("INTERRUPTED");
    for (const controller of controllers) controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const request = async (url, cookie, body, probe) => {
    const controller = new AbortController();
    controllers.add(controller);
    if (probe) probe.abort = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      return { response, data };
    } finally { clearTimeout(timer); controllers.delete(controller); }
  };

  const bindMongoId = (probe, id) => {
    if (probe.mongoId && probe.mongoId !== id) { probe.fail("CORRELATION_MISMATCH"); return false; }
    probe.mongoId = id;
    if (!probe.finished) byMongoId.set(id, probe);
    return true;
  };

  const attachSession = (session) => {
    session.socket.on("disconnect", () => {
      if (!stopping && activeScenario) activeScenario.socketDisconnects += 1;
    });
    session.socket.on("messageStatusUpdated", ({ receipts = [] }) => {
      for (const receipt of receipts) {
        const probe = byMongoId.get(receipt.messageId);
        if (!probe || session.userId !== probe.sender.userId) continue;
        if (receipt.deliveredAt) probe.mark("deliveryReceipt");
        if (receipt.readAt) probe.mark("readReceipt");
      }
    });
    session.socket.on("newMessage", (message) => {
      const existing = received.get(message.clientMessageId);
      if (existing) { existing.duplicateDeliveries += 1; return; }
      const probe = pending.get(message.clientMessageId);
      if (!probe || probe.finished) return;
      if (message.receiverId !== session.userId || message.senderId !== probe.sender.userId ||
          probe.receiver.userId !== session.userId || !bindMongoId(probe, message._id)) {
        probe.fail("CORRELATION_MISMATCH"); return;
      }
      received.set(message.clientMessageId, probe.scenario);
      probe.mark("receive");
      const task = (async () => {
        for (const [event, stage] of [["messagesDelivered", "deliveryAck"], ["messagesRead", "readAck"]]) {
          if (probe.finished) return;
          const ack = await session.socket.timeout(config.timeoutMs).emitWithAck(event, { messageIds: [message._id] });
          if (!ack?.ok || !ack.receipts?.some((receipt) => receipt.messageId === message._id)) {
            probe.fail(ack?.code || `${stage.toUpperCase()}_REJECTED`); return;
          }
          probe.mark(stage);
        }
      })().catch(() => probe.fail("RECEIPT_ACK_TIMEOUT"));
      receiptTasks.add(task);
      void task.finally(() => receiptTasks.delete(task));
    });
  };

  const openSession = async (user, differentFrom) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (interrupted) throw new Error("Interrupted during socket setup");
      const cookie = `jwt=${jwt.sign({ userId: user._id.toString(), jti: randomUUID() }, config.jwtSecret, { expiresIn: "1h" })}`;
      const socket = io(config.baseUrl, { autoConnect: false, forceNew: true, transports: ["websocket"],
        reconnection: false, extraHeaders: { Cookie: cookie } });
      let instanceId;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Socket setup timed out")), config.timeoutMs);
          socket.once("serverInfo", (info) => { instanceId = info.instanceId; clearTimeout(timer); resolve(); });
          socket.once("connect_error", () => { clearTimeout(timer); reject(new Error("Authenticated socket setup failed")); });
          socket.connect();
        });
      } catch (error) { socket.disconnect(); throw error; }
      if (instanceId === differentFrom) { socket.disconnect(); continue; }
      const session = { socket, cookie, instanceId, userId: user._id.toString() };
      sessions.push(session);
      attachSession(session);
      increment(report.nodeDistribution, instanceId);
      return session;
    }
    throw new Error("Could not place a pair on different backends through NGINX");
  };

  const runScenario = async (rate, durationSeconds) => {
    const scenario = newScenario(rate, durationSeconds);
    activeScenario = scenario;
    const cpuStart = process.cpuUsage();
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    let peakRss = process.memoryUsage().rss;
    const memorySampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    const start = performance.now();
    const dispatch = (index, scheduledAt) => {
      if (pending.size >= config.maxInFlight) { scenario.dropped += 1; return; }
      const pair = pairs[Math.floor(index / 2) % pairs.length];
      const [sender, receiver] = index % 2 ? [pair[1], pair[0]] : pair;
      const clientMessageId = `${runId}-${randomUUID()}`;
      const startAt = performance.now();
      scenario.started += 1;
      scenario.samples.schedulerLag.push(startAt - scheduledAt);
      const probe = new MessageProbe({ startAt, scheduledAt, timeoutMs: config.timeoutMs, onFinish(result) {
        pending.delete(clientMessageId);
        if (probe.mongoId) byMongoId.delete(probe.mongoId);
        if (result.ok) {
          scenario.completed += 1;
          for (const stage of ["http", "deliveryReceipt", "readReceipt"]) scenario.samples[stage].push(result.times[stage] - startAt);
          scenario.samples.socketDelivery.push(result.times.receive - startAt);
          scenario.samples.scheduledToReadReceipt.push(result.times.readReceipt - scheduledAt);
        } else {
          scenario.failed += 1;
          increment(scenario.failureReasons, result.reason);
          probe.abort?.();
        }
      } });
      Object.assign(probe, { sender, receiver, scenario });
      pending.set(clientMessageId, probe);
      scenario.peakInFlight = Math.max(scenario.peakInFlight, pending.size);
      if (!sender.socket.connected || !receiver.socket.connected) { probe.fail("SOCKET_DISCONNECTED"); return; }
      void request(`${config.baseUrl}/api/messages/send/${receiver.userId}`, sender.cookie,
        { clientMessageId, text: `load-test-${runId}` }, probe).then(({ response, data }) => {
        increment(scenario.httpStatuses, response.status);
        if (probe.finished) return;
        if (response.status !== 201) { probe.fail(`HTTP_${response.status}`); return; }
        if (data.clientMessageId !== clientMessageId || !bindMongoId(probe, data._id)) { probe.fail("CORRELATION_MISMATCH"); return; }
        probe.mark("http");
      }).catch(() => probe.fail("HTTP_NETWORK_OR_TIMEOUT"));
    };
    for (let index = 0; index < scenario.offered && !interrupted; index += 1) {
      const scheduledAt = start + index * 1000 / rate;
      await delay(scheduledAt - performance.now());
      if (!interrupted) dispatch(index, scheduledAt);
    }
    if (!interrupted) await delay(start + durationSeconds * 1000 - performance.now());
    const issueEnd = performance.now();
    await Promise.all([...pending.values()].map((probe) => probe.done));
    await Promise.allSettled([...receiptTasks]);
    const end = performance.now();
    clearInterval(memorySampler);
    lag.disable();
    const usage = process.cpuUsage(cpuStart);
    const summary = { ...scenario, samples: undefined,
      issueDurationMs: round(issueEnd - start), drainDurationMs: round(end - issueEnd),
      completedMessagesPerSecond: round(scenario.completed / ((end - start) / 1000)),
      errorRate: (scenario.failed + scenario.dropped) / scenario.offered,
      latencyMs: Object.fromEntries(Object.entries(scenario.samples).map(([key, values]) => [key, summarize(values)])),
      generator: { peakRssBytes: Math.max(peakRss, process.memoryUsage().rss),
        cpuPercentOfOneCore: round((usage.user + usage.system) / ((end - start) * 10)),
        eventLoopDelayP95Ms: round(lag.percentile(95) / 1e6), eventLoopDelayMaxMs: round(lag.max / 1e6) } };
    Object.assign(summary, checkThresholds(summary, config.thresholds));
    if (summary.socketDisconnects) { summary.passed = false; summary.failures.push("Socket disconnected during the scenario"); }
    if (interrupted) { summary.passed = false; summary.failures.push("Run interrupted"); }
    activeScenario = undefined;
    console.log(`${rate} msg/s: ${summary.completed}/${scenario.offered} completed; HTTP p95 ${summary.latencyMs.http.p95} ms; read p95 ${summary.latencyMs.readReceipt.p95} ms; ${summary.passed ? "PASS" : "FAIL"}`);
    return summary;
  };

  try {
    report.environment.backendAndHarnessSha256 = await fingerprint();
    await Promise.all([redis.connect(), mongoose.connect(config.mongoUrl, { serverSelectionTimeoutMS: 5000 })]);
    const redisInfo = await redis.info("server");
    report.environment.redisVersion = redisInfo.match(/redis_version:([^\r\n]+)/)?.[1];
    report.environment.mongoVersion = (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version;
    const ready = await request(`${config.baseUrl}/ready`);
    if (ready.response.status !== 200) throw new Error("Benchmark load balancer is not ready");
    report.environment.nginxVersion = ready.response.headers.get("server");
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const health = await request(`${config.baseUrl}/health`);
      if (health.response.status !== 200) throw new Error("Benchmark backend is unavailable");
      seen.add(health.data.instanceId);
    }
    if (seen.size !== 2) throw new Error("NGINX must reach exactly two distinct benchmark backends");
    await Promise.all([User.init(), Message.init()]);
    const password = await bcrypt.hash(randomUUID(), 10);
    for (let i = 0; i < config.pairs * 2; i += 1) users.push({ _id: new mongoose.Types.ObjectId(),
      fullName: `Load user ${i}`, email: `${runId}-${i}@example.test`, password });
    await User.insertMany(users);
    for (let i = 0; i < users.length; i += 2) {
      const first = await openSession(users[i]);
      const second = await openSession(users[i + 1], first.instanceId);
      pairs.push([first, second]);
    }
    report.crossInstancePairs = pairs.length;
    console.log(`Connected ${sessions.length} authenticated sockets through NGINX; all ${pairs.length} pairs span different backends.`);
    if (config.warmupSeconds) {
      report.warmup = await runScenario(Math.min(config.rates[0], 10), config.warmupSeconds);
      if (!report.warmup.passed) throw new Error("Warmup failed; measured scenarios were not started");
    }
    for (const rate of config.rates) {
      if (interrupted) throw new Error("Load run interrupted");
      report.scenarios.push(await runScenario(rate, config.durationSeconds));
    }
    const filter = { senderId: { $in: users.map((user) => user._id) } };
    const profiles = [report.warmup, ...report.scenarios].filter(Boolean);
    const expectedCreated = profiles.reduce((sum, profile) => sum + (profile.httpStatuses[201] || 0), 0);
    report.persistence = { expectedHttpCreated: expectedCreated,
      savedMessages: await Message.countDocuments(filter),
      savedReadReceipts: await Message.countDocuments({ ...filter, readAt: { $ne: null } }),
      uniqueMessageIds: (await Message.distinct("clientMessageId", filter)).length };
    report.persistence.passed = report.persistence.savedMessages === expectedCreated &&
      report.persistence.savedReadReceipts === expectedCreated && report.persistence.uniqueMessageIds === expectedCreated;
    report.passed = !interrupted && report.scenarios.length === config.rates.length &&
      report.scenarios.every((scenario) => scenario.passed) && report.persistence.passed;
  } catch (error) { report.fatalError = error.message; report.passed = false; }
  finally {
    stopping = true;
    for (const probe of [...pending.values()]) probe.fail("CLEANUP");
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...receiptTasks]);
    for (const session of sessions) session.socket.disconnect();
    await delay(200);
    report.cleanup.socketsClosed = sessions.length;
    if (mongoose.connection.readyState === 1) {
      try {
        const ids = users.map((user) => user._id);
        report.cleanup.messagesDeleted = (await Message.deleteMany({ senderId: { $in: ids } })).deletedCount;
        report.cleanup.usersDeleted = (await User.deleteMany({ _id: { $in: ids } })).deletedCount;
        report.cleanup.remainingOwnedUsers = await User.countDocuments({ _id: { $in: ids } });
        report.cleanup.remainingOwnedMessages = await Message.countDocuments({ senderId: { $in: ids } });
      } catch { report.cleanup.errors.push("Owned database record cleanup failed"); }
    } else if (users.length) report.cleanup.errors.push("Database unavailable during fixture cleanup");
    try {
      if (redis.status === "ready") {
        const keys = [];
        const rateKey = (policy, identity) => `${config.prefix}:rate:${policy}:${createHash("sha256").update(identity).digest("hex")}`;
        for (const user of users) for (const policy of ["send", "receipts", "upload"]) keys.push(rateKey(policy, user._id.toString()));
        for (const address of Object.values(os.networkInterfaces()).flat().filter((value) => value && !value.internal && value.family === "IPv4")) {
          for (const policy of ["api", "handshakes"]) keys.push(rateKey(policy, address.address));
        }
        report.cleanup.rateKeysDeleted = keys.length ? await redis.del(...keys) : 0;
      }
    } catch { report.cleanup.errors.push("Owned rate-key cleanup failed"); }
    if (report.cleanup.errors.length || report.cleanup.remainingOwnedUsers || report.cleanup.remainingOwnedMessages) report.passed = false;
    await Promise.allSettled([mongoose.disconnect(), redis.status === "ready" ? redis.quit() : Promise.resolve()]);
    redis.disconnect();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    report.finishedAt = new Date().toISOString();
  }
  return report;
};

const markdown = (report) => {
  const rows = report.scenarios.map((scenario) => `| ${scenario.targetMessagesPerSecond} | ${scenario.completed}/${scenario.offered} | ${scenario.completedMessagesPerSecond} | ${scenario.latencyMs.http.p95} | ${scenario.latencyMs.socketDelivery.p95} | ${scenario.latencyMs.readReceipt.p95} | ${scenario.latencyMs.readReceipt.p99} | ${round(scenario.errorRate * 100)}% | ${scenario.passed ? "PASS" : "FAIL"} |`);
  return ["# Local messaging load-test results", "", `Run: ${report.runId}; started: ${report.startedAt}; overall: **${report.passed ? "PASS" : "FAIL"}**.`, "",
    `Connected sockets: ${report.configuration.connectedSockets}; cross-instance pairs: ${report.crossInstancePairs}.`,
    `Source: ${report.environment.sourceRevision}; backend/harness SHA-256: ${report.environment.backendAndHarnessSha256}.`,
    `Host description: ${report.environment.hostDescription}.`, "",
    "| Offered msg/s | Completed/offered | Completed msg/s incl. drain | HTTP p95 ms | Delivery p95 ms | Read p95 ms | Read p99 ms | Error rate | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    "Latency samples include fully completed messages only. Failures/timeouts and dropped arrivals are reported separately in the JSON; do not interpret successful-message percentiles as a complete tail under overload.", "",
    "These are short, local, steady-state WebSocket/text-chat measurements with higher finite benchmark quotas. They are not production capacity, browser-user counts, failover benchmarks, or proof that two servers outperform one. Warmup/setup are excluded; completion throughput includes drain time. See the accompanying JSON and ../README.md for conditions and limitations.", "",
    `Persistence check: ${report.persistence?.passed ? "PASS" : "FAIL/not reached"}; cleanup errors: ${report.cleanup.errors.length}.`,
    ...(report.fatalError ? [`Failure: ${report.fatalError}`] : []), ""].join("\n");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = readLoadConfig(process.env);
    const report = await executeLoad(config);
    await mkdir(config.resultsDir, { recursive: true });
    const label = config.label || `${report.startedAt.slice(0, 10)}-${report.runId.slice(0, 8)}`;
    const base = `${config.resultsDir}/${label}`;
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    await writeFile(`${base}.md`, markdown(report), { flag: "wx" });
    console.log(`Saved results to ${base}.json and ${base}.md; overall ${report.passed ? "PASS" : "FAIL"}.`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { console.error(`Load test did not complete: ${error.message}`); process.exitCode = 1; }
}
