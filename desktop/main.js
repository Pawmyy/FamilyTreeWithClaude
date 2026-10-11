// The desktop app: the same local server and page as `npm start`, in a window of their own.
// The record is a SQLite file in the user's own data folder, so it survives updates of the app.
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { createApp, openDb } from '../server.js';

// The page as built by web/build.js, with its libraries inside so it opens without the internet.
const PAGE = join(app.getAppPath(), 'dist', 'desktop');

let address = null;
let server = null;

function openWindow() {
  const win = new BrowserWindow({ width: 1280, height: 820, minWidth: 420, minHeight: 480, autoHideMenuBar: true, title: 'Family Graph' });
  // Links off the page, such as the map's credits, belong in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(address);
}

if (!app.requestSingleInstanceLock()) {
  // Two copies would both write the same record.
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(() => {
    // Bound to localhost on a free port: this holds personal data about living people.
    server = createApp(openDb(join(app.getPath('userData'), 'family.db')), PAGE);
    server.listen(0, '127.0.0.1', () => {
      address = `http://127.0.0.1:${server.address().port}/`;
      openWindow();
    });
    app.on('activate', () => address && !BrowserWindow.getAllWindows().length && openWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
  app.on('quit', () => server?.close());
}
