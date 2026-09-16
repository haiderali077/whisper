import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { io } from "socket.io-client";
import User from "../src/models/user.model.js";
import Message from "../src/models/message.model.js";
import { syncPresence, presenceMember } from "../src/lib/presence.js";
import { consumeRateLimit } from "../src/lib/rateLimit.js";
import { closeRedis } from "../src/lib/redis.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, description, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  assert.fail(`Timed out: ${description}`);
};

const eventMatching = (socket, event, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, 5000);
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
});

test("Milestone 2: real Redis, MongoDB, two backends, and NGINX", { timeout: 180000 }, async (t) => {
  for (const name of ["TEST_BACKEND_A_URL", "TEST_BACKEND_B_URL", "TEST_LOAD_BALANCER_URL", "TEST_REDIS_URL", "TEST_MONGODB_URI", "TEST_JWT_SECRET"]) {
    assert.ok(process.env[name], `${name} is required; use the Compose integration-tests service, never your production database`);
  }
  const aUrl = process.env.TEST_BACKEND_A_URL;
  const bUrl = process.env.TEST_BACKEND_B_URL;
  const lbUrl = process.env.TEST_LOAD_BALANCER_URL;
  const prefix = process.env.REDIS_PREFIX || "whisper";
  const runId = randomUUID();
  const ip = `198.18.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`;
  const clients = [0, 1].map(() => new Redis(process.env.TEST_REDIS_URL, {
    connectTimeout: 5000, commandTimeout: 3000, maxRetriesPerRequest: 1,
  }));
  const sockets = [];
  const children = [];
  const proxies = [];
  const userIds = [];
  const ownedKeys = new Set();
  const rateKey = (policy, identity, namespace = prefix) =>
    `${namespace}:rate:${policy}:${createHash("sha256").update(identity).digest("hex")}`;
  for (const policy of ["auth", "api", "handshakes"]) ownedKeys.add(rateKey(policy, ip));

  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const proxy of proxies) await proxy.stop();
    await delay(200);
    try {
      // Delete only accounts/messages created by this run, never collections or databases.
      if (mongoose.connection.readyState === 1 && userIds.length) {
        await Message.deleteMany({ senderId: { $in: userIds } });
        await User.deleteMany({ _id: { $in: userIds } });
      }
      if (ownedKeys.size) await clients[0].del(...ownedKeys);
    } finally {
      await mongoose.disconnect();
      await Promise.allSettled(clients.map((client) => client.quit()));
      clients.forEach((client) => client.disconnect());
      await closeRedis();
    }
  });

  const request = async (base, route, { cookie, method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await response.json();
    return { response, data };
  };
  const signup = async (name) => {
    const { response, data } = await request(aUrl, "/api/auth/signup", {
      method: "POST", body: { fullName: name, email: `${runId}-${name}@example.test`, password: "integration-only-password" },
    });
    assert.equal(response.status, 201, "disposable test signup must succeed");
    userIds.push(data._id);
    for (const policy of ["send", "upload", "receipts"]) ownedKeys.add(rateKey(policy, data._id));
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("jwt="), "signup returns an authentication cookie");
    return { ...data, cookie };
  };
  const openSocket = async (base, cookie, transports = ["websocket"]) => {
    const socket = io(base, { autoConnect: false, reconnection: false, forceNew: true,
      transports, extraHeaders: { Cookie: cookie, "X-Forwarded-For": ip } });
    sockets.push(socket);
    socket.onlineUsers = [];
    socket.on("getOnlineUsers", (ids, metadata) => {
      if (socket.presenceEpoch === metadata?.epoch && socket.presenceRevision >= metadata?.revision) return;
      socket.presenceEpoch = metadata?.epoch;
      socket.presenceRevision = metadata?.revision;
      socket.onlineUsers = ids;
    });
    socket.on("serverInfo", ({ instanceId }) => { socket.instanceId = instanceId; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket connection timed out")), 6000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
      socket.connect();
    });
    await waitUntil(() => socket.instanceId, "server identifies the socket's instance");
    return socket;
  };
  const exchange = async (sender, receiver, senderUser, receiverUser, apiUrl) => {
    const clientMessageId = randomUUID();
    const pendingMessage = eventMatching(receiver, "newMessage", (message) => message.clientMessageId === clientMessageId);
    const { response, data } = await request(apiUrl, `/api/messages/send/${receiverUser._id}`, {
      cookie: senderUser.cookie, method: "POST", body: { clientMessageId, text: `cross-instance-${runId}` },
    });
    assert.equal(response.status, 201);
    const incoming = await pendingMessage;
    assert.equal(incoming._id, data._id);
    assert.equal(incoming.senderId, senderUser._id);

    const deliveredEvent = eventMatching(sender, "messageStatusUpdated", ({ receipts }) => receipts.some((receipt) => receipt.messageId === data._id && receipt.deliveredAt));
    const delivered = await receiver.timeout(5000).emitWithAck("messagesDelivered", { messageIds: [data._id] });
    assert.equal(delivered.ok, true);
    await deliveredEvent;

    const readEvent = eventMatching(sender, "messageStatusUpdated", ({ receipts }) => receipts.some((receipt) => receipt.messageId === data._id && receipt.readAt));
    const read = await receiver.timeout(5000).emitWithAck("messagesRead", { messageIds: [data._id] });
    assert.equal(read.ok, true);
    await readEvent;
    const saved = await Message.findById(data._id).lean();
    assert.ok(saved.deliveredAt instanceof Date && saved.readAt instanceof Date);
    assert.ok(saved.deliveredAt <= saved.readAt);
    return { ...data, clientMessageId };
  };

  await Promise.all(clients.map((client) => client.ping()));
  await mongoose.connect(process.env.TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), Message.init()]);
  const alice = await signup("alice");
  const bob = await signup("bob");
  const charlie = await signup("charlie");
  let aliceSocket;
  let bobSocket;
  let aliceLb;
  let bobLb;
  let firstMessage;

  await t.test("both backends are ready and NGINX serves the frontend", async () => {
    const a = await request(aUrl, "/ready");
    const b = await request(bUrl, "/ready");
    assert.equal(a.response.status, 200);
    assert.equal(b.response.status, 200);
    assert.notEqual(a.data.instanceId, b.data.instanceId);
    const page = await fetch(lbUrl, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
  });

  await t.test("NGINX distributes ordinary HTTP requests across both backends", async () => {
    const instances = new Set();
    for (let index = 0; index < 12; index += 1) instances.add((await request(lbUrl, "/health")).data.instanceId);
    assert.equal(instances.size, 2);
  });

  await t.test("NGINX overwrites untrusted X-Forwarded-For headers", async () => {
    const spoofedIp = "203.0.113.123";
    const key = rateKey("api", spoofedIp);
    assert.equal(await clients[0].exists(key), 0, "the isolated local stack has no prior spoofed-IP counter");
    const { response } = await request(lbUrl, "/api/auth/check", { cookie: alice.cookie, headers: { "X-Forwarded-For": spoofedIp } });
    assert.equal(response.status, 200);
    assert.equal(await clients[0].exists(key), 0, "the limiter must not use a client-supplied forwarding header through NGINX");
  });

  await t.test("unauthenticated Socket.IO connections are rejected", async () => {
    await assert.rejects(openSocket(aUrl, ""), /Authentication required/);
  });

  await t.test("messages and delivered/read receipts cross different backend instances in both directions", async () => {
    aliceSocket = await openSocket(aUrl, alice.cookie);
    bobSocket = await openSocket(bUrl, bob.cookie);
    assert.notEqual(aliceSocket.instanceId, bobSocket.instanceId);
    await waitUntil(() => [aliceSocket, bobSocket].every((socket) => socket.onlineUsers.includes(alice._id) && socket.onlineUsers.includes(bob._id)), "shared presence on both instances");
    firstMessage = await exchange(aliceSocket, bobSocket, alice, bob, aUrl);
    await exchange(bobSocket, aliceSocket, bob, alice, bUrl);
  });

  await t.test("retrying a send on another backend creates no duplicate message", async () => {
    const retry = await request(bUrl, `/api/messages/send/${bob._id}`, {
      cookie: alice.cookie, method: "POST", body: { clientMessageId: firstMessage.clientMessageId, text: "retry" },
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data._id, firstMessage._id);
    assert.equal(await Message.countDocuments({ senderId: alice._id, clientMessageId: firstMessage.clientMessageId }), 1);
  });

  await t.test("a sender cannot mark their own outgoing message as read", async () => {
    const result = await aliceSocket.timeout(5000).emitWithAck("messagesRead", { messageIds: [firstMessage._id] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.receipts, []);
  });

  await t.test("closing one of a user's sockets keeps their other device online", async () => {
    const extraBob = await openSocket(aUrl, bob.cookie);
    bobSocket.disconnect();
    await delay(300);
    assert.ok(aliceSocket.onlineUsers.includes(bob._id));
    extraBob.disconnect();
    await waitUntil(() => !aliceSocket.onlineUsers.includes(bob._id), "last Bob connection removes presence");
    bobSocket = await openSocket(bUrl, bob.cookie);
  });

  await t.test("NGINX keeps polling sessions sticky and allows different users on different nodes", async () => {
    aliceLb = await openSocket(lbUrl, alice.cookie, ["polling"]);
    // A signed test-only jti changes the hash key without creating more accounts.
    // Stop once Bob lands on a different backend; never weaken server authentication.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const cookie = `jwt=${jwt.sign({ userId: bob._id, jti: randomUUID() }, process.env.TEST_JWT_SECRET, { expiresIn: "5m" })}`;
      const candidate = await openSocket(lbUrl, cookie, ["polling"]);
      if (candidate.instanceId !== aliceLb.instanceId) { bobLb = candidate; break; }
      candidate.disconnect();
    }
    assert.ok(bobLb, "two authenticated users must reach different nodes through NGINX");
    assert.equal(aliceLb.io.engine.transport.name, "polling");
    await exchange(aliceLb, bobLb, alice, bob, lbUrl);
    await delay(500);
    assert.ok(aliceLb.connected && bobLb.connected, "repeated polling requests remain on their original node");
  });

  await t.test("WebSocket upgrade works through NGINX", async () => {
    const upgraded = await openSocket(lbUrl, alice.cookie, ["polling", "websocket"]);
    await waitUntil(() => upgraded.io.engine.transport.name === "websocket", "polling upgrades to WebSocket");
    upgraded.disconnect();
  });

  await t.test("concurrent delivery/read updates from different devices preserve receipt timestamps", async () => {
    const otherDevice = await openSocket(aUrl, bob.cookie);
    const clientMessageId = randomUUID();
    const pendingMessage = eventMatching(bobSocket, "newMessage", (message) => message.clientMessageId === clientMessageId);
    const { response, data } = await request(aUrl, `/api/messages/send/${bob._id}`, {
      cookie: alice.cookie, method: "POST", body: { clientMessageId, text: "concurrent receipt test" },
    });
    assert.equal(response.status, 201);
    await pendingMessage;
    await Promise.all([
      bobSocket.timeout(5000).emitWithAck("messagesDelivered", { messageIds: [data._id] }),
      otherDevice.timeout(5000).emitWithAck("messagesRead", { messageIds: [data._id] }),
    ]);
    const before = await Message.findById(data._id).lean();
    assert.ok(before.deliveredAt <= before.readAt);
    await Promise.all([
      otherDevice.timeout(5000).emitWithAck("messagesDelivered", { messageIds: [data._id] }),
      bobSocket.timeout(5000).emitWithAck("messagesRead", { messageIds: [data._id] }),
    ]);
    const after = await Message.findById(data._id).lean();
    assert.equal(after.deliveredAt.getTime(), before.deliveredAt.getTime());
    assert.equal(after.readAt.getTime(), before.readAt.getTime());
    otherDevice.disconnect();
  });

  const startChild = async (overrides = {}) => {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const assigned = probe.address().port;
        probe.close(() => resolve(assigned));
      });
    });
    const child = spawn(process.execPath, ["src/index.js"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), INSTANCE_ID: `test-child-${randomUUID()}`,
        NODE_ENV: "development", SERVE_FRONTEND: "false", MONGODB_URI: process.env.TEST_MONGODB_URI,
        REDIS_URL: process.env.TEST_REDIS_URL, JWT_SECRET: process.env.TEST_JWT_SECRET,
        PRESENCE_HEARTBEAT_MS: "1000", PRESENCE_LEASE_MS: "6000", ...overrides },
    });
    children.push(child);
    // Consume output without printing environment variables or credentials.
    child.stdout.resume();
    child.stderr.resume();
    const url = `http://127.0.0.1:${port}`;
    await waitUntil(async () => {
      assert.ok(child.exitCode === null, "isolated test backend must stay running");
      try { return (await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, "isolated test backend starts");
    return { child, url };
  };

  await t.test("a hard-killed backend's presence expires without a disconnect handler", async () => {
    const { child, url } = await startChild();
    await openSocket(url, charlie.cookie);
    await waitUntil(() => aliceLb.onlineUsers.includes(charlie._id), "Charlie appears across the cluster");
    child.kill("SIGKILL");
    await waitUntil(() => child.signalCode === "SIGKILL", "test backend was hard-killed");
    await waitUntil(() => !aliceLb.onlineUsers.includes(charlie._id), "dead instance's presence lease expires", 10000);
    assert.ok(aliceLb.connected && bobLb.connected);
  });

  await t.test("graceful shutdown exits successfully and removes presence", async () => {
    const { child, url } = await startChild();
    await openSocket(url, charlie.cookie);
    await waitUntil(() => aliceLb.onlineUsers.includes(charlie._id), "Charlie is online before graceful shutdown");
    child.kill("SIGTERM");
    await waitUntil(() => child.exitCode !== null, "graceful backend shutdown");
    assert.equal(child.exitCode, 0);
    await waitUntil(() => !aliceLb.onlineUsers.includes(charlie._id), "graceful presence cleanup");
  });

  await t.test("Redis network loss fails closed and subscriptions recover for existing sockets", async () => {
    // Partition only these two test-owned backends with a TCP proxy. Do not stop
    // the real Redis container or mount the Docker socket inside the test runner.
    const upstream = new URL(process.env.TEST_REDIS_URL);
    assert.equal(upstream.protocol, "redis:", "this fault-injection proxy is for local non-TLS Redis only");
    const connections = new Set();
    const server = net.createServer((source) => {
      const target = net.connect(Number(upstream.port || 6379), upstream.hostname);
      connections.add(source);
      connections.add(target);
      source.on("error", () => {});
      target.on("error", () => {});
      source.on("close", () => { connections.delete(source); target.destroy(); });
      target.on("close", () => { connections.delete(target); source.destroy(); });
      source.pipe(target).pipe(source);
    });
    const listen = (port) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const proxy = { stop: async () => {
      connections.forEach((connection) => connection.destroy());
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    } };
    proxies.push(proxy);
    await listen(0);
    const port = server.address().port;
    const namespace = `fault_${runId.replaceAll("-", "_")}`;
    for (const suffix of ["connections", "epoch", "revision"]) ownedKeys.add(`{${namespace}}:presence:${suffix}`);
    for (const policy of ["api", "handshakes"]) ownedKeys.add(rateKey(policy, ip, namespace));
    for (const user of [alice, bob]) for (const policy of ["send", "receipts"]) ownedKeys.add(rateKey(policy, user._id, namespace));
    const overrides = { REDIS_URL: `redis://127.0.0.1:${port}`, REDIS_PREFIX: namespace };
    const first = await startChild(overrides);
    const second = await startChild(overrides);
    const sender = await openSocket(first.url, alice.cookie);
    const receiver = await openSocket(second.url, bob.cookie);
    await exchange(sender, receiver, alice, bob, first.url);
    await proxy.stop();
    await waitUntil(async () => (await request(first.url, "/ready")).response.status === 503, "Redis partition changes readiness to unavailable");
    assert.equal((await request(first.url, "/health")).response.status, 200);
    assert.equal((await request(first.url, "/api/auth/check", { cookie: alice.cookie })).response.status, 503);
    const rejected = await receiver.timeout(5000).emitWithAck("messagesRead", { messageIds: [firstMessage._id] });
    assert.equal(rejected.code, "SERVICE_UNAVAILABLE");
    assert.ok(sender.connected && receiver.connected, "Redis loss does not itself close existing WebSockets");
    await listen(port);
    await waitUntil(async () => (await request(first.url, "/ready")).response.status === 200 &&
      (await request(second.url, "/ready")).response.status === 200, "Redis clients reconnect", 15000);
    // Exercise the same sockets after reconnection: their pub/sub subscriptions
    // must be restored, not merely replaced by newly connected clients.
    await exchange(sender, receiver, alice, bob, first.url);
    sender.disconnect();
    receiver.disconnect();
    first.child.kill("SIGTERM");
    second.child.kill("SIGTERM");
    await waitUntil(() => first.child.exitCode === 0 && second.child.exitCode === 0, "fault-test backends shut down cleanly");
    await proxy.stop();
  });

  await t.test("real Redis presence preserves multiple connections and resets its epoch after state loss", async () => {
    const namespace = `test_${runId.replaceAll("-", "_")}`;
    const keys = ["connections", "epoch", "revision"].map((suffix) => `{${namespace}}:presence:${suffix}`);
    keys.forEach((key) => ownedKeys.add(key));
    const first = await syncPresence(clients[0], namespace, 500, [presenceMember("alice", "1"), presenceMember("alice", "2"), presenceMember("bob", "3")]);
    assert.deepEqual(first.userIds, ["alice", "bob"]);
    const second = await syncPresence(clients[1], namespace, 500, [], [presenceMember("alice", "1")]);
    assert.deepEqual(second.userIds, ["alice", "bob"]);
    assert.ok(second.revision > first.revision);
    await delay(650);
    assert.deepEqual((await syncPresence(clients[0], namespace, 500)).userIds, []);
    await clients[0].del(...keys);
    const restarted = await syncPresence(clients[1], namespace, 500, [presenceMember("alice", "4")]);
    assert.notEqual(restarted.epoch, first.epoch);
    assert.equal(restarted.revision, 1);
  });

  await t.test("atomic rate limiting across two Redis clients enforces one quota and expires", async () => {
    const identity = runId;
    const key = rateKey("integration", identity);
    ownedKeys.add(key);
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      consumeRateLimit(clients[index % 2], prefix, "integration", identity, 10, 1000)));
    assert.equal(results.filter((result) => result.allowed).length, 10);
    await delay(1100);
    assert.equal((await consumeRateLimit(clients[1], prefix, "integration", identity, 10, 1000)).allowed, true);
  });

  await t.test("HTTP message quotas are shared across backends and return 429 with Retry-After", async () => {
    const limit = Number(process.env.RATE_LIMIT_SEND || 60);
    await clients[0].del(rateKey("send", charlie._id));
    for (let index = 0; index <= limit; index += 1) {
      const { response } = await request(index % 2 ? aUrl : bUrl, "/api/messages/send/invalid-id", {
        cookie: charlie.cookie, method: "POST", body: { clientMessageId: randomUUID(), text: "invalid receiver creates no message" },
      });
      assert.equal(response.status, index < limit ? 400 : 429);
      if (index === limit) assert.ok(Number(response.headers.get("retry-after")) >= 1);
    }
  });

  await t.test("receipt quotas apply across sockets on different backends", async () => {
    await clients[0].del(rateKey("receipts", bob._id));
    const limit = Number(process.env.RATE_LIMIT_RECEIPTS || 120);
    for (let index = 0; index <= limit; index += 1) {
      const result = await (index % 2 ? bobSocket : bobLb).timeout(5000).emitWithAck("messagesDelivered", { messageIds: [] });
      assert.equal(result.ok, false);
      if (index === limit) assert.equal(result.code, "RATE_LIMITED");
      else assert.equal(result.error, "Valid message IDs are required");
    }
  });

  await t.test("login quotas are shared across backends and cannot be reset by changing nodes", async () => {
    await clients[0].del(rateKey("auth", ip));
    const limit = Number(process.env.RATE_LIMIT_AUTH || 20);
    for (let index = 0; index <= limit; index += 1) {
      const { response } = await request(index % 2 ? aUrl : bUrl, "/api/auth/login", {
        method: "POST", body: { email: `missing-${runId}@example.test`, password: "invalid-password" },
      });
      assert.equal(response.status, index < limit ? 400 : 429);
    }
  });
});
