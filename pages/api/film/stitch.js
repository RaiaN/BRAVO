import { stitchShots } from '../../../utils/film/server/stitch';

// Assemble the approved Auto Director shots into a single MP4 (the final cut).
// Thin HTTP wrapper over utils/film/server/stitch.js (shared with the Service API's
// `autoDirector` run): downloads each shot, concatenates with ffmpeg, re-hosts to
// TOS, and returns a presigned (browser-playable) URL + an asset id.

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }, // only shot URLs come in; the video is built server-side
};

export default async function stitchHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { shots, name } = req.body || {};
  if (!Array.isArray(shots) || shots.length === 0) {
    return res.status(400).json({ error: 'shots[] (ordered video URLs) is required' });
  }

  try {
    const out = await stitchShots({ shots, name });
    return res.status(200).json(out);
  } catch (error) {
    return res.status(500).json({ error: 'Stitch failed', details: error.message });
  }
}
