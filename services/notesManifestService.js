// Notes manifest + content-hash service.
//
// Notes PDFs live in provider storage (Cloudinary asset folders under
// `noteshub/<university>/<semester>/<subject>[/subSubject]` and the Supabase
// `notes` bucket at the same relative path) — there is no database row per
// note. This service answers "what PDFs exist for a semester and how do I
// know when one changed?" by pairing a lightweight storage listing with a
// verified SHA-256 content hash persisted in the NoteAsset table.
//
// Hash lifecycle:
//   * adminUpload persists a hash at upload time (see controllers/adminController.js).
//   * buildManifest lazily backfills any asset whose provider version token is
//     new or whose hash is still missing — the asset is downloaded exactly
//     once per version, hashed with SHA-256, and the result is cached in
//     Postgres forever. Subsequent manifest requests do zero PDF downloads.
//   * If hashing fails (e.g. transient network error) the note is still
//     listed with hash = null ("unverified"); clients must never treat a
//     null/mismatched hash as a match.
//
// Paid notes (folders with an enabled PaidNoteConfig) are intentionally
// excluded: they are served through the entitlement-gated stream endpoint and
// must never enter the free offline cache.

import crypto from "crypto";
import { getSubjects } from "../config/academic.js";
import prisma from "../lib/prisma.js";
import cloudinary from "../config/cloudinary.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_RESULTS = 100;
const HASH_CONCURRENCY = 4;
const HASH_DOWNLOAD_TIMEOUT_MS = 30_000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

/** All `university/semester/subject[/subSubject]` folders for a semester. */
export function semesterFolders(university, semester) {
  const subjects = getSubjects(university, semester);
  if (!subjects) return null;
  const folders = [];
  for (const entry of subjects) {
    // Parents with children keep their files in the child folders only.
    if (entry.children.length === 0) {
      folders.push(`${university}/${semester}/${entry.slug}`);
    }
    for (const child of entry.children) {
      folders.push(`${university}/${semester}/${entry.slug}/${child.slug}`);
    }
  }
  return folders;
}

/** Stream a URL and compute its SHA-256 without buffering the whole file. */
export async function sha256OfUrl(url, { fetchImpl = fetch, timeoutMs = HASH_DOWNLOAD_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(`hash download failed with status ${res.status}`);
    }
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    return { hash: `sha256:${hash.digest("hex")}`, bytes };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const manifestCache = new Map();
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;

export function createNotesManifestService({
  cloudinaryApi = cloudinary.api,
  storage = supabase,
  db = prisma,
  fetchImpl,
  hashConcurrency = HASH_CONCURRENCY,
} = {}) {
  async function listFolderEntries(folder, ctx = { hit: 0 }) {
    const entries = [];

    try {
      ctx.hit += 1;
      console.log(`[Cloudinary] API hit #${ctx.hit} — manifest listing — folder: noteshub/${folder}`);
      const result = await cloudinaryApi.resources_by_asset_folder(`noteshub/${folder}`, {
        max_results: MAX_RESULTS,
      });
      console.log(`[Cloudinary] hit #${ctx.hit} returned ${(result.resources || []).length} file(s)`);
      for (const r of result.resources || []) {
        entries.push({
          provider: "cloudinary",
          publicId: r.public_id,
          filename: r.display_name || r.public_id.split("/").pop(),
          folder,
          bytes: r.bytes ?? null,
          version: r.version != null ? `v${r.version}` : null,
          url: r.secure_url,
        });
      }
    } catch {
      // Folder missing / provider hiccup — same tolerance as getNotes.
    }

    try {
      const { data: files, error } = await storage.from("notes").list(folder, { limit: MAX_RESULTS });
      if (!error && files) {
        for (const f of files.filter((x) => x.name && x.name.toLowerCase().endsWith(".pdf"))) {
          const objectPath = `${folder}/${f.name}`;
          const { data: urlData } = storage.from("notes").getPublicUrl(objectPath);
          entries.push({
            provider: "supabase",
            publicId: objectPath,
            filename: f.name,
            folder,
            bytes: f.metadata?.size ?? null,
            version: f.updated_at ? `${f.updated_at}|${f.metadata?.size ?? 0}` : null,
            url: urlData?.publicUrl ?? null,
          });
        }
      }
    } catch {
      // Same tolerance as getNotes.
    }

    return entries;
  }

  /**
   * Attach a verified content hash to every entry, reusing cached NoteAsset
   * rows whenever (provider, publicId, version) already has one. Downloads and
   * hashes only new/changed assets, at most `hashConcurrency` at a time.
   */
  async function ensureHashes(entries) {
    const lookups = await mapWithConcurrency(entries, 10, (entry) =>
      db.noteAsset.findUnique({
        where: { provider_publicId: { provider: entry.provider, publicId: entry.publicId } },
      })
    );

    const byKey = new Map(entries.map((e, i) => [`${e.provider}:${e.publicId}`, lookups[i]]));

    // Assets that need a (re)computed hash: new row, new version, or missing hash.
    const needsHash = entries.filter((entry, i) => {
      const row = lookups[i];
      return !row || !row.hash || (entry.version != null && row.version !== entry.version);
    });

    await mapWithConcurrency(needsHash, hashConcurrency, async (entry) => {
      const row = byKey.get(`${entry.provider}:${entry.publicId}`);
      try {
        if (!entry.url) throw new Error("no delivery URL");
        const { hash, bytes } = await sha256OfUrl(entry.url, { fetchImpl });
        const data = {
          filename: entry.filename,
          folder: entry.folder,
          bytes: bytes || entry.bytes,
          version: entry.version,
          hash,
          url: entry.url,
        };
        const saved = await db.noteAsset.upsert({
          where: { provider_publicId: { provider: entry.provider, publicId: entry.publicId } },
          create: { provider: entry.provider, publicId: entry.publicId, ...data },
          update: data,
        });
        byKey.set(`${entry.provider}:${entry.publicId}`, saved);
      } catch {
        // Hashing failed — keep any previous row untouched and serve hash=null
        // (explicit "unverified" marker) so the note stays listed/available.
        if (!row) {
          try {
            const saved = await db.noteAsset.create({
              data: {
                provider: entry.provider,
                publicId: entry.publicId,
                filename: entry.filename,
                folder: entry.folder,
                bytes: entry.bytes,
                version: entry.version,
                url: entry.url,
              },
            });
            byKey.set(`${entry.provider}:${entry.publicId}`, saved);
          } catch {
            /* row creation is best-effort */
          }
        }
      }
    });

    return entries.map((entry) => ({ entry, row: byKey.get(`${entry.provider}:${entry.publicId}`) || null }));
  }

  async function buildManifest({ university, semester }) {
    const cacheKey = `${university}:${semester}`;
    const cached = manifestCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MANIFEST_CACHE_TTL_MS) {
      console.log(`[Cloudinary] manifest cache HIT for ${university}/${semester} — 0 API calls`);
      return cached.notes;
    }

    const folders = semesterFolders(university, semester);
    if (!folders) throw new ValidationError("Unknown university or semester");

    // Paid folders are served through the entitlement-gated endpoints only.
    let paidKeys = new Set();
    try {
      const paidConfigs = await db.paidNoteConfig.findMany({
        where: { isEnabled: true },
        select: { noteKey: true },
      });
      paidKeys = new Set(paidConfigs.map((c) => c.noteKey));
    } catch {
      /* if the lookup fails, fall through and list everything (free notes are public anyway) */
    }
    const activeFolders = folders.filter((f) => !paidKeys.has(f));

    const ctx = { hit: 0 };
    console.log(`[Cloudinary] manifest will query ${activeFolders.length} folder(s) for ${university}/${semester}`);
    const listings = await Promise.all(activeFolders.map((f) => listFolderEntries(f, ctx)));
    console.log(`[Cloudinary] manifest complete — total Cloudinary API hits this request: ${ctx.hit}`);

    // Dedupe by (provider, publicId) in case a file shows up in two folders.
    const seen = new Set();
    const entries = [];
    for (const list of listings) {
      for (const entry of list) {
        const key = `${entry.provider}:${entry.publicId}`;
        if (seen.has(key) || !entry.url) continue;
        seen.add(key);
        entries.push(entry);
      }
    }

    const hashed = await ensureHashes(entries);

    const notes = hashed
      .map(({ entry, row }) => ({
        id: row ? row.id : `${entry.provider}:${entry.publicId}`,
        filename: entry.filename,
        hash: row?.hash ?? null,
        cloudinary_url: entry.url,
        provider: entry.provider,
        notes_path: entry.folder,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename) || a.notes_path.localeCompare(b.notes_path));

    manifestCache.set(cacheKey, { notes, at: Date.now() });
    console.log(`[Cloudinary] manifest cache SET for ${university}/${semester} — valid for 5 minutes`);
    return notes;
  }

  return { buildManifest, listFolderEntries, ensureHashes };
}

export default createNotesManifestService();
