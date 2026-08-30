const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('BRAVO_DESKTOP', true);
