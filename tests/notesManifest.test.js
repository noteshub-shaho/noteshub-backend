// Unit tests for the notes manifest + content-hash service.
// Run with: npm test  (node --test tests/)
//
// All providers (Cloudinary, Supabase, Prisma, fetch) are mocked through the
// service's dependency injection — no network access, no production database.

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  createNotesManifestService,
  semesterFolders,
  sha256OfUrl,
  ValidationError,
} from "../services/notesManifestService.js";

const PDF_CONTENT = (label) => Buffer.from(`%PDF-1.4\n1 0 obj << /Label (${label}) >>\n%%EOF\n`);
const sha = (buf) => `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;

function makeFakeCloudinary(initial = {}) {
  const resourcesByFolder = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    set(folder, resources) {
      resourcesByFolder.set(folder, resources);
    },
    api: {
      async resources_by_asset_folder(folder) {
        calls.push(folder.replace(/^noteshub\//, ""));
        const resources = resourcesByFolder.get(folder.replace(/^noteshub\//, "")) ?? [];
        if (resources.length === 0) throw new Error("not found");
        return { resources };
      },
    },
  };
}

function makeFakeStorage(initial = {}) {
  const filesByFolder = new Map(Object.entries(initial));
  return {
    from() {
      return {
        async list(folder) {
          return { data: filesByFolder.get(folder) ?? [], error: null };
        },
        getPublicUrl(path) {
          return { data: { publicUrl: `https://storage.example/${path}` } };
        },
      };
    },
  };
}

function makeFakeDb({ paidNoteKeys = [], rows = [] } = {}) {
  const store = new Map(rows.map((r) => [`${r.provider}:${r.publicId}`, r]));
  let nextId = store.size + 1;
  return {
    store,
    noteAsset: {
      async findUnique({ where }) {
        const { provider, publicId } = where.provider_publicId;
        return store.get(`${provider}:${publicId}`) ?? null;
      },
      async upsert({ where, create, update }) {
        const { provider, publicId } = where.provider_publicId;
        const key = `${provider}:${publicId}`;
        const existing = store.get(key);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { id: `asset_${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        store.set(key, row);
        return row;
      },
      async create({ data }) {
        const key = `${data.provider}:${data.publicId}`;
        const row = { id: `asset_${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        store.set(key, row);
        return row;
      },
    },
    paidNoteConfig: {
      async findMany() {
        return paidNoteKeys.map((noteKey) => ({ noteKey, isEnabled: true }));
      },
    },
  };
}

function makeFakeFetch(contents) {
  const counts = new Map();
  const impl = async (url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const content = contents.get(url);
    if (!content) return { ok: false, status: 404, body: null };
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield content.subarray(0, 4);
        yield content.subarray(4);
      })(),
    };
  };
  impl.counts = counts;
  return impl;
}

const cloudinaryResource = (publicId, { version = 1, bytes = 100 } = {}) => ({
  public_id: publicId,
  display_name: `${publicId.split("/").pop()}.pdf`,
  secure_url: `https://res.cloudinary.com/test/${publicId}.pdf`,
  version,
  bytes,
});

test("semesterFolders expands nested subjects and rejects unknown input", () => {
  const folders = semesterFolders("mu", "sem4");
  assert.ok(folders.includes("mu/sem4/dbms"));
  assert.ok(folders.includes("mu/sem4/lab-experiments/dbms-lab"));
  assert.equal(semesterFolders("nope", "sem4"), null);
  assert.equal(semesterFolders("mu", "sem99"), null);
});

test("sha256OfUrl streams content and returns content hash + byte count", async () => {
  const buf = PDF_CONTENT("stream");
  const fetchImpl = makeFakeFetch(new Map([["https://x/a.pdf", buf]]));
  const result = await sha256OfUrl("https://x/a.pdf", { fetchImpl });
  assert.equal(result.hash, sha(buf));
  assert.equal(result.bytes, buf.length);
});

test("manifest returns lightweight metadata with verified content hashes", async () => {
  const content = PDF_CONTENT("unit-1");
  const cloudinary = makeFakeCloudinary({ "mu/sem3/aoa": [cloudinaryResource("noteshub/mu/sem3/aoa/unit-1")] });
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(new Map([["https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/unit-1.pdf", content]]));
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const notes = await service.buildManifest({ university: "mu", semester: "sem3" });

  assert.equal(notes.length, 1);
  const note = notes[0];
  assert.deepEqual(Object.keys(note).sort(), ["cloudinary_url", "filename", "hash", "id", "notes_path", "provider"]);
  assert.equal(note.filename, "unit-1.pdf");
  assert.equal(note.hash, sha(content));
  assert.equal(note.notes_path, "mu/sem3/aoa");
  assert.ok(note.id.startsWith("asset_"));
  assert.equal(fetchImpl.counts.size, 1);
});

test("repeated manifests with unchanged versions perform zero downloads", async () => {
  const content = PDF_CONTENT("stable");
  const url = "https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/stable.pdf";
  const cloudinary = makeFakeCloudinary({ "mu/sem3/aoa": [cloudinaryResource("noteshub/mu/sem3/aoa/stable")] });
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(new Map([[url, content]]));
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const first = await service.buildManifest({ university: "mu", semester: "sem3" });
  const second = await service.buildManifest({ university: "mu", semester: "sem3" });

  assert.equal(fetchImpl.counts.get(url), 1, "asset downloaded exactly once");
  assert.deepEqual(first, second);
});

test("46 cached notes + 3 new notes → only the 3 new ones are downloaded", async () => {
  const contents = new Map();
  const resources = [];
  for (let i = 1; i <= 46; i++) {
    const publicId = `noteshub/mu/sem3/aoa/unit-${i}`;
    resources.push(cloudinaryResource(publicId, { version: 1 }));
    contents.set(`${publicId}.pdf`, PDF_CONTENT(`unit-${i}`));
  }
  const cloudinary = makeFakeCloudinary({ "mu/sem3/aoa": resources });
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(contents);
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const first = await service.buildManifest({ university: "mu", semester: "sem3" });
  assert.equal(first.length, 46);
  assert.equal(fetchImpl.counts.size, 46);

  for (let i = 47; i <= 49; i++) {
    const publicId = `noteshub/mu/sem3/aoa/unit-${i}`;
    resources.push(cloudinaryResource(publicId, { version: 1 }));
    contents.set(`${publicId}.pdf`, PDF_CONTENT(`unit-${i}`));
  }
  const second = await service.buildManifest({ university: "mu", semester: "sem3" });

  assert.equal(second.length, 49);
  assert.equal(fetchImpl.counts.size, 49, "exactly 3 additional downloads for the 3 new notes");
  const oldOnes = second.filter((n) => n.filename.startsWith("unit-") && Number(n.filename.match(/\d+/)[0]) <= 46);
  assert.deepEqual(
    oldOnes.map((n) => n.hash),
    first.map((n) => n.hash),
    "existing hashes are stable across syncs"
  );
});

test("updating one asset re-downloads only that asset and changes only its hash", async () => {
  const oldContent = PDF_CONTENT("old");
  const newContent = PDF_CONTENT("new");
  const url1 = "https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/a.pdf";
  const url2 = "https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/b.pdf";
  const cloudinary = makeFakeCloudinary({
    "mu/sem3/aoa": [
      cloudinaryResource("noteshub/mu/sem3/aoa/a", { version: 1 }),
      cloudinaryResource("noteshub/mu/sem3/aoa/b", { version: 1 }),
    ],
  });
  const contents = new Map([
    [url1, oldContent],
    [url2, PDF_CONTENT("b")],
  ]);
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(contents);
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const first = await service.buildManifest({ university: "mu", semester: "sem3" });

  // Replace note A with a new version (new content, new URL).
  contents.set(url1, newContent);
  cloudinary.set("mu/sem3/aoa", [
    cloudinaryResource("noteshub/mu/sem3/aoa/a", { version: 2 }),
    cloudinaryResource("noteshub/mu/sem3/aoa/b", { version: 1 }),
  ]);

  const second = await service.buildManifest({ university: "mu", semester: "sem3" });

  assert.equal(fetchImpl.counts.get(url1), 2, "changed asset downloaded once more");
  assert.equal(fetchImpl.counts.get(url2), 1, "unchanged asset never re-downloaded");
  const a2 = second.find((n) => n.filename === "a.pdf");
  const b2 = second.find((n) => n.filename === "b.pdf");
  assert.equal(a2.id, first.find((n) => n.filename === "a.pdf").id, "stable id across versions");
  assert.equal(a2.hash, sha(newContent));
  assert.equal(b2.hash, first.find((n) => n.filename === "b.pdf").hash);
});

test("paid folders are excluded from the manifest", async () => {
  const cloudinary = makeFakeCloudinary({
    "mu/sem3/aoa": [cloudinaryResource("noteshub/mu/sem3/aoa/unit-1")],
    "mu/sem3/important-answers": [cloudinaryResource("noteshub/mu/sem3/important-answers/answers-1")],
  });
  const db = makeFakeDb({ paidNoteKeys: ["mu/sem3/important-answers"] });
  const fetchImpl = makeFakeFetch(
    new Map([["https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/unit-1.pdf", PDF_CONTENT("x")]])
  );
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const notes = await service.buildManifest({ university: "mu", semester: "sem3" });

  assert.equal(notes.length, 1);
  assert.equal(notes[0].notes_path, "mu/sem3/aoa");
  assert.ok(!cloudinary.calls.includes("mu/sem3/important-answers"), "paid folder never listed");
});

test("a failed hash download yields hash=null but keeps the note listed, and retries next sync", async () => {
  const okContent = PDF_CONTENT("ok");
  const badUrl = "https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/bad.pdf";
  const goodUrl = "https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/good.pdf";
  const cloudinary = makeFakeCloudinary({
    "mu/sem3/aoa": [
      cloudinaryResource("noteshub/mu/sem3/aoa/bad"),
      cloudinaryResource("noteshub/mu/sem3/aoa/good"),
    ],
  });
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(new Map([[goodUrl, okContent]])); // badUrl missing → 404
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl });

  const first = await service.buildManifest({ university: "mu", semester: "sem3" });
  assert.equal(first.length, 2);
  const bad = first.find((n) => n.filename === "bad.pdf");
  assert.equal(bad.hash, null, "unverifiable asset is explicitly hash=null, never a fake hash");
  assert.equal(first.find((n) => n.filename === "good.pdf").hash, sha(okContent));

  // Provider recovers → next manifest computes the missing hash.
  fetchImpl.counts.clear();
  const contents = new Map([
    [badUrl, PDF_CONTENT("bad")],
    [goodUrl, okContent],
  ]);
  const recoveringFetch = makeFakeFetch(contents);
  const service2 = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage: makeFakeStorage(), db, fetchImpl: recoveringFetch });
  const second = await service2.buildManifest({ university: "mu", semester: "sem3" });
  assert.equal(second.find((n) => n.filename === "bad.pdf").hash, sha(PDF_CONTENT("bad")));
  assert.equal(recoveringFetch.counts.get(goodUrl), undefined, "already-verified asset not re-downloaded");
});

test("supabase assets are listed, hashed, and deduped against cloudinary duplicates", async () => {
  const supaContent = PDF_CONTENT("supa");
  const cloudinary = makeFakeCloudinary({ "mu/sem3/aoa": [cloudinaryResource("noteshub/mu/sem3/aoa/dup")] });
  const storage = makeFakeStorage({
    mu: [],
    "mu/sem3/aoa": [{ name: "supa.pdf", updated_at: "2026-01-01T00:00:00Z", metadata: { size: 42 } }],
  });
  const db = makeFakeDb();
  const fetchImpl = makeFakeFetch(
    new Map([
      ["https://res.cloudinary.com/test/noteshub/mu/sem3/aoa/dup.pdf", PDF_CONTENT("dup")],
      ["https://storage.example/mu/sem3/aoa/supa.pdf", supaContent],
    ])
  );
  const service = createNotesManifestService({ cloudinaryApi: cloudinary.api, storage, db, fetchImpl });

  const notes = await service.buildManifest({ university: "mu", semester: "sem3" });
  const supa = notes.find((n) => n.provider === "supabase");
  assert.ok(supa);
  assert.equal(supa.filename, "supa.pdf");
  assert.equal(supa.hash, sha(supaContent));
  assert.equal(supa.cloudinary_url, "https://storage.example/mu/sem3/aoa/supa.pdf");
  assert.equal(notes.length, 2);
});

test("unknown university or semester raises ValidationError", async () => {
  const service = createNotesManifestService({
    cloudinaryApi: makeFakeCloudinary().api,
    storage: makeFakeStorage(),
    db: makeFakeDb(),
    fetchImpl: makeFakeFetch(new Map()),
  });
  await assert.rejects(() => service.buildManifest({ university: "nope", semester: "sem3" }), ValidationError);
  await assert.rejects(() => service.buildManifest({ university: "mu", semester: "sem99" }), ValidationError);
});
