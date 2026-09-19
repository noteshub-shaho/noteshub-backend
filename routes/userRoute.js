import express from "express";
import {
  registerUser,
  verification,
  loginUser,
  logoutUser,
  forgotPassword,
  verifyOTP,
  changePassword,
  sendContactMail,
} from "../controllers/userController.js";

import { isAuthenticated } from "../middleware/isAuthenticated.js";
import {
  registerSchema,
  loginSchema,
  resetPasswordSchema,
  validate,
} from "../validators/userValidate.js";

const router = express.Router();

router.post("/register", validate(registerSchema), registerUser);
router.get("/verify/:token", verification);
router.post("/login", validate(loginSchema), loginUser);
router.post("/logout", isAuthenticated, logoutUser);
router.post("/forgot-password", forgotPassword);
router.post("/verify-otp/:email", verifyOTP);
router.post("/change-password/:email", validate(resetPasswordSchema), changePassword);

router.post("/contact", sendContactMail);

export default router;