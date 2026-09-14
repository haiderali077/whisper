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
  } = useChatStore();
  const { authUser } = useAuthStore();
  const messageEndRef = useRef(null);

  useEffect(() => {
    getMessages(selectedUser._id);
  }, [selectedUser._id, getMessages]);

  useEffect(() => {
    if (messageEndRef.current && messages) {
      messageEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

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

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.clientMessageId || message._id}
            className={`chat ${
              message.senderId === authUser._id ? "chat-end" : "chat-start"
            }`}
            ref={messageEndRef}
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
      </div>

      <MessageInput />
    </div>
  );
};

export default ChatContainer;
