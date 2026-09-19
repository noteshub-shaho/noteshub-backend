import express from "express";
import multer from "multer";
import { isAdmin } from "../middleware/isAdmin.js";
import {
  adminUpload,
  adminListFolders,
  adminListCloudinaryFiles,
  adminDeleteCloudinaryFile,
  adminListSupabaseFiles,
  adminDeleteSupabaseFile,
  adminCreateCloudinaryFolder,
  adminRenameCloudinaryFolder,
  adminDeleteCloudinaryFolder,
  adminCreateSupabaseFolder,
  adminRenameSupabaseFolder,
  adminDeleteSupabaseFolder,
} from "../controllers/adminController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post("/upload", isAdmin, upload.single("file"), adminUpload);
router.get("/folders", isAdmin, adminListFolders);
router.get("/cloudinary/files", isAdmin, adminListCloudinaryFiles);
router.delete("/cloudinary/file", isAdmin, adminDeleteCloudinaryFile);
router.get("/supabase/files", isAdmin, adminListSupabaseFiles);
router.delete("/supabase/file", isAdmin, adminDeleteSupabaseFile);

router.post("/cloudinary/folder", isAdmin, adminCreateCloudinaryFolder);
router.put("/cloudinary/folder", isAdmin, adminRenameCloudinaryFolder);
router.delete("/cloudinary/folder", isAdmin, adminDeleteCloudinaryFolder);

router.post("/supabase/folder", isAdmin, adminCreateSupabaseFolder);
router.put("/supabase/folder", isAdmin, adminRenameSupabaseFolder);
router.delete("/supabase/folder", isAdmin, adminDeleteSupabaseFolder);

export default router;