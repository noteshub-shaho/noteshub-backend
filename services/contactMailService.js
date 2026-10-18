import { consumeRateLimit, clientIp } from "../utils/rateLimit.js";

export const DEFAULT_SUPPORT_INBOX = "noteshub.support@gmail.com";

export const CONTACT_MESSAGE_MAX = 4000;

export const CONTACT_CATEGORIES = [
  "General question",
  "Bug or issue",
  "Billing or purchase",
  "Notes request",
  "Account and login",
  "Privacy or legal",
  "Other",
];

export const CONTACT_IP_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 };

export const CONTACT_EMAIL_LIMIT = { limit: 3, windowMs: 10 * 60 * 1000 };

export function supportInbox() {
  const configured = process.env.NOTESHUB_SUPPORT_EMAIL;
  return configured && configured.trim() ? configured.trim() : DEFAULT_SUPPORT_INBOX;
}

export function senderIdentity() {
  const sender = process.env.NOTESHUB_SENDER_EMAIL;
  return sender && sender.trim() ? sender.trim() : null;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function singleLine(value, maxLength) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeCategory(value) {
  const candidate = singleLine(value, 40);
  if (!candidate) return CONTACT_CATEGORIES[0];
  const match = CONTACT_CATEGORIES.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
  return match ?? "Other";
}

export function buildSubjectLine({ category, subject }) {
  const cleanSubject = singleLine(subject, 120) || "General enquiry";
  const cleanCategory = normalizeCategory(category);
  return `[NotesHub Support] ${cleanCategory}: ${cleanSubject}`;
}

export function contactBlocked(req, email) {
  const ipResult = consumeRateLimit(`contact:ip:${clientIp(req)}`, CONTACT_IP_LIMIT);
  if (!ipResult.allowed) {
    return { blocked: true, retryAfterSeconds: ipResult.retryAfterSeconds, message: "Too many messages from this device. Try again later." };
  }
  const emailResult = consumeRateLimit(`contact:email:${String(email).toLowerCase()}`, CONTACT_EMAIL_LIMIT);
  if (!emailResult.allowed) {
    return { blocked: true, retryAfterSeconds: emailResult.retryAfterSeconds, message: "You have sent several messages recently. Try again later." };
  }
  return { blocked: false, retryAfterSeconds: 0, message: null };
}
