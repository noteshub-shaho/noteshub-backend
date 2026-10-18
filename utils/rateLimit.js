const buckets = new Map();

const MAX_KEYS = 5000;

function prune() {
  if (buckets.size <= MAX_KEYS) return;
  const timestamp = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= timestamp) buckets.delete(key);
  }
  if (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
}

export function consumeRateLimit(key, { limit, windowMs }) {
  prune();
  const timestamp = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= timestamp) {
    bucket = { count: 0, resetAt: timestamp + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const allowed = bucket.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000)),
  };
}

export function resetRateLimits() {
  buckets.clear();
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}
