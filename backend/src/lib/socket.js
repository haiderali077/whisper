import "dotenv/config";
import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { parse } from "cookie";
import { Server } from "socket.io";

import Message from "../models/message.model.js";
import User from "../models/user.model.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173"],
    credentials: true,
  },
});

const connectedSocketsByUser = new Map();

export const getUserRoom = (userId) => `user:${userId.toString()}`;

const emitOnlineUsers = () => {
  io.emit("getOnlineUsers", [...connectedSocketsByUser.keys()]);
};

const getValidMessageIds = (messageIds) => {
  if (!Array.isArray(messageIds)) return [];

  return [
    ...new Set(messageIds.filter((id) => mongoose.isValidObjectId(id))),
  ].slice(0, 100);
};

const createReceipt = (message) => ({
  messageId: message._id.toString(),
  deliveredAt: message.deliveredAt,
  readAt: message.readAt,
});

io.use(async (socket, next) => {
  try {
    const cookies = parse(socket.handshake.headers.cookie || "");
    const token = cookies.jwt;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select("_id");

    if (!user) {
      return next(new Error("Authentication failed"));
    }

    socket.data.userId = user._id.toString();
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.data.userId;
  const userRoom = getUserRoom(userId);
  const userSockets = connectedSocketsByUser.get(userId) || new Set();

  userSockets.add(socket.id);
  connectedSocketsByUser.set(userId, userSockets);
  socket.join(userRoom);
  emitOnlineUsers();

  socket.on("messagesDelivered", async (payload = {}, acknowledge) => {
    const respond =
      typeof acknowledge === "function" ? acknowledge : () => {};
    const messageIds = getValidMessageIds(payload.messageIds);

    if (messageIds.length === 0) {
      return respond({ ok: false, error: "Valid message IDs are required" });
    }

    try {
      const undeliveredMessages = await Message.find({
        _id: { $in: messageIds },
        receiverId: userId,
        deliveredAt: null,
      }).select("_id senderId");

      if (undeliveredMessages.length > 0) {
        const deliveredAt = new Date();
        const undeliveredIds = undeliveredMessages.map(
          (message) => message._id
        );

        await Message.updateMany(
          { _id: { $in: undeliveredIds }, receiverId: userId },
          { $set: { deliveredAt } }
        );
      }

      const deliveredMessages = await Message.find({
        _id: { $in: messageIds },
        receiverId: userId,
      }).select("_id senderId deliveredAt readAt");

      const receiptsBySender = new Map();

      for (const message of deliveredMessages) {
        const senderId = message.senderId.toString();
        const senderReceipts = receiptsBySender.get(senderId) || [];
        senderReceipts.push(createReceipt(message));
        receiptsBySender.set(senderId, senderReceipts);
      }

      for (const [senderId, receipts] of receiptsBySender) {
        io.to(getUserRoom(senderId)).emit("messageStatusUpdated", {
          receipts,
        });
      }

      const receipts = deliveredMessages.map(createReceipt);
      io.to(userRoom).emit("messageStatusUpdated", { receipts });
      respond({ ok: true, receipts });
    } catch (error) {
      console.error("Failed to record delivered messages:", error.message);
      respond({ ok: false, error: "Could not update delivered messages" });
    }
  });

  socket.on("messagesRead", async (payload = {}, acknowledge) => {
    const respond =
      typeof acknowledge === "function" ? acknowledge : () => {};
    const messageIds = getValidMessageIds(payload.messageIds);

    if (messageIds.length === 0) {
      return respond({ ok: false, error: "Valid message IDs are required" });
    }

    try {
      const messages = await Message.find({
        _id: { $in: messageIds },
        receiverId: userId,
      }).select("_id senderId deliveredAt readAt");

      const unreadMessageIds = messages
        .filter((message) => !message.readAt)
        .map((message) => message._id);

      if (unreadMessageIds.length > 0) {
        const readAt = new Date();

        await Message.updateMany(
          { _id: { $in: unreadMessageIds }, receiverId: userId },
          [
            {
              $set: {
                deliveredAt: { $ifNull: ["$deliveredAt", readAt] },
                readAt: { $ifNull: ["$readAt", readAt] },
              },
            },
          ]
        );
      }

      const readMessages = await Message.find({
        _id: { $in: messageIds },
        receiverId: userId,
      }).select("_id senderId deliveredAt readAt");

      const receiptsBySender = new Map();

      for (const message of readMessages) {
        const senderId = message.senderId.toString();
        const senderReceipts = receiptsBySender.get(senderId) || [];
        senderReceipts.push(createReceipt(message));
        receiptsBySender.set(senderId, senderReceipts);
      }

      for (const [senderId, receipts] of receiptsBySender) {
        io.to(getUserRoom(senderId)).emit("messageStatusUpdated", {
          receipts,
        });
      }

      const receipts = readMessages.map(createReceipt);
      io.to(userRoom).emit("messageStatusUpdated", { receipts });
      respond({ ok: true, receipts });
    } catch (error) {
      console.error("Failed to record read messages:", error.message);
      respond({ ok: false, error: "Could not update read messages" });
    }
  });

  socket.on("disconnect", () => {
    const currentUserSockets = connectedSocketsByUser.get(userId);
    currentUserSockets?.delete(socket.id);

    if (!currentUserSockets || currentUserSockets.size === 0) {
      connectedSocketsByUser.delete(userId);
    }

    emitOnlineUsers();
  });
});

export { io, app, server };
