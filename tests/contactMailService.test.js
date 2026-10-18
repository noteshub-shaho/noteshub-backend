import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTACT_CATEGORIES,
  CONTACT_EMAIL_LIMIT,
  CONTACT_IP_LIMIT,
  DEFAULT_SUPPORT_INBOX,
  buildSubjectLine,
  contactBlocked,
  escapeHtml,
  normalizeCategory,
  singleLine,
  supportInbox,
} from "../services/contactMailService.js";
import { consumeRateLimit, resetRateLimits } from "../utils/rateLimit.js";

test("escapeHtml neutralises markup in user supplied text", () => {
  assert.equal(escapeHtml(`<b>"Alice" & 'co'</b>`), "&lt;b&gt;&quot;Alice&quot; &amp; &#39;co&#39;&lt;/b&gt;");
  assert.equal(escapeHtml(undefined), "");
});

test("singleLine collapses new lines and enforces a maximum length", () => {
  const clean = singleLine("hello\r\nworld   again", 11);
  assert.equal(clean, "hello world");
  assert.equal(singleLine("abcdefghij", 4).length, 4);
});

test("unknown categories fall back to Other and known ones pass through", () => {
  assert.equal(normalizeCategory("Billing or purchase"), "Billing or purchase");
  assert.equal(normalizeCategory("no-such-category"), "Other");
  assert.equal(normalizeCategory(""), CONTACT_CATEGORIES[0]);
});

test("subject line keeps category and message on one safe line", () => {
  const subject = buildSubjectLine({ category: "Bug or issue", subject: "PDF\nfails to open" });
  assert.equal(subject, "[NotesHub Support] Bug or issue: PDF fails to open");
});

test("support inbox defaults to the documented address", () => {
  delete process.env.NOTESHUB_SUPPORT_EMAIL;
  assert.equal(supportInbox(), DEFAULT_SUPPORT_INBOX);
  assert.equal(DEFAULT_SUPPORT_INBOX, "noteshub.support@gmail.com");
});

test("rate limiter allows up to the limit inside the window", () => {
  resetRateLimits();
  const options = { limit: 2, windowMs: 60_000 };
  assert.equal(consumeRateLimit("k", options).allowed, true);
  assert.equal(consumeRateLimit("k", options).allowed, true);
  const blocked = consumeRateLimit("k", options);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test("contact submission is blocked once a bucket is exhausted", () => {
  resetRateLimits();
  const req = { headers: { "x-forwarded-for": "203.0.113.7" }, ip: "127.0.0.1" };
  for (let i = 0; i < CONTACT_IP_LIMIT.limit; i++) {
    assert.equal(contactBlocked(req, `student${i}@university.edu`).blocked, false);
  }
  const blocked = contactBlocked(req, "another@university.edu");
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.message);
});

test("separate email buckets do not share the ip bucket", () => {
  resetRateLimits();
  const req = { headers: {}, ip: "198.51.100.4" };
  for (let i = 0; i < CONTACT_EMAIL_LIMIT.limit; i++) {
    assert.equal(contactBlocked(req, "one@university.edu").blocked, false);
  }
  assert.equal(contactBlocked(req, "one@university.edu").blocked, true);
  assert.equal(contactBlocked(req, "two@university.edu").blocked, false);
});
