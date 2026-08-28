// Same-origin image proxy for CANVAS work (the motion-arrow bake): a remote TOS/Seedream
// URL drawn into a <canvas> taints it unless the host sends CORS headers — fetching the
// bytes server-side and re-serving them same-origin makes the pixels always readable.
// Display never needs this (plain <img> is CORS-free); only the bake path uses it.

export default async function proxyImageHandler(req, res) {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'An http(s) url is required' });
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `Upstream ${r.status}` });
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) return res.status(400).json({ error: `Not an image (${type})` });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Proxy fetch failed' });
  }
}
