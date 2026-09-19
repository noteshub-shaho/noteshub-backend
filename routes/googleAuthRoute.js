import express from "express";
import { getGoogleAuthUrl, googleCallback } from "../controllers/googleAuthController.js";

const router = express.Router();

router.get("/url", getGoogleAuthUrl);
router.post("/callback", googleCallback);

export default router;