// Central configuration for API endpoints
// This ensures we have a single source of truth for the ModelArk API base URL.

export const CONFIG = {
    // Default to the AP-Southeast endpoint if not overridden by env vars
    // REQUIRED — no default: set MODELARK_API_BASE_URL in .env.local (region base URL).
    API_BASE_URL: process.env.MODELARK_API_BASE_URL,
    
    // Helper to construct full endpoints
    endpoints: {
        chat: '/chat/completions',
        image: '/images/generations',
        video: '/contents/generations/tasks'
    }
};

// Helper function to get full URL
export const getEndpointUrl = (type) => {
    if (!CONFIG.API_BASE_URL) throw new Error('MODELARK_API_BASE_URL is not configured — set it in .env.local (see .env.example).');
    const base = CONFIG.API_BASE_URL.replace(/\/+$/, ''); // Remove trailing slash
    const path = CONFIG.endpoints[type];
    if (!path) return base;
    return `${base}${path}`;
};
