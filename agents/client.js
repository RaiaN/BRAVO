// The one place the app builds a transport client.
//
// kit owns the wire; this just names it. `createBrowserClient` posts to the app's
// own /api/* routes with relative urls, so it works in the browser and nowhere else —
// the test harness supplies its own absolute-url client instead.
import { createBrowserClient } from '../utils/film/core/client.js';

export const browserClient = (apiKey) => createBrowserClient(apiKey);
