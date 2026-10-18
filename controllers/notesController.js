import cloudinary from "../config/cloudinary.js";
import { createClient } from "@supabase/supabase-js";
import { getSemesters } from "../config/academic.js";
import manifestService, { ValidationError } from "../services/notesManifestService.js";

const notesCache = new Map();
const NOTES_CACHE_TTL_MS = 5 * 60 * 1000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const getNotes = async (req, res) => {
  try {
    const { university, semester, subject, subSubject } = req.params;

    if (!university || !semester || !subject) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters"
      });
    }

    const folderPath = subSubject
      ? `noteshub/${university}/${semester}/${subject}/${subSubject}`
      : `noteshub/${university}/${semester}/${subject}`;

    const supabasePath = subSubject
      ? `${university}/${semester}/${subject}/${subSubject}`
      : `${university}/${semester}/${subject}`;

const cachedNotes = notesCache.get(folderPath);
if (cachedNotes && Date.now() - cachedNotes.at < NOTES_CACHE_TTL_MS) {
  console.log(`[Cloudinary] getNotes cache HIT for ${folderPath} — 0 API calls`);
  return res.status(200).json({
    success: true,
    count: cachedNotes.notes.length,
    notes: cachedNotes.notes
  });
}

let cloudinaryNotes = [];
try {
  console.log(`[Cloudinary] API hit #1 — getNotes — folder: ${folderPath}`);
  const cloudinaryResult = await cloudinary.api.resources_by_asset_folder(folderPath, {
    max_results: 100
  });
  console.log(`[Cloudinary] getNotes returned ${cloudinaryResult.resources.length} file(s) from: ${folderPath}`);
  cloudinaryNotes = (cloudinaryResult.resources || []).map(file => ({
    name: file.display_name || file.public_id.split("/").pop(),
    url: file.secure_url,
    provider: "cloudinary"
  }));
} catch (e) {
  console.error("Cloudinary error:", JSON.stringify(e));
}

    const { data: supabaseFiles, error } = await supabase.storage
      .from("notes")
      .list(supabasePath, { limit: 100 });

    const supabaseNotes = [];
    if (!error && supabaseFiles && supabaseFiles.length > 0) {
      supabaseFiles
        .filter(f => f.name.endsWith(".pdf"))
        .forEach(file => {
          const { data } = supabase.storage
            .from("notes")
            .getPublicUrl(`${supabasePath}/${file.name}`);
          supabaseNotes.push({
            name: file.name,
            url: data.publicUrl,
            provider: "supabase"
          });
        });
    }

    const allNotes = [...cloudinaryNotes, ...supabaseNotes];

    if (allNotes.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Notes not found"
      });
    }

    notesCache.set(folderPath, { notes: allNotes, at: Date.now() });
    console.log(`[Cloudinary] getNotes cache SET for ${folderPath} — valid for 5 minutes`);

    res.status(200).json({
      success: true,
      count: allNotes.length,
      notes: allNotes
    });

  } catch (error) {
    console.log("Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error"
    });
  }
};

/**
 * GET /api/notes/manifest?semester=X&university=Y
 *
 * Lightweight sync manifest for the offline PDF cache: one storage listing
 * per subject folder, per-note SHA-256 content hashes (computed once per
 * asset version and cached in NoteAsset — never re-downloaded per request).
 * Paid-note folders are excluded; their files remain entitlement-gated.
 */
export const getNotesManifest = async (req, res) => {
  try {
    const university = String(req.query.university || "").trim().toLowerCase();
    const semester = String(req.query.semester || "").trim().toLowerCase();

    if (!university || !semester) {
      return res.status(400).json({
        success: false,
        message: "university and semester query parameters are required",
      });
    }

    const semesters = getSemesters(university);
    if (!semesters) {
      return res.status(404).json({ success: false, message: "University not found" });
    }
    if (!semesters.some((s) => s.key === semester)) {
      return res.status(404).json({ success: false, message: "Semester not found" });
    }

    const notes = await manifestService.buildManifest({ university, semester });

    return res.status(200).json({
      success: true,
      university,
      semester,
      count: notes.length,
      notes,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.log("Manifest error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
};