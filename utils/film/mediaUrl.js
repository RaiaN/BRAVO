// Local media-store urls + signed-url forensics, shared by the canvas and nodes.
//
// '/api/film/media?key=…'  — the GLOBAL content-addressed store (project-independent).
// '/api/film/asset?id=…'   — the legacy beside-the-project cache (still served for old
//                            projects; new check-ins go to the media store).

export const LOCAL_MEDIA_PREFIXES = ['/api/film/media', '/api/film/asset'];

export const isLocalMediaUrl = (u) =>
  typeof u === 'string' && LOCAL_MEDIA_PREFIXES.some((p) => u.startsWith(p));

// A local-store ref is same-origin relative — absolutize it so a SERVER (loopback
// fetch: preserve/register, reasoning refs) can download the file.
export const absLocalMediaUrl = (u) =>
  (isLocalMediaUrl(u) && typeof window !== 'undefined' ? `${window.location.origin}${u}` : u);

// Real expiry of a signed object-storage url (TOS or S3 signing style), read from its
// own query params — X-Tos-Date/X-Amz-Date (signing time) + X-Tos-Expires/X-Amz-Expires
// (TTL seconds). Returns ms-epoch, or null when the url is unsigned / unparseable.
export const signedUrlExpiry = (u) => {
  try {
    const q = new URL(u, 'http://local').searchParams;
    const date = q.get('X-Tos-Date') || q.get('X-Amz-Date');
    const ttl = Number(q.get('X-Tos-Expires') || q.get('X-Amz-Expires'));
    if (!date || !Number.isFinite(ttl) || ttl <= 0) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + ttl * 1000;
  } catch {
    return null;
  }
};

// True ONLY when the url carries a signature that has verifiably lapsed — the basis for
// an honest "Expired" verdict. An unsigned/undated url can fail a load for a hundred
// transient reasons; those must never be reported as expiry.
export const isProvablyExpired = (u) => {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  const t = signedUrlExpiry(u);
  return t != null && Date.now() > t;
};
