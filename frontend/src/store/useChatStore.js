import { create } from "zustand";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "./useAuthStore";
import {
  getOutboxMessagesForUser,
  removeOutboxMessage,
  saveOutboxMessage,
} from "../lib/messageOutbox";

const MAX_SEND_ATTEMPTS = 3;
const RECEIPT_BATCH_SIZE = 100;
const MESSAGE_PAGE_SIZE = 30;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRetryableSendError = (error) =>
  !error.response || error.response.status >= 500;

const activeMessageIds = new Set();

const upsertMessage = (messages, incomingMessage) => {
  const existingMessageIndex = messages.findIndex(
    (message) =>
      message._id === incomingMessage._id ||
      (message.clientMessageId &&
        message.clientMessageId === incomingMessage.clientMessageId)
  );

  if (existingMessageIndex === -1) {
    return [...messages, incomingMessage];
  }

  const updatedMessages = [...messages];
  updatedMessages[existingMessageIndex] = incomingMessage;
  return updatedMessages;
};

const sortMessagesByTime = (messages) =>
  [...messages].sort((firstMessage, secondMessage) => {
    const timeDifference =
      new Date(firstMessage.createdAt) - new Date(secondMessage.createdAt);

    if (timeDifference !== 0) return timeDifference;
    return String(firstMessage._id).localeCompare(String(secondMessage._id));
  });

const mergeMessages = (currentMessages, incomingMessages) =>
  sortMessagesByTime(
    incomingMessages.reduce(
      (messages, message) => upsertMessage(messages, message),
      currentMessages
    )
  );

const applyMessageReceipts = (messages, receipts) => {
  const receiptsByMessageId = new Map(
    receipts.map((receipt) => [receipt.messageId, receipt])
  );

  return messages.map((message) => {
    const receipt = receiptsByMessageId.get(message._id);
    if (!receipt) return message;

    return {
      ...message,
      deliveredAt: receipt.deliveredAt,
      readAt: receipt.readAt,
    };
  });
};

const emitReceiptBatches = (socket, eventName, messageIds) => {
  for (let index = 0; index < messageIds.length; index += RECEIPT_BATCH_SIZE) {
    socket.emit(eventName, {
      messageIds: messageIds.slice(index, index + RECEIPT_BATCH_SIZE),
    });
  }
};

export const useChatStore = create((set, get) => ({
  messages: [],
  users: [],
  selectedUser: null,
  isUserLoading: false,
  isMessagesLoading: false,
  isOlderMessagesLoading: false,
  nextMessagesCursor: null,
  hasMoreMessages: false,

  getUserS: async () => {
    set({ isUserLoading: true });
    try {
      const res = await axiosInstance.get("/messages/users");
      set({ users: res.data });
    } catch (error) {
      toast.error(error.response.data.message);
    } finally {
      set({ isUserLoading: false });
    }
  },

  getMessages: async (userId) => {
    set({
      isMessagesLoading: true,
      isOlderMessagesLoading: false,
      nextMessagesCursor: null,
      hasMoreMessages: false,
    });
    const { authUser } = useAuthStore.getState();
    let serverMessages = [];
    let outboxMessages = [];
    let nextMessagesCursor = null;
    let hasMoreMessages = false;

    try {
      const res = await axiosInstance.get(`/messages/${userId}`, {
        params: { limit: MESSAGE_PAGE_SIZE },
      });
      serverMessages = res.data.messages;
      nextMessagesCursor = res.data.nextCursor;
      hasMoreMessages = res.data.hasMore;
    } catch (error) {
      if (error.response) {
        toast.error(error.response.data.message || "Failed to load messages");
      }
    }

    if (authUser) {
      try {
        const savedOutboxMessages = await getOutboxMessagesForUser(
          authUser._id
        );
        const savedServerIds = new Set(
          serverMessages
            .map((message) => message.clientMessageId)
            .filter(Boolean)
        );

        const alreadySavedMessages = savedOutboxMessages.filter((message) =>
          savedServerIds.has(message.clientMessageId)
        );

        await Promise.all(
          alreadySavedMessages.map((message) =>
            removeOutboxMessage(message.clientMessageId)
          )
        );

        outboxMessages = savedOutboxMessages.filter(
          (message) =>
            message.receiverId === userId &&
            !savedServerIds.has(message.clientMessageId)
        );
      } catch (error) {
        console.error("Failed to restore the message outbox:", error);
      }
    }

    const messages = sortMessagesByTime([
      ...serverMessages.map((message) =>
        message.senderId === authUser?._id
          ? { ...message, status: "sent" }
          : message
      ),
      ...outboxMessages,
    ]);

    set((state) =>
      state.selectedUser?._id === userId
        ? {
            messages,
            isMessagesLoading: false,
            nextMessagesCursor,
            hasMoreMessages,
          }
        : { isMessagesLoading: false }
    );

    const deliveredMessageIds = serverMessages
      .filter(
        (message) =>
          message.receiverId === authUser?._id && !message.deliveredAt
      )
      .map((message) => message._id);

    get().markMessagesDelivered(deliveredMessageIds);
  },

  loadOlderMessages: async () => {
    const {
      selectedUser,
      nextMessagesCursor,
      hasMoreMessages,
      isOlderMessagesLoading,
    } = get();

    if (
      !selectedUser ||
      !nextMessagesCursor ||
      !hasMoreMessages ||
      isOlderMessagesLoading
    ) {
      return;
    }

    const userId = selectedUser._id;
    const { authUser } = useAuthStore.getState();
    set({ isOlderMessagesLoading: true });

    try {
      const res = await axiosInstance.get(`/messages/${userId}`, {
        params: {
          limit: MESSAGE_PAGE_SIZE,
          cursor: nextMessagesCursor,
        },
      });

      const olderMessages = res.data.messages.map((message) =>
        message.senderId === authUser?._id
          ? { ...message, status: "sent" }
          : message
      );

      set((state) => {
        if (state.selectedUser?._id !== userId) return {};

        return {
          messages: mergeMessages(state.messages, olderMessages),
          nextMessagesCursor: res.data.nextCursor,
          hasMoreMessages: res.data.hasMore,
        };
      });

      const deliveredMessageIds = olderMessages
        .filter(
          (message) =>
            message.receiverId === authUser?._id && !message.deliveredAt
        )
        .map((message) => message._id);

      get().markMessagesDelivered(deliveredMessageIds);
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to load older messages"
      );
    } finally {
      set((state) =>
        state.selectedUser?._id === userId
          ? { isOlderMessagesLoading: false }
          : {}
      );
    }
  },

  sendMessage: async (messageData, receiverIdOverride) => {
    const { selectedUser } = get();
    const { authUser } = useAuthStore.getState();
    const receiverId = receiverIdOverride || selectedUser?._id;

    if (!receiverId || !authUser) {
      throw new Error("A signed-in user and selected conversation are required");
    }

    if (!messageData.clientMessageId) {
      throw new Error("clientMessageId is required");
    }

    if (activeMessageIds.has(messageData.clientMessageId)) return null;
    activeMessageIds.add(messageData.clientMessageId);

    const outboxMessage = {
      _id: messageData.clientMessageId,
      clientMessageId: messageData.clientMessageId,
      senderId: authUser._id,
      receiverId,
      text: messageData.text,
      image: messageData.image,
      createdAt: messageData.createdAt || new Date().toISOString(),
      status: navigator.onLine ? "pending" : "queued",
    };

    set((state) => {
      if (state.selectedUser?._id !== receiverId) return {};

      const existingMessage = state.messages.find(
        (message) =>
          message.clientMessageId === outboxMessage.clientMessageId
      );

      return {
        messages: upsertMessage(state.messages, {
          ...outboxMessage,
          createdAt: existingMessage?.createdAt || outboxMessage.createdAt,
        }),
      };
    });

    try {
      try {
        await saveOutboxMessage(outboxMessage);
      } catch (error) {
        const failedMessage = { ...outboxMessage, status: "failed" };

        set((state) => {
          if (state.selectedUser?._id !== receiverId) return {};

          return {
            messages: upsertMessage(state.messages, failedMessage),
          };
        });

        toast.error("Could not save this message for offline retry");
        throw error;
      }

      if (!navigator.onLine) {
        return outboxMessage;
      }

      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        try {
          const res = await axiosInstance.post(
            `/messages/send/${receiverId}`,
            {
              clientMessageId: messageData.clientMessageId,
              text: messageData.text,
              image: messageData.image,
            }
          );

          try {
            await removeOutboxMessage(messageData.clientMessageId);
          } catch (error) {
            console.error("Failed to remove a sent outbox message:", error);
          }

          set((state) => {
            if (state.selectedUser?._id !== receiverId) return {};

            return {
              messages: upsertMessage(state.messages, {
                ...res.data,
                status: "sent",
              }),
            };
          });

          return res.data;
        } catch (error) {
          const hasAttemptsRemaining = attempt < MAX_SEND_ATTEMPTS;

          if (!isRetryableSendError(error) || !hasAttemptsRemaining) {
            const finalStatus = navigator.onLine ? "failed" : "queued";
            const unsentMessage = { ...outboxMessage, status: finalStatus };

            await saveOutboxMessage(unsentMessage);

            set((state) => {
              if (state.selectedUser?._id !== receiverId) return {};

              return {
                messages: upsertMessage(state.messages, unsentMessage),
              };
            });

            if (finalStatus === "failed") {
              toast.error(
                error.response?.data?.message || "Failed to send message"
              );
              throw error;
            }

            return unsentMessage;
          }

          const retryDelay = 1000 * 2 ** (attempt - 1);
          await wait(retryDelay);
        }
      }
    } finally {
      activeMessageIds.delete(messageData.clientMessageId);
    }
  },
  syncOutbox: async () => {
    const { authUser } = useAuthStore.getState();
    if (!authUser || !navigator.onLine) return;

    try {
      const outboxMessages = await getOutboxMessagesForUser(authUser._id);

      for (const message of outboxMessages) {
        try {
          await get().sendMessage(
            {
              clientMessageId: message.clientMessageId,
              text: message.text,
              image: message.image,
              createdAt: message.createdAt,
            },
            message.receiverId
          );
        } catch {
          // sendMessage keeps failed messages in the outbox for a later retry.
        }
      }
    } catch (error) {
      console.error("Failed to synchronize the message outbox:", error);
    }
  },
  subscribeToMessages: () => {
    const socket = useAuthStore.getState().socket;
    if (!socket) return;

    socket.off("newMessage");
    socket.off("messageStatusUpdated");

    socket.on("newMessage", (newMessage) => {
      get().markMessagesDelivered([newMessage._id]);

      const { selectedUser } = get();
      const isMessageFromSelectedUser =
        newMessage.senderId === selectedUser?._id;
      if (!isMessageFromSelectedUser) return;

      set((state) => ({
        messages: upsertMessage(state.messages, newMessage),
      }));
    });

    socket.on("messageStatusUpdated", ({ receipts = [] }) => {
      set((state) => ({
        messages: applyMessageReceipts(state.messages, receipts),
      }));
    });
  },

  unsubscribeFromMessages: () => {
    const socket = useAuthStore.getState().socket;
    socket?.off("newMessage");
    socket?.off("messageStatusUpdated");
  },

  markMessagesDelivered: (messageIds) => {
    if (messageIds.length === 0) return;

    const socket = useAuthStore.getState().socket;
    if (!socket?.connected) return;

    emitReceiptBatches(socket, "messagesDelivered", messageIds);
  },

  markMessagesRead: (messageIds) => {
    if (messageIds.length === 0) return;

    const socket = useAuthStore.getState().socket;
    if (!socket?.connected) return;

    emitReceiptBatches(socket, "messagesRead", messageIds);
  },

  setSelectedUser: (selectedUser) => set({ selectedUser }),
}));
