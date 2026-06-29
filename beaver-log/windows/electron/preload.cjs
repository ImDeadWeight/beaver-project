'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('beaverLogAPI', {
  network: {
    getLocalNetworkInfo: () => ipcRenderer.invoke('network:get-info'),
    scanForServers: (options) => ipcRenderer.invoke('network:scan', options),
  },
})
