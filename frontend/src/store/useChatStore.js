import { create } from "zustand";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "./useAuthStore";

const MAX_SEND_ATTEMPTS = 3;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isRetryableSendError = (error) =>
  !error.response || error.response.status >= 500;

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

export const useChatStore = create((set, get) => ({
  messages: [],
  users: [],
  selectedUser: null,
  isUserLoading: false,
  isMessagesLoading: false,

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
    set({ isMessagesLoading: true });
    try {
      const res = await axiosInstance.get(`/messages/${userId}`);
      set({ messages: res.data });
    } catch (error) {
      toast.error(error.response.data.message);
    } finally {
      set({ isMessagesLoading: false });
    }
  },

  sendMessage: async (messageData) => {
    const { selectedUser } = get();
    const { authUser } = useAuthStore.getState();

    if (!selectedUser || !authUser) {
      throw new Error("A signed-in user and selected conversation are required");
    }

    const pendingMessage = {
      _id: messageData.clientMessageId,
      clientMessageId: messageData.clientMessageId,
      senderId: authUser._id,
      receiverId: selectedUser._id,
      text: messageData.text,
      image: messageData.image,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    set((state) => {
      if (state.selectedUser?._id !== selectedUser._id) return {};

      const existingMessage = state.messages.find(
        (message) =>
          message.clientMessageId === pendingMessage.clientMessageId
      );

      return {
        messages: upsertMessage(state.messages, {
          ...pendingMessage,
          createdAt: existingMessage?.createdAt || pendingMessage.createdAt,
        }),
      };
    });

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const res = await axiosInstance.post(
          `/messages/send/${selectedUser._id}`,
          messageData
        );

        set((state) => {
          if (state.selectedUser?._id !== selectedUser._id) return {};

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
          set((state) => {
            if (state.selectedUser?._id !== selectedUser._id) return {};

            return {
              messages: state.messages.map((message) =>
                message.clientMessageId === messageData.clientMessageId
                  ? { ...message, status: "failed" }
                  : message
              ),
            };
          });

          toast.error(
            error.response?.data?.message || "Failed to send message"
          );
          throw error;
        }

        const retryDelay = 1000 * 2 ** (attempt - 1);
        await wait(retryDelay);
      }
    }
  },
  subscribeToMessages: () => {
    const { selectedUser } = get();
    if (!selectedUser) return;

    const socket = useAuthStore.getState().socket;
    socket.on("newMessage", (newMessage) => {
      const isMessageFromSelectedUser =
        newMessage.senderId === selectedUser._id;
      if (!isMessageFromSelectedUser) return;
      set({ messages: [...get().messages, newMessage] });
    });
  },

  unsubscribeFromMessages: () => {
    const socket = useAuthStore.getState().socket;
    socket.off("newMessage");
  },

  setSelectedUser: (selectedUser) => set({ selectedUser }),
}));
