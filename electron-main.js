const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');

require('dotenv').config();

/**
 * По http://LAN:порт Chromium не считает страницу «безопасной» — getUserMedia/WebRTC недоступны.
 * Список origin через запятую, например: http://192.168.1.10:3000,http://10.0.0.2:3000
 * (только для своей сети / отладки).
 */
const florInsecureAsSecure = (process.env.ELECTRON_INSECURE_ORIGINS || '').trim();
if (florInsecureAsSecure) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', florInsecureAsSecure);
}

/** Самоподписанный HTTPS: localhost всегда; остальное — при ELECTRON_ALLOW_SELF_SIGNED=true */
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

let mainWindow;

async function createWindow() {
    let PORT = 3000;
    let useHttps = false;
    try {
        const flor = require('./server.js');
        await flor.startFlorServer();
        PORT = flor.PORT || 3000;
        useHttps = !!flor.useHttps;
    } catch (e) {
        console.error('Не удалось запустить встроенный сервер FLOR:', e);
    }

    const proto = useHttps ? 'https' : 'http';
    const startUrl = `${proto}://127.0.0.1:${PORT}/login.html`;

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, 'assets', 'flor-logo.png'),
        frame: true,
        titleBarStyle: 'default',
        backgroundColor: '#f6f4fb',
        show: false
    });

    mainWindow.loadURL(startUrl);
    mainWindow.once('ready-to-show', () => mainWindow.show());

    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    ipcMain.on('show-notification', (event, { title, body }) => {
        if (Notification.isSupported()) {
            new Notification({
                title,
                body,
                icon: path.join(__dirname, 'assets', 'flor-logo.png')
            }).show();
        }
    });

    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

app.on('ready', () => {
    createWindow().catch((e) => console.error(e));
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow().catch((e) => console.error(e));
    } else {
        mainWindow.show();
    }
});

app.on('before-quit', () => {
    app.isQuiting = true;
});

if (process.platform !== 'linux') {
    try {
        const { autoUpdater } = require('electron-updater');

        autoUpdater.on('update-downloaded', () => {
            autoUpdater.quitAndInstall();
        });

        app.on('ready', () => {
            if (process.env.NODE_ENV === 'production') {
                autoUpdater.checkForUpdates();
            }
        });
    } catch (_) {
        /* electron-updater optional */
    }
}
