const { contextBridge } = require('electron');

// The one thing the renderer needs to know: it is running in the desktop window, not a
// browser tab. `pages/index.js` reads this to add `body.desktop`, which is what turns
// the top strip into a real -webkit-app-region drag handle. Nothing else is exposed —
// no Node, no fs, no ipc surface that does not yet have a caller.
contextBridge.exposeInMainWorld('BRAVO_DESKTOP', true);
