import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import cloudinary from "../lib/cloudinary.js";
import { getUserRoom, io } from "../lib/socket.js";

export const getUsersForSideBar = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;

    // Get all users except the logged-in user
    const users = await User.find({
      _id: { $ne: loggedInUserId },
    }).select("-password");

    // Get the most recent message for each conversation
    const recentMessages = await Message.aggregate([
      {
        $match: {
          $or: [
            { senderId: loggedInUserId },
            { receiverId: loggedInUserId }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$senderId", loggedInUserId] },
              "$receiverId",
              "$senderId"
            ]
          },
          lastMessage: { $first: "$$ROOT" }
        }
      }
    ]);

    // Create a map of userId to last message timestamp
    const lastMessageMap = new Map(
      recentMessages.map(msg => [msg._id.toString(), msg.lastMessage.createdAt])
    );

    // Sort users based on their last message timestamp
    const sortedUsers = users.sort((a, b) => {
      const aLastMessage = lastMessageMap.get(a._id.toString());
      const bLastMessage = lastMessageMap.get(b._id.toString());
      
      if (!aLastMessage) return 1;
      if (!bLastMessage) return -1;
      
      return bLastMessage - aLastMessage;
    });

    res.status(200).json(sortedUsers);
  } catch (error) {
    console.error("Error in getUsersForSidebar: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        { senderId: myId, receiverId: userToChatId },
        { senderId: userToChatId, receiverId: myId },
      ],
    }).sort({ createdAt: 1 });
    res.status(200).json(messages);
  } catch (error) {
    console.error("Error in getMessages controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { text, image, clientMessageId } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    if (typeof clientMessageId !== "string" || !clientMessageId.trim()) {
      return res.status(400).json({
        message: "clientMessageId is required",
      });
    }

    const hasText = typeof text === "string" && text.trim().length > 0;
    const hasImage = typeof image === "string" && image.length > 0;

    if (!hasText && !hasImage) {
      return res.status(400).json({
        message: "A message must contain text or an image",
      });
    }

    const existingMessage = await Message.findOne({
      clientMessageId,
      senderId,
    });

    if (existingMessage) {
      return res.status(200).json(existingMessage);
    }

    let imageUrl;
    if (image) {
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    const newMessage = new Message({
      clientMessageId,
      senderId,
      receiverId,
      text,
      image: imageUrl,
    });

    try {
      await newMessage.save();
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }

      const existingMessage = await Message.findOne({
        senderId,
        clientMessageId,
      });

      if (!existingMessage) {
        throw error;
      }

      return res.status(200).json(existingMessage);
    }

    io.to(getUserRoom(receiverId)).emit("newMessage", newMessage);

    res.status(201).json(newMessage);
  } catch (error) {
    console.log("Error in sendMessage controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};
