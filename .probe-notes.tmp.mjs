// Read-only probe: what does the notes data layer actually return?
import dotenv from "dotenv";
dotenv.config({ path: "/home/shahid/Pictures/NOTES-APP/backend/.env" });

import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log("cloud_name:", process.env.CLOUDINARY_CLOUD_NAME, "api_key set:", !!process.env.CLOUDINARY_API_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const paths = [
  "mu/sem4/cth",
  "mu/sem4/os",
  "mu/sem4/dbms",
  "mu/sem3/aoa",
  "msbte/sem5/manual",
];

for (const p of paths) {
  const folderPath = `noteshub/${p}`;
  // 1. current method
  let byAssetFolder;
  try {
    const r = await cloudinary.api.resources_by_asset_folder(folderPath, { max_results: 100 });
    byAssetFolder = `OK n=${(r.resources || []).length}`;
  } catch (e) {
    byAssetFolder = `ERR ${e.http_code ?? ""} ${e.message}`;
  }
  // 2. prefix method
  let byPrefix;
  try {
    const r = await cloudinary.api.resources({ type: "upload", prefix: folderPath + "/", max_results: 100, resource_type: "image" });
    byPrefix = `OK n=${(r.resources || []).length} sample=${(r.resources || []).slice(0, 3).map((x) => x.public_id).join(",")}`;
  } catch (e) {
    byPrefix = `ERR ${e.http_code ?? ""} ${e.message}`;
  }
  // 3. supabase
  let supa;
  try {
    const { data, error } = await supabase.storage.from("notes").list(p, { limit: 100 });
    supa = error ? `ERR ${error.message}` : `OK n=${(data || []).length} names=${(data || []).map((x) => x.name).slice(0, 5).join(",")}`;
  } catch (e) {
    supa = `THROW ${e.message}`;
  }
  console.log(`\n${p}\n  resources_by_asset_folder: ${byAssetFolder}\n  resources(prefix):          ${byPrefix}\n  supabase list:              ${supa}`);
}

// Is the "noteshub" root folder populated at all?
try {
  const r = await cloudinary.api.resources({ type: "upload", prefix: "noteshub/", max_results: 20, resource_type: "image" });
  console.log(`\nROOT noteshub/ prefix total(first page)=${r.resources.length} next=${r.next_cursor ? "yes" : "no"}`);
  console.log(r.resources.map((x) => x.public_id).join("\n"));
} catch (e) {
  console.log("\nROOT prefix ERR", e.http_code, e.message);
}
