import multer from "multer";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import { publicUser } from "./sessionController.js";
import {
  AvatarValidationError,
  MAX_AVATAR_BYTES,
  deleteAvatarAsset,
  uploadAvatar,
} from "../services/profilePhotoService.js";

const ALLOWED_UPLOAD_MIME = ["image/jpeg", "image/png", "image/webp"];

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_UPLOAD_MIME.includes(mime)) {
      cb(new AvatarValidationError("Unsupported image type. Use JPEG, PNG or WebP."));
      return;
    }
    cb(null, true);
  },
});

export const uploadAvatarMiddleware = (req, res, next) => {
  avatarUpload.single("photo")(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, message: "Image is too large. Maximum size is 5 MB." });
    }
    if (error instanceof AvatarValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(400).json({ success: false, message: "Image upload failed" });
  });
};

export const setProfilePhoto = async (req, res) => {
  try {
    const userId = req.userId;

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ success: false, message: "Select an image to upload" });
    }

    const uploaded = await uploadAvatar(userId, req.file.buffer, req.file.mimetype);

    let user;
    try {
      user = await prisma.user.update({
        where: { id: userId },
        data: { profilePhotoUrl: uploaded.url, profilePhotoPublicId: uploaded.publicId },
      });
    } catch (dbError) {
      await deleteAvatarAsset(userId, uploaded.publicId);
      throw dbError;
    }

    const previousPublicId = req.user.profilePhotoPublicId;
    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await deleteAvatarAsset(userId, previousPublicId);
    }

    return res.status(200).json({ success: true, user: publicUser(user) });
  } catch (error) {
    if (error instanceof AvatarValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Could not upload the profile photo. Try again." });
  }
};

export const removeProfilePhoto = async (req, res) => {
  try {
    const userId = req.userId;
    const current = req.user;
    if (!current.profilePhotoUrl) {
      return res.status(404).json({ success: false, message: "No profile photo to remove" });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { profilePhotoUrl: null, profilePhotoPublicId: null },
    });

    if (current.profilePhotoPublicId) {
      await deleteAvatarAsset(userId, current.profilePhotoPublicId);
    }

    return res.status(200).json({ success: true, user: publicUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Could not remove the profile photo. Try again." });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    const user = req.user;

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message:
          user.authProvider === "google"
            ? "You signed up using Google. Your account does not have a separate NotesHub password to change. Please manage your password through your Google Account."
            : "This account does not have a password set. Use the forgot password flow to set one.",
      });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ success: false, message: "New password must be different from the current password" });
    }

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
      user: publicUser(updated),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Could not change the password. Try again." });
  }
};

export const listPurchases = async (req, res) => {
  try {
    const userId = req.userId;
    const [orders, entitlements] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { config: { select: { title: true, price: true } } },
      }),
      prisma.noteEntitlement.findMany({ where: { userId }, select: { noteKey: true } }),
    ]);

    const owned = new Set(entitlements.map((entry) => entry.noteKey));
    const purchases = orders.map((order) => ({
      id: order.id,
      noteKey: order.noteKey,
      title: order.config?.title ?? order.noteKey,
      amountPaise: order.amount,
      currency: order.currency,
      status: order.status,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
      createdAt: order.createdAt,
      hasAccess: owned.has(order.noteKey),
    }));

    return res.status(200).json({ success: true, purchases });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Could not load purchase history" });
  }
};
