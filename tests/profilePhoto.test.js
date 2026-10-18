import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_AVATAR_MIME,
  AvatarValidationError,
  MAX_AVATAR_BYTES,
  avatarFolder,
  ownsAvatarAsset,
  validateAvatarBuffer,
} from "../services/profilePhotoService.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);

test("accepts jpeg, png and webp buffers", () => {
  assert.equal(validateAvatarBuffer(JPEG, "image/jpeg"), "image/jpeg");
  assert.equal(validateAvatarBuffer(PNG, "image/png"), "image/png");
  assert.equal(validateAvatarBuffer(WEBP, "image/webp"), "image/webp");
  assert.equal(ALLOWED_AVATAR_MIME.includes("image/gif"), false);
});

test("rejects oversized buffers", () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_AVATAR_BYTES)]);
  assert.throws(() => validateAvatarBuffer(big, "image/jpeg"), AvatarValidationError);
});

test("rejects unsupported or mismatched content", () => {
  assert.throws(() => validateAvatarBuffer(JPEG, "image/gif"), AvatarValidationError);
  assert.throws(() => validateAvatarBuffer(PNG, "image/jpeg"), AvatarValidationError);
  assert.throws(() => validateAvatarBuffer(Buffer.alloc(0), "image/jpeg"), AvatarValidationError);
});

test("avatar folder is derived from the authenticated user id", () => {
  assert.equal(avatarFolder("abc123"), "noteshub/avatars/abc123");
  assert.equal(avatarFolder("../other-user"), "noteshub/avatars/other-user");
});

test("ownership requires the requesting user's own folder", () => {
  const own = `${avatarFolder("user-1")}/avatar_x`;
  assert.equal(ownsAvatarAsset("user-1", own), true);
  assert.equal(ownsAvatarAsset("user-2", own), false);
  assert.equal(ownsAvatarAsset("user-1", "noteshub/notes/avatar_x"), false);
  assert.equal(ownsAvatarAsset("user-1", ""), false);
  assert.equal(ownsAvatarAsset("user-1", null), false);
});
