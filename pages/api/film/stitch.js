import { stitchShots } from '../../../utils/film/server/stitch';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
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
