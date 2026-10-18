// Safe backfill: walk every university/semester folder pair from the academic
// taxonomy and build the sync manifest. Building a manifest computes and
// persists the SHA-256 content hash for every asset that does not have one
// yet (or whose provider version changed), downloading each PDF at most once.
// Existing notes without hashes are unaffected — they are simply listed with
// hash = null until hashed.
//
// Usage:  npm run notes:backfill-hashes
//         node scripts/backfillNoteHashes.js [university] [semester]

import "dotenv/config";
import { UNIVERSITIES, getSemesters } from "../config/academic.js";
import { createNotesManifestService } from "../services/notesManifestService.js";

const service = createNotesManifestService();

const onlyUniversity = process.argv[2];
const onlySemester = process.argv[3];

let totalNotes = 0;
let hashedNotes = 0;
let unverifiedNotes = 0;

for (const university of UNIVERSITIES) {
  if (onlyUniversity && university.id !== onlyUniversity) continue;
  for (const semester of getSemesters(university.id) ?? []) {
    if (onlySemester && semester.key !== onlySemester) continue;
    const started = Date.now();
    try {
      const notes = await service.buildManifest({ university: university.id, semester: semester.key });
      const verified = notes.filter((n) => typeof n.hash === "string" && n.hash.startsWith("sha256:")).length;
      totalNotes += notes.length;
      hashedNotes += verified;
      unverifiedNotes += notes.length - verified;
      console.log(
        `${university.id}/${semester.key}: ${notes.length} notes (${verified} verified, ${notes.length - verified} unverified) in ${Date.now() - started}ms`
      );
    } catch (error) {
      console.error(`${university.id}/${semester.key}: FAILED — ${error.message}`);
    }
  }
}

console.log(`\nDone. ${totalNotes} notes listed, ${hashedNotes} content-verified, ${unverifiedNotes} unverified.`);
process.exit(0);
