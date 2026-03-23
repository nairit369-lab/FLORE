/**
 * Лёгкая оболочка: только окно Chromium с вашим сайтом (без встроенного Node-сервера).
 * Запуск: FLOR_WEB_URL=https://ваш-сервер/login.html npx electron electron-shell-main.js
 * Сборка EXE: npm run build:shell
 */
require('dotenv').config();
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const argUrl = (process.argv || []).slice(2).find((a) => /^https?:\/\//i.test(String(a).trim()));
const startUrl = (
    (process.env.FLOR_WEB_URL || '').trim() ||
    (argUrl || '').trim() ||
    'https://127.0.0.1:3000/login.html'
).replace(/\/+$/, '');

/** Самоподписанный HTTPS (LAN): как в основном Electron-приложении */
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    if (/^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
        event.preventDefault();
        callback(true);
        return;
    }
    const allow =
        process.env.ELECTRON_ALLOW_SELF_SIGNED === '1' || process.env.ELECTRON_ALLOW_SELF_SIGNED === 'true';
    if (allow) {
        event.preventDefault();
        callback(true);
        return;
    }
    callback(false);
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: path.join(__dirname, 'assets', 'flor-logo.png'),
        backgroundColor: '#12101a',
        show: false
    });
    win.loadURL(startUrl);
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
