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
  },
  { timestamps: true }
);

messageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true }
);

const Message = mongoose.model("Message", messageSchema);

export default Message;
