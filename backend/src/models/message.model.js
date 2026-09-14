import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    clientMessageId: {
      type: String,
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
    },
    image: {
      type: String,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true }
);
messageSchema.index({
  senderId: 1,
  receiverId: 1,
  createdAt: -1,
  _id: -1,
});

const Message = mongoose.model("Message", messageSchema);

export default Message;
