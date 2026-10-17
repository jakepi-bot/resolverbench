'use strict';
/**
 * The renderer's entire view of the outside world.
 *
 * The window runs with context isolation on and no Node integration, so this
 * file is the complete list of things the UI can ask the main process to do:
 * read the catalog, run a benchmark, stop it, save a file, copy text, open a
 * link. Nothing here hands the renderer a socket, a path or an exec.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resolverbench', {
  info: () => ipcRenderer.invoke('app:info'),
  catalog: () => ipcRenderer.invoke('catalog:list'),
  systemResolvers: () => ipcRenderer.invoke('system:resolvers'),
  parseResolvers: (text) => ipcRenderer.invoke('resolvers:parse', text),

  run: (config) => ipcRenderer.invoke('bench:start', config),
  stop: () => ipcRenderer.invoke('bench:stop'),
  isRunning: () => ipcRenderer.invoke('bench:running'),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('bench:event', listener);
    return () => ipcRenderer.removeListener('bench:event', listener);
  },
  onMenu: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },

  exportCSV: (results, options) => ipcRenderer.invoke('export:csv', { results, options }),
  exportJSON: (results) => ipcRenderer.invoke('export:json', { results }),
  exportReport: (results) => ipcRenderer.invoke('export:report', { results }),
  conclusions: (results) => ipcRenderer.invoke('results:conclusions', results),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  open: (url) => ipcRenderer.invoke('shell:open', url),
});
