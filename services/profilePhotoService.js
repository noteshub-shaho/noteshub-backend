import crypto from "crypto";
import cloudinary from "../config/cloudinary.js";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export const ALLOWED_AVATAR_MIME = ["image/jpeg", "image/png", "image/webp"];

const MAGIC_PREFIXES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

export class AvatarValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AvatarValidationError";
  }
}

export function avatarFolder(userId) {
  return `noteshub/avatars/${String(userId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
}

export function ownsAvatarAsset(userId, publicId) {
  if (typeof publicId !== "string" || publicId.length === 0) return false;
  return publicId.startsWith(`${avatarFolder(userId)}/`);
}

export function validateAvatarBuffer(buffer, mimetype) {
  if (!buffer || buffer.length === 0) {
    throw new AvatarValidationError("No image received");
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new AvatarValidationError("Image is too large. Maximum size is 5 MB.");
  }
  const mime = String(mimetype || "").toLowerCase();
  if (!ALLOWED_AVATAR_MIME.includes(mime)) {
    throw new AvatarValidationError("Unsupported image type. Use JPEG, PNG or WebP.");
  }
  const prefix = MAGIC_PREFIXES[mime];
  if (!prefix.every((byte, index) => buffer[index] === byte)) {
    throw new AvatarValidationError("The selected file is not a valid image.");
  }
  return mime;
}

function buildPublicId() {
  return `avatar_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
}

export function uploadAvatar(userId, buffer, mimetype) {
  const mime = validateAvatarBuffer(buffer, mimetype);
  const folder = avatarFolder(userId);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: buildPublicId(),
        resource_type: "image",
        overwrite: false,
        unique_filename: false,
        transformation: [
          { width: 512, height: 512, crop: "fill", gravity: "auto" },
          { quality: "auto", fetch_format: "auto" },
        ],
      },
      (error, result) => {
        if (error || !result) {
          reject(new Error("image_upload_failed"));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id, mimetype: mime });
      }
    );
    stream.end(buffer);
  });
}

export async function deleteAvatarAsset(userId, publicId) {
  if (!ownsAvatarAsset(userId, publicId)) return false;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
    return true;
  } catch {
    return false;
  }
}
