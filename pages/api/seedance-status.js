import { CONFIG, getEndpointUrl } from '../../utils/config';
import { checkInUrl as storeCheckInUrl } from '../../utils/server/mediaStore';

// Check a finished output into the two-tier store (local + TOS mirror) SERVER-SIDE, the
// moment we first see it — byte durability must never depend on the browser tab staying
// alive to run a client-side effect. Best-effort: a store hiccup never fails the poll.
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

    // In a real app, apiKey should probably come from a secure session or similar, 
    // but for this starter kit, we'll use the env var or the one passed (though passing sensitive info in query is not ideal).
    // Better: Rely on server-side env var for API key if possible, or pass via header if client stores it.
    // Here we'll default to env var.
    const token = process.env.MODELARK_API_KEY || process.env.ARK_API_KEY;
    
    // NOTE: If the user is using a custom API key entered in the UI, we need to pass it securely.
    // For now, let's assume the user has set the env var or we can't poll easily without passing it back.
    // Since the original design stores key in localStorage, the client should pass it.
    // Let's check headers first.
    // Robust parse: 'Bearer <key>' → key; a bare/empty 'Bearer' (key-less client)
    // falls back to the server-configured key instead of forwarding garbage to Ark.
    const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s*/i, '').trim();
    const bearerToken = headerToken || token;

    if (!bearerToken) {
      return res.status(500).json({ error: 'API key not configured' });
    }
  
    // Use config-defined base URL, fallback to passed baseUrl if provided
    const endpointBase = baseUrl || CONFIG.API_BASE_URL;
    // Construct video endpoint (task status is usually under the same path structure)
    // e.g. /contents/generations/tasks/{taskId}
    // We can use getEndpointUrl('video') which returns .../contents/generations/tasks
    // Then append taskId
    const videoEndpoint = getEndpointUrl('video');
    // However, if baseUrl is custom, getEndpointUrl won't use it.
    // So we need manual construction if baseUrl is provided.
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

      // Transform response to simplified format
      // API returns: { id, status: "succeeded", content: { video_url: "..." }, ... }
      const result = {
          id: data.id,
          status: data.status,
      };

      if (data.status === 'succeeded' && data.content) {
          result.video_url = data.content.video_url;
          // The PNG last frame, returned because the task was created with
          // return_last_frame:true — used for shot-to-shot continuity. Field name is
          // tolerant; log the content keys once if none match so it can be corrected live.
          result.last_frame_url = data.content.last_frame_url
              || data.content.last_frame_image_url
              || data.content.last_frame
              || null;
          if (!result.last_frame_url) {
              console.warn('[seedance-status] return_last_frame on but no last-frame field — content keys:', Object.keys(data.content));
          }
          // SOURCE-SIDE durability: the take (and its continuity frame) go into the
          // local store + TOS mirror before the client even learns they exist. The
          // one-time download cost rides this single succeeded poll.
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
