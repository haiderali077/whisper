import express from "express"
import { protectRoute } from "../middleware/auth.middleware.js";
import { getUsersForSideBar, getMessages, sendMessage } from "../controllers/message.controller.js";

const router = express.Router();

router.get("/users", protectRoute, getUsersForSideBar);
router.post("/send/:id", protectRoute, sendMessage);
router.get("/:id", protectRoute, getMessages);

export default router;