import express from "express"
import { checkAuth, updateProfile, login, logout, signup } from "../controllers/auth.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";
import { authLimiter, uploadLimiter } from "../lib/rateLimit.js";

const router = express.Router();

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/logout", logout);
router.put("/update-profile", protectRoute, uploadLimiter, updateProfile);

router.get("/check", protectRoute, checkAuth)


export default router;
