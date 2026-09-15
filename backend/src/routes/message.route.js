import express from "express"
import { protectRoute } from "../middleware/auth.middleware.js";
import { getUsersForSideBar, getMessages, sendMessage } from "../controllers/message.controller.js";
import { sendLimiter, uploadLimiter } from "../lib/rateLimit.js";

const router = express.Router();

router.get("/users", protectRoute, getUsersForSideBar);
router.post("/send/:id", protectRoute, sendLimiter, uploadLimiter, sendMessage);
router.get("/:id", protectRoute, getMessages);

export default router;
