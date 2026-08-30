import { CONFIG, getEndpointUrl } from '../../utils/config';
import { checkInUrl as storeCheckInUrl } from '../../utils/server/mediaStore';

const checkInUrl = async (url) => {
  if (!url) return null;
  try { return (await storeCheckInUrl(url)).url; } catch { return null; }
};

async function seedanceStatusHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  
    const { taskId, apiKey, baseUrl } = req.query;
  
    if (!taskId) {
        return res.status(400).json({ error: 'Missing taskId' });
    }

    const token = process.env.MODELARK_API_KEY || process.env.ARK_API_KEY;
    
    const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s*/i, '').trim();
    const bearerToken = headerToken || token;

    if (!bearerToken) {
      return res.status(500).json({ error: 'API key not configured' });
    }
  
    const endpointBase = baseUrl || CONFIG.API_BASE_URL;
    const videoEndpoint = getEndpointUrl('video');
    const statusEndpoint = baseUrl 
        ? `${baseUrl}/contents/generations/tasks/${taskId}`
        : `${videoEndpoint}/${taskId}`;
  
    try {
      const response = await fetch(statusEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
      });
  
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Status check failed', details: data });
      }

      const result = {
          id: data.id,
          status: data.status,
      };

      if (data.status === 'succeeded' && data.content) {
          result.video_url = data.content.video_url;
          result.last_frame_url = data.content.last_frame_url
              || data.content.last_frame_image_url
              || data.content.last_frame
              || null;
          if (!result.last_frame_url) {
              console.warn('[seedance-status] return_last_frame on but no last-frame field — content keys:', Object.keys(data.content));
          }
          result.video_cache_url = await checkInUrl(result.video_url);
          result.last_frame_cache_url = await checkInUrl(result.last_frame_url);
      }

      if (data.error) {
          result.error = data.error;
      }
  
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Request failed', details: error.message });
    }
  }
  
  export default seedanceStatusHandler;
