'use strict';
// Desktop app: a window around the same interface the website uses.
// The local server runs inside this app, so nothing else needs to be started.
const path = require('path');
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');

// Keep the database with the user's other app data when installed as a real app.
if (app.isPackaged && !process.env.ONEINBOX_DATA) process.env.ONEINBOX_DATA = path.join(app.getPath('userData'), 'data');
process.removeAllListeners('warning');

const config = require('../server/config');
// Set ONEINBOX_URL (in .env) to make this window show a hosted copy instead of running everything on this computer.
const REMOTE = (process.env.ONEINBOX_URL || '').replace(/\/+$/, '');
const LOCAL = REMOTE || `http://localhost:${config.PORT}`;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 420, minHeight: 520, title: 'OneInbox', backgroundColor: '#f5f4f0',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(LOCAL);
  // Sign-in pages, "Open in …" links and anything else that opens a new tab go to the normal browser.
  // (Google and Microsoft refuse to show their sign-in pages inside embedded app windows.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(LOCAL)) { event.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      if (!REMOTE) await require('../server/index.js').start();
    } catch (e) {
      // Port already in use usually means OneInbox is already running (for example via "npm start"): just show it.
      if (e.code !== 'EADDRINUSE') {
        dialog.showErrorBox('OneInbox could not start', String(e.message || e));
        return app.quit();
      }
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { label: 'OneInbox', submenu: [{ label: 'Open in browser', click: () => shell.openExternal(LOCAL) }] },
    ]));
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
