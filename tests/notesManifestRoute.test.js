// Route wiring + controller validation tests.
// Run with: npm test  (node --test tests/)

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

import router from "../routes/notesRoute.js";
import { getNotesManifest } from "../controllers/notesController.js";

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("the manifest route is registered before the /:university catch-all", () => {
  const routePaths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(routePaths.includes("/manifest"), "manifest route exists");
  assert.ok(
    routePaths.indexOf("/manifest") < routePaths.indexOf("/:university/:semester/:subject"),
    "manifest must not be shadowed by the parameterized route"
  );
});

test("getNotesManifest rejects missing query parameters with 400", async () => {
  const res = makeRes();
  await getNotesManifest({ query: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);

  const res2 = makeRes();
  await getNotesManifest({ query: { university: "mu" } }, res2);
  assert.equal(res2.statusCode, 400);
});

test("getNotesManifest rejects unknown university/semester with 404", async () => {
  const res = makeRes();
  await getNotesManifest({ query: { university: "unknown", semester: "sem3" } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, "University not found");

  const res2 = makeRes();
  await getNotesManifest({ query: { university: "mu", semester: "sem99" } }, res2);
  assert.equal(res2.statusCode, 404);
  assert.equal(res2.body.message, "Semester not found");
});
