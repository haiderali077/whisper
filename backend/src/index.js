import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "node:url";

import { connectDB } from "./lib/db.js";
import authRoutes from "./routes/auth.route.js";
import messageRoutes from "./routes/message.route.js";
import { app, server, initializeRealtime, closeRealtime } from "./lib/socket.js";
import { config, validateEnvironment } from "./lib/config.js";
import { connectRedis, closeRedis, redisIsReady } from "./lib/redis.js";
import { apiLimiter } from "./lib/rateLimit.js";
import User from "./models/user.model.js";
import Message from "./models/message.model.js";

app.set("trust proxy", config.trustProxy);
app.use((req, res, next) => {
  res.set("X-Instance-Id", config.instanceId);
  next();
});
app.get("/health", (req, res) => res.json({ status: "alive", instanceId: config.instanceId }));
app.get("/ready", (req, res) => {
  const ready = redisIsReady() && mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable", instanceId: config.instanceId });
});
app.use(cookieParser());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use("/api", (req, res, next) => {
  if (redisIsReady() && mongoose.connection.readyState === 1) return next();
  res.set("Retry-After", "5");
  return res.status(503).json({ message: "Service temporarily unavailable" });
}, apiLimiter);
// Bound parsing work; the general limiter runs before parsing large upload bodies.
app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);

if (config.serveFrontend) {
  const frontendDist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
  app.use(express.static(frontendDist));

  app.get("/*path", (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found" });
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ message: status === 413 ? "Request body too large" : status === 400 ? "Invalid JSON" : "Internal server error" });
});

let shuttingDown = false;
const shutdown = async (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  console.log(`[${config.instanceId}] Shutting down`);
  try {
    await closeRealtime();
    await Promise.all([closeRedis(), mongoose.disconnect()]);
  } finally {
    clearTimeout(deadline);
    process.exit(exitCode);
  }
};

process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

try {
  validateEnvironment();
  await Promise.all([connectDB(), connectRedis()]);
  // Cross-node idempotency depends on the unique sender/clientMessageId index.
  await Promise.all([User.init(), Message.init()]);
  await initializeRealtime();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, resolve);
  });
  console.log(`[${config.instanceId}] Listening on port ${config.port}`);
} catch {
  console.error("Backend startup failed. Check required environment variables and MongoDB/Redis connectivity.");
  await shutdown(1);
}
