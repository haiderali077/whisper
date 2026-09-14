import { useChatStore } from "../store/useChatStore";
import { useEffect, useRef } from "react";

import ChatHeader from "./ChatHeader";
import MessageInput from "./MessageInput";
import MessageSkeleton from "./skeletons/MessageSkeleton";
import { useAuthStore } from "../store/useAuthStore";

import { formatMessageTime } from "../lib/utils";
import {
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  Loader2,
  RotateCcw,
  WifiOff,
} from "lucide-react";

const ChatContainer = () => {
  const {
    messages,
    getMessages,
    isMessagesLoading,
    selectedUser,
    sendMessage,
    markMessagesRead,
    loadOlderMessages,
    hasMoreMessages,
    isOlderMessagesLoading,
  } = useChatStore();
  const { authUser } = useAuthStore();
  const messageEndRef = useRef(null);
  const previousLastMessageIdRef = useRef(null);
  const previousConversationIdRef = useRef(null);
  const isLoadingOlderRef = useRef(false);

  useEffect(() => {
    getMessages(selectedUser._id);
  }, [selectedUser._id, getMessages]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.clientMessageId || lastMessage?._id;
    const conversationChanged =
      previousConversationIdRef.current !== selectedUser._id;
    const receivedNewLastMessage =
      lastMessageId && lastMessageId !== previousLastMessageIdRef.current;

    if (
      messageEndRef.current &&
      (conversationChanged || receivedNewLastMessage)
    ) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth" });
    }

    previousConversationIdRef.current = selectedUser._id;
    previousLastMessageIdRef.current = lastMessageId;
  }, [messages, selectedUser._id]);

  useEffect(() => {
    const markVisibleMessagesRead = () => {
      if (document.visibilityState !== "visible") return;

      const unreadMessageIds = messages
        .filter(
          (message) =>
            message.senderId === selectedUser._id &&
            message.receiverId === authUser._id &&
            !message.readAt
        )
        .map((message) => message._id);

      markMessagesRead(unreadMessageIds);
    };

    markVisibleMessagesRead();
    document.addEventListener("visibilitychange", markVisibleMessagesRead);

    return () => {
      document.removeEventListener(
        "visibilitychange",
        markVisibleMessagesRead
      );
    };
  }, [authUser._id, markMessagesRead, messages, selectedUser._id]);

  const retryMessage = (message) => {
    void sendMessage({
      clientMessageId: message.clientMessageId,
      text: message.text || "",
      image: message.image || null,
      createdAt: message.createdAt,
    }).catch(() => {});
  };

  const handleMessagesScroll = async (event) => {
    const container = event.currentTarget;

    if (
      container.scrollTop > 80 ||
      !hasMoreMessages ||
      isOlderMessagesLoading ||
      isLoadingOlderRef.current
    ) {
      return;
    }

    isLoadingOlderRef.current = true;
    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;

    try {
      await loadOlderMessages();

      requestAnimationFrame(() => {
        container.scrollTop =
          container.scrollHeight - previousScrollHeight + previousScrollTop;
      });
    } finally {
      isLoadingOlderRef.current = false;
    }
  };

  if (isMessagesLoading) {
    return (
      <div className="flex-1 flex flex-col overflow-auto">
        <ChatHeader />
        <MessageSkeleton />
        <MessageInput />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-auto">
      <ChatHeader />

      <div
        className="flex-1 overflow-y-auto p-4 space-y-4"
        onScroll={handleMessagesScroll}
      >
        {isOlderMessagesLoading && (
          <div
            className="flex items-center justify-center gap-2 py-2 text-xs opacity-60"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" />
            Loading older messages...
          </div>
        )}

        {!hasMoreMessages && messages.length > 0 && (
          <p className="py-2 text-center text-xs opacity-50">
            Beginning of conversation
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.clientMessageId || message._id}
            className={`chat ${
              message.senderId === authUser._id ? "chat-end" : "chat-start"
            }`}
          >
            <div className=" chat-image avatar">
              <div className="size-10 rounded-full border">
                <img
                  src={
                    message.senderId === authUser._id
                      ? authUser.profilePic || "/avatar.png"
                      : selectedUser.profilePic || "/avatar.png"
                  }
                  alt="profile pic"
                />
              </div>
            </div>
            <div className="chat-header mb-1">
              <time className="text-xs opacity-50 ml-1">
                {formatMessageTime(message.createdAt)}
              </time>
            </div>
            <div className="chat-bubble flex flex-col">
              {message.image && (
                <img
                  src={message.image}
                  alt="Attachment"
                  className="sm:max-w-[200px] rounded-md mb-2"
                />
              )}
              {message.text && <p>{message.text}</p>}
            </div>
            {message.senderId === authUser._id && (
              <div
                className="chat-footer mt-1 min-h-4 text-xs opacity-70"
                aria-live="polite"
              >
                {message.status === "pending" && (
                  <span className="flex items-center gap-1">
                    <Clock3 className="size-3" />
                    Sending...
                  </span>
                )}

                {message.status === "queued" && (
                  <span className="flex items-center gap-1">
                    <WifiOff className="size-3" />
                    Waiting for connection
                  </span>
                )}

                {message.status === "failed" && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-error hover:underline"
                    onClick={() => retryMessage(message)}
                  >
                    <CircleAlert className="size-3" />
                    Failed to send
                    <RotateCcw className="ml-1 size-3" />
                    Retry
                  </button>
                )}

                {message.readAt && (
                  <span className="flex items-center gap-1 text-primary">
                    <CheckCheck className="size-3" />
                    Read
                  </span>
                )}

                {!message.readAt && message.deliveredAt && (
                  <span className="flex items-center gap-1">
                    <CheckCheck className="size-3" />
                    Delivered
                  </span>
                )}

                {!message.readAt &&
                  !message.deliveredAt &&
                  (!message.status || message.status === "sent") && (
                  <span className="flex items-center gap-1">
                    <Check className="size-3" />
                    Sent
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={messageEndRef} />
      </div>

      <MessageInput />
    </div>
  );
};

export default ChatContainer;
