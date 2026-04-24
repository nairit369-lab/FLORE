/**
 * FLOR MESSENGER — локализация интерфейса (статические строки + fallback на en).
 * Непереведённые ключи в языке берутся из английского набора.
 */
(function (global) {
    'use strict';

    const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

    /** Список для селектора: code → подпись (родной язык) */
    const FLOR_LOCALE_META = [
        { code: 'en', label: 'English' },
        { code: 'zh', label: '中文 (简体)' },
        { code: 'hi', label: 'हिन्दी' },
        { code: 'es', label: 'Español' },
        { code: 'fr', label: 'Français' },
        { code: 'ar', label: 'العربية' },
        { code: 'pt', label: 'Português' },
        { code: 'ru', label: 'Русский' },
        { code: 'tt', label: 'Татарча' },
        { code: 'he', label: 'עברית' },
        { code: 'uk', label: 'Українська' },
        { code: 'be', label: 'Беларуская' },
        { code: 'kk', label: 'Қазақша' },
        { code: 'pl', label: 'Polski' },
        { code: 'az', label: 'Azərbaycanca' },
        { code: 'hy', label: 'Հայերեն' },
        { code: 'ka', label: 'ქართული' },
        { code: 'ky', label: 'Кыргызча' },
        { code: 'uz', label: "O'zbek" },
        { code: 'tg', label: 'Тоҷикӣ' },
        { code: 'tk', label: 'Türkmençe' },
        { code: 'ro', label: 'Română' },
        { code: 'et', label: 'Eesti' },
        { code: 'lv', label: 'Latviešu' },
        { code: 'lt', label: 'Lietuvių' }
    ];

    const SETTINGS_KEY = 'florMessengerSettings';

    function florReadStoredLocale() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return typeof s.locale === 'string' ? s.locale.trim() : '';
        } catch {
            return '';
        }
    }

    function florNormalizeLocaleCode(code) {
        if (!code) return 'en';
        let c = String(code).trim().toLowerCase();
        if (c.length >= 2) {
            const base = c.split(/[-_]/)[0];
            const known = new Set(FLOR_LOCALE_META.map((x) => x.code));
            if (known.has(base)) return base;
        }
        return 'en';
    }

    function florDetectInitialLocale() {
        const stored = florReadStoredLocale();
        if (stored) return florNormalizeLocaleCode(stored);
        let nav = '';
        try {
            nav = (navigator.language || navigator.userLanguage || '').trim();
        } catch (_) {}
        return florNormalizeLocaleCode(nav);
    }

    /** Английский — эталон полного набора ключей */
    const EN = {
        common: {
            save: 'Save',
            cancel: 'Cancel',
            close: 'Close',
            delete: 'Delete',
            search: 'Search',
            options: 'Options',
            loading: 'Loading…',
            user: 'User'
        },
        meta: {
            appTitle: 'FLOR MESSENGER',
            appDesc: 'Chats, servers, voice rooms and direct messages.'
        },
        nav: {
            friends: 'Friends',
            friendsDm: 'Friends & direct messages',
            addServer: 'Add server',
            servers: 'Servers',
            messages: 'Messages',
            profile: 'Profile',
            newChat: 'New chat',
            newGroup: 'New group',
            myServers: 'My servers',
            bookmarks: 'Bookmarks',
            settings: 'Settings',
            privacy: 'Privacy',
            logout: 'Log out',
            menu: 'Menu',
            serversSection: 'Servers'
        },
        dm: {
            title: 'Messages',
            searchPlaceholder: 'Find or start a conversation',
            sectionDm: 'DIRECT MESSAGES',
            emptyTitle: 'No conversations yet',
            emptyHint: 'Add a friend on the “Add” tab to start a direct chat.',
            fallbackTitle: 'Chat',
            liquidHint:
                'Calls and attachments are in the chat header. Open a chat from the list on the left.'
        },
        friends: {
            online: 'Online',
            all: 'All',
            requests: 'Requests',
            add: 'Add',
            addFriend: 'ADD FRIEND',
            addFriendLead: 'Find a user by name and send a friend request.',
            usernamePh: 'Username',
            find: 'Find',
            emptyOnline: 'No friends online',
            emptyAll: 'You have no friends yet',
            emptyPending: 'No incoming friend requests',
            offline: 'Offline'
        },
        server: {
            headerFriends: 'Friends',
            channels: 'channels',
            members: 'Members',
            groupMenu: 'Group menu',
            labelGeneral: 'general',
            labelRandom: 'random',
            labelVoice1: 'Main voice',
            labelVoice2: 'Games'
        },
        chat: {
            messagePlaceholder: 'Write a message…',
            messageInChannel: 'Message in #{{channel}}',
            messageToUser: 'Message to @{{user}}',
            searchInChat: 'Search in chat…',
            attach: 'Attach file',
            send: 'Send',
            voiceRec: 'Voice message',
            emoji: 'Emoji',
            wallpaperNone: 'No wallpaper',
            wallpaperPurple: 'Purple gradient',
            wallpaperNight: 'Night gradient',
            wallpaperMint: 'Mint'
        },
        desktop: {
            themeDarkTitle: 'Dark theme',
            themeLightTitle: 'Light theme',
            friendRequestsTitle: 'Friend requests',
            notifLabel: 'Friend requests'
        },
        mobile: {
            tabChats: 'Chats',
            tabFriends: 'Friends',
            tabServers: 'Servers',
            tabProfile: 'Profile',
            tabbarNav: 'Bottom navigation'
        },
        liquid: {
            title: 'FLOR',
            subtitle: 'Choose a chat on the left',
            hintDefault:
                'Calls, attachments, bookmarks and settings are in the header and input field, as before.',
            friendsSub: 'Friends and direct messages',
            friendsHint:
                'Open a chat from the list on the left. Calls and attachments are in the chat header.',
            dmSub: 'Direct messages',
            dmHint: 'Open their profile from the avatar in the header.',
            serverNameFallback: 'Server',
            groupLabel: 'Group',
            aboutChat: 'About chat',
            members: 'Group members',
            loadMembersError: 'Failed to load members',
            backToChats: 'Back to chats'
        },
        auth: {
            pageTitle: 'Sign in',
            pageTitleReg: 'Sign up',
            titleWelcome: 'Welcome back',
            titleRegister: 'Create account',
            leadRegister: 'Create your FLOR MESSENGER account.',
            username: 'Username',
            email: 'Email',
            sendCode: 'Send code',
            password: 'Password',
            twoFactorLabel: '2FA code from email',
            twoFactorPh: '6 digits',
            forgotPassword: 'Forgot password?',
            confirmPassword: 'Confirm password',
            emailCode: 'Code from email',
            emailCodePh: '6 digits',
            rememberEmail: 'Remember email on this device',
            termsAcceptHtml:
                'I accept the <a href="terms.html" target="_blank" rel="noopener noreferrer">Terms of use</a> and <a href="privacy.html" target="_blank" rel="noopener noreferrer">Privacy policy</a>.',
            submitLogin: 'Sign in',
            submitRegister: 'Create account',
            qrLogin: 'Sign in with QR',
            noAccount: "Don’t have an account?",
            haveAccount: 'Already have an account?',
            linkRegister: 'Sign up',
            linkLogin: 'Sign in',
            legalLine:
                '<a href="privacy.html">Privacy</a> · <a href="terms.html">Terms of use</a>',
            forgotPwdMsg:
                'Password reset: ask your FLOR server administrator to reset the password for your email.',
            qrScanTitle: 'Show this QR on another device, or scan a QR from a PC with the button below (phone)',
            qrAlt: 'Sign-in QR code',
            qrWait: 'Waiting for confirmation…',
            qrWaitOtherDevice:
                'On a device where you are already signed in, confirm the sign-in or open the link from the code.',
            qrScanCamera: 'Scan QR with camera',
            qrScanning: 'Point the camera at the code on the other screen',
            qrScanClose: 'Close',
            qrApproveTitle: 'Confirm sign-in on another device?',
            qrApproveBtn: 'Confirm sign-in',
            twoFactor: '2FA code from email',
            back: 'Back'
        },
        authApi: {
            invalidCredentials: 'Invalid credentials',
            emailPasswordRequired: 'Email and password required',
            loginFailed: 'Login failed',
            registrationFailed: 'Registration failed',
            allFieldsRequired: 'All fields required',
            emailRegistered: 'Email already registered',
            passwordShort: 'Password must be at least 6 characters',
            emailCodeRequired: 'Email verification code required',
            invalidEmailCode: 'Invalid email verification code',
            emailCodeExpired: 'Email verification code expired',
            invalidEmailFormat: 'Invalid email format',
            waitBeforeEmailCode: 'Please wait before requesting another email code',
            smtpNotConfigured:
                'Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env',
            sendCodeFailed: 'Failed to send verification code',
            qrSessionExpired: 'QR session expired',
            qrCreateFailed: 'Failed to create QR session',
            qrApproveFailed: 'QR approve failed',
            emailAlertsFailed: 'Failed to enable email alerts',
            twoFactorRequired: 'Two-factor code required'
        },
        authClient: {
            usernameMin: 'Username must be at least 3 characters',
            passwordMismatch: 'Passwords do not match',
            termsRequired: 'You must accept the terms and privacy policy to register',
            emailInvalid: 'Please enter a valid email address',
            passwordMin: 'Password must be at least 6 characters',
            codeSix: 'Enter the 6-digit code from the email',
            loginFail: 'Sign-in failed',
            noToken: 'The server did not return a session. Please try again.',
            loginOk: 'Signed in. Redirecting…',
            networkError: 'Network error. Check your connection and try again.',
            registerFail: 'Registration failed',
            accountOk: 'Account created. Redirecting…',
            sendCodeFail: 'Could not send code',
            codeSent: 'A code was sent to your email. Check inbox and spam.',
            codeSendNetwork: 'Network error. Please try again.',
            enterEmailFirst: 'Please enter a valid email first',
            qrStartFail: 'Could not start QR sign-in',
            qrFinishFail: 'Could not complete QR sign-in',
            qrSessionNotFound: 'QR session not found',
            qrNeedPhone: 'Sign in to this account on your phone first, then confirm the QR',
            qrApproveFail2: 'Could not confirm QR sign-in',
            qrDone: 'Done. The other device will sign in automatically.',
            qrNet: 'Network error. Please try again.',
            backAdmin: 'Back',
            sendingCode: 'Sending…',
            qrCreating: 'Creating QR…',
            qrScanConfirm: 'Scan the QR and confirm sign-in on your phone.',
            qrSignInProgress: 'Success! Signing in…',
            qrNoCamera: 'Could not use the camera. Allow access in the browser or use a secure connection (HTTPS).',
            qrInvalidQr: 'This QR is not a FLOR sign-in code. Check the code and try again.',
            qrScanUnsupported: 'This browser cannot read QR. Try Chrome or allow scripts from the CDN (jsQR).'
        },
        settings: {
            title: 'Settings',
            subtitle: 'Profile, notifications, security and appearance',
            navProfile: 'Profile',
            navPrivacy: 'Privacy',
            navNotifications: 'Notifications',
            navSecurity: 'Security',
            navInterface: 'Interface',
            navDevices: 'Microphone & sound',
            navAppearance: 'Chat & background',
            navAi: 'AI in chats',
            profileH: 'Profile',
            profileCallout:
                'Avatar and banner are saved to your account. The name at the bottom left is only in this browser.',
            photo: 'Profile photo',
            pickFile: 'Choose file…',
            photoHint: 'JPEG, PNG, GIF, WebP up to 4 MB',
            banner: 'Banner (profile card background)',
            displayName: 'Name at bottom left',
            bio: 'About (friends see in profile)',
            bioPlaceholder: 'A few words about yourself…',
            avatarLetters: 'Or letters in avatar (up to 4 characters)',
            privacyH: 'Privacy',
            privacyCallout:
                'Extra UI limits. Main chat rules are set by the server admin.',
            dmFriendsOnly: 'Only friends can message me',
            groupInvitesFriends: 'Group invites only from friends',
            hideOnline: 'Show “Invisible” status',
            notifH: 'Notifications',
            desktopNotif: 'Desktop notifications',
            soundInApp: 'Sound in open chat',
            dndH: 'Do not disturb',
            dndOn: 'Enable on schedule',
            dndFrom: 'From',
            dndTo: 'to',
            securityH: 'Security',
            securityCallout: 'Recent sign-ins in this browser (for your control).',
            qrSignInH: 'Sign in on another device with QR',
            qrSignInP:
                'Scan the QR shown on your PC to approve sign-in there. You stay signed in on this device — no need to log out.',
            qrSignInBtn: 'Scan QR code',
            qrScanTitle: 'Approve sign-in on another device',
            qrScanIntro: 'Point the camera at the QR code on your computer screen. It’s the same code as on the sign-in page.',
            qrSignInConfirm: 'Sign out on this device and open the sign-in page with the QR scanner?',
            changePwd: 'Change password',
            pwdChangeLead: 'First enter your current password, then the new one on the next step.',
            pwdChangeNext: 'Next',
            pwdChangeBack: 'Back',
            pwdChangeNeedCurrent: 'Enter your current password.',
            pwdChangeNeedNew: 'The new password must be at least 6 characters.',
            pwdChangeOk: 'Password updated.',
            currentPwd: 'Current password',
            newPwd: 'New password',
            changePwdBtn: 'Change password',
            interfaceH: 'Interface',
            language: 'Interface language',
            languageHint: 'Text and layout direction (e.g. Arabic) update after saving.',
            interfaceCallout: 'Theme is also available from the button at the bottom left.',
            compact: 'Compact messages',
            fontScale: 'Font scale',
            sidebarWidth: 'Sidebar column width',
            linksNewTab: 'Open chat links in a new tab',
            hotkeysH: 'Hotkeys',
            hotkeySearch: '— focus search in chat',
            hotkeyEsc: '— close modals',
            hotkeySearchHtml: '<kbd>Ctrl</kbd> + <kbd>K</kbd> — focus search in chat',
            hotkeyEscHtml: '<kbd>Esc</kbd> — close modals',
            devicesH: 'Microphone & headphones',
            mediaWarn:
                'The browser may block the microphone on plain http:// to an IP (except localhost). Use HTTPS in production (see .env).',
            devicesCallout:
                'Device choice applies on the next call connection. Microphone test is below.',
            mic: 'Microphone',
            output: 'Output',
            refreshDevices: 'Refresh device list',
            micTest: 'Test microphone',
            stop: 'Stop',
            voiceGroupH: 'Group voice (only for you)',
            voiceGroupHint:
                'During a call, use per-participant options for volume and mute. Stored in this browser only.',
            resetVoicePrefs: 'Reset all participant volume settings',
            aiH: 'AI in chats',
            aiCallout:
                'Summary and pre-send polish. Requests go through your FLOR server — check privacy. Keys stay in this browser (localStorage) if not in server .env.',
            aiProvider: 'Provider',
            aiOff: 'Off',
            aiKey: 'API key (optional if set on server)',
            aiModel: 'Model (empty = default)',
            aiAssist: '“Auto-edit” bar near the input (typing hints)',
            appearanceH: 'Chat appearance',
            appearanceCallout: 'Background and blur in the message area.',
            preset: 'Background preset',
            customUrl: 'Custom image URL (optional)',
            blur: 'Background blur',
            saveBtn: 'Save',
            legalPrivacy: 'Privacy',
            legalTerms: 'Terms',
            securityFooter:
                'Do not share passwords or payment data in chat. For best privacy, use end-to-end encrypted services you trust.',
            updatePwdOk: 'Password updated',
            saveProfileFail: 'Could not save profile on server; other settings kept locally.',
            uploadFail: 'Upload failed',
            avatarLen: 'Text avatar must be 4 characters or less (or upload a photo).',
            openSettings: 'Open settings'
        },
        profile: {
            screenTitle: 'Profile',
            online: 'online',
            statusInvisible: 'Invisible',
            account: 'Account',
            notifications: 'Notifications',
            appearance: 'Appearance',
            myServers: 'My servers',
            about: 'About the app',
            edit: 'Edit'
        },
        confirm: {
            title: 'Confirmation',
            logout: 'Log out of this device? The session in this browser will end.',
            logoutTitle: 'Sign out',
            confirmBtn: 'Log out',
            deleteBtn: 'Delete'
        }
    };

    const RU = {
        common: {
            save: 'Сохранить',
            cancel: 'Отмена',
            close: 'Закрыть',
            delete: 'Удалить',
            search: 'Поиск',
            options: 'Опции',
            loading: 'Загрузка…',
            user: 'Пользователь'
        },
        meta: {
            appTitle: 'FLOR MESSENGER',
            appDesc: 'Чаты, серверы, голосовые комнаты и личные сообщения.'
        },
        nav: {
            friends: 'Друзья',
            friendsDm: 'Друзья и личные сообщения',
            addServer: 'Добавить сервер',
            servers: 'Серверы',
            messages: 'Сообщения',
            profile: 'Профиль',
            newChat: 'Новый чат',
            newGroup: 'Новая группа',
            myServers: 'Мои серверы',
            bookmarks: 'Закладки',
            settings: 'Настройки',
            privacy: 'Приватность',
            logout: 'Выйти',
            menu: 'Меню',
            serversSection: 'Серверы'
        },
        dm: {
            title: 'Сообщения',
            searchPlaceholder: 'Найти или начать беседу',
            sectionDm: 'ЛИЧНЫЕ СООБЩЕНИЯ',
            emptyTitle: 'Пока нет переписок',
            emptyHint: 'Добавьте друга во вкладке «Добавить» — и начните личную беседу.',
            fallbackTitle: 'Чат',
            liquidHint:
                'Откройте диалог в списке слева. Звонки и вложения — в шапке чата.'
        },
        friends: {
            online: 'В сети',
            all: 'Все',
            requests: 'Запросы',
            add: 'Добавить',
            addFriend: 'ДОБАВИТЬ ДРУГА',
            addFriendLead: 'Найдите пользователя по имени и отправьте заявку в друзья.',
            usernamePh: 'Имя пользователя',
            find: 'Найти',
            emptyOnline: 'Нет друзей в сети',
            emptyAll: 'У вас пока нет друзей',
            emptyPending: 'Нет входящих заявок',
            offline: 'Не в сети'
        },
        server: {
            headerFriends: 'Друзья',
            channels: 'каналы',
            members: 'Участники',
            groupMenu: 'Меню группы',
            labelGeneral: 'общий',
            labelRandom: 'разное',
            labelVoice1: 'Общий голос',
            labelVoice2: 'Игры'
        },
        chat: {
            messagePlaceholder: 'Написать сообщение…',
            messageInChannel: 'Сообщение в #{{channel}}',
            messageToUser: 'Сообщение для @{{user}}',
            searchInChat: 'Поиск в чате…',
            attach: 'Прикрепить файл',
            send: 'Отправить',
            voiceRec: 'Голосовое сообщение',
            emoji: 'Эмодзи',
            wallpaperNone: 'Без фона',
            wallpaperPurple: 'Фиолетовый градиент',
            wallpaperNight: 'Ночной градиент',
            wallpaperMint: 'Мятный'
        },
        desktop: {
            themeDarkTitle: 'Тёмная тема',
            themeLightTitle: 'Светлая тема',
            friendRequestsTitle: 'Заявки в друзья',
            notifLabel: 'Заявки в друзья'
        },
        mobile: {
            tabChats: 'Чаты',
            tabFriends: 'Друзья',
            tabServers: 'Серверы',
            tabProfile: 'Профиль',
            tabbarNav: 'Нижнее меню'
        },
        liquid: {
            title: 'FLOR',
            subtitle: 'Выберите чат слева',
            hintDefault:
                'Звонки, вложения, закладки и настройки — в шапке и поле ввода, как раньше.',
            friendsSub: 'Друзья и личные сообщения',
            friendsHint:
                'Откройте диалог в списке слева. Звонки и вложения — в шапке чата.',
            dmSub: 'Личные сообщения',
            dmHint: 'Профиль собеседника — нажмите на аватар в шапке.',
            serverNameFallback: 'Сервер',
            groupLabel: 'Группа',
            aboutChat: 'О чате',
            members: 'Участники группы',
            loadMembersError: 'Не удалось загрузить участников',
            backToChats: 'Назад к чатам'
        },
        auth: {
            pageTitle: 'Вход',
            pageTitleReg: 'Регистрация',
            titleWelcome: 'С возвращением',
            titleRegister: 'Регистрация',
            leadRegister: 'Создайте аккаунт во FLOR MESSENGER.',
            username: 'Имя пользователя',
            email: 'Электронная почта',
            sendCode: 'Отправить код',
            password: 'Пароль',
            twoFactorLabel: 'Код 2FA из письма',
            twoFactorPh: '6 цифр',
            forgotPassword: 'Забыли пароль?',
            confirmPassword: 'Повторите пароль',
            emailCode: 'Код из письма',
            emailCodePh: '6 цифр',
            rememberEmail: 'Запомнить email на этом устройстве',
            termsAcceptHtml:
                'Я принимаю <a href="terms.html" target="_blank" rel="noopener noreferrer">условия пользования</a> и <a href="privacy.html" target="_blank" rel="noopener noreferrer">политику конфиденциальности</a>.',
            submitLogin: 'Войти',
            submitRegister: 'Зарегистрироваться',
            qrLogin: 'Войти через QR',
            noAccount: 'Нет аккаунта?',
            haveAccount: 'Уже есть аккаунт?',
            linkRegister: 'Регистрация',
            linkLogin: 'Войти',
            legalLine:
                '<a href="privacy.html">Конфиденциальность</a> · <a href="terms.html">Условия использования</a>',
            forgotPwdMsg:
                'Восстановление пароля: обратитесь к администратору сервера FLOR, чтобы сбросить пароль для вашего email.',
            qrScanTitle:
                'Покажите этот QR на другом устройстве или отсканируйте с экрана ПК (кнопка ниже — для телефона)',
            qrAlt: 'QR для входа',
            qrWait: 'Ожидание подтверждения…',
            qrWaitOtherDevice:
                'На устройстве, где вы уже вошли, подтвердите вход в запросе или откройте ссылку из кода.',
            qrScanCamera: 'Сканировать QR камерой',
            qrScanning: 'Наведите камеру на код на другом экране',
            qrScanClose: 'Закрыть',
            qrApproveTitle: 'Подтвердить вход на другом устройстве?',
            qrApproveBtn: 'Подтвердить вход',
            twoFactor: 'Код 2FA из письма',
            back: 'Назад'
        },
        authApi: {
            invalidCredentials: 'Неверный email или пароль',
            emailPasswordRequired: 'Введите email и пароль',
            loginFailed: 'Ошибка входа',
            registrationFailed: 'Ошибка регистрации',
            allFieldsRequired: 'Заполните все поля',
            emailRegistered: 'Этот email уже зарегистрирован',
            passwordShort: 'Пароль не короче 6 символов',
            emailCodeRequired: 'Введите код из письма',
            invalidEmailCode: 'Неверный код подтверждения',
            emailCodeExpired: 'Код подтверждения истёк. Запросите новый',
            invalidEmailFormat: 'Введите корректный email',
            waitBeforeEmailCode: 'Подождите минуту перед повторной отправкой кода',
            smtpNotConfigured:
                'На сервере не настроена отправка почты (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)',
            sendCodeFailed: 'Не удалось отправить код подтверждения',
            qrSessionExpired: 'QR-код устарел. Обновите его',
            qrCreateFailed: 'Не удалось создать QR-вход',
            qrApproveFailed: 'Не удалось подтвердить вход по QR',
            emailAlertsFailed: 'Не удалось включить уведомления на почту',
            twoFactorRequired: 'Отправили код подтверждения на вашу почту. Введите его для входа'
        },
        authClient: {
            usernameMin: 'Имя пользователя — не менее 3 символов',
            passwordMismatch: 'Пароли не совпадают',
            termsRequired: 'Для регистрации нужно принять условия пользования и политику конфиденциальности',
            emailInvalid: 'Введите корректный адрес email',
            passwordMin: 'Пароль — не менее 6 символов',
            codeSix: 'Введите 6-значный код из письма',
            loginFail: 'Не удалось войти',
            noToken: 'Сервер не вернул токен. Попробуйте снова.',
            loginOk: 'Вход выполнен. Переход…',
            networkError: 'Сеть недоступна. Проверьте подключение и попробуйте снова.',
            registerFail: 'Не удалось зарегистрироваться',
            accountOk: 'Аккаунт создан. Переход…',
            sendCodeFail: 'Не удалось отправить код',
            codeSent: 'Код отправлен на почту. Проверьте входящие и спам.',
            codeSendNetwork: 'Сеть недоступна. Попробуйте снова.',
            enterEmailFirst: 'Сначала введите корректный email',
            qrStartFail: 'Не удалось запустить QR-вход',
            qrFinishFail: 'Не удалось завершить вход по QR',
            qrSessionNotFound: 'QR-сессия не найдена',
            qrNeedPhone: 'Сначала войдите в этот аккаунт на телефоне, затем подтвердите QR-вход',
            qrApproveFail2: 'Не удалось подтвердить QR-вход',
            qrDone: 'Готово. На другом устройстве вход будет выполнен автоматически.',
            qrNet: 'Сеть недоступна. Попробуйте снова.',
            backAdmin: 'Назад',
            sendingCode: 'Отправка…',
            qrCreating: 'Создаю QR…',
            qrScanConfirm: 'Сканируйте QR и подтвердите вход на телефоне.',
            qrSignInProgress: 'Успешно! Выполняю вход…',
            qrNoCamera:
                'Не удалось открыть камеру. Разрешите доступ в настройках браузера или используйте HTTPS.',
            qrInvalidQr: 'Это не FLOR QR для входа. Проверьте код и попробуйте снова.',
            qrScanUnsupported: 'В этом браузере нет распознавания QR. Попробуйте Chrome или обновите страницу.'
        },
        settings: {
            title: 'Настройки',
            subtitle: 'Профиль, уведомления, безопасность и оформление',
            navProfile: 'Профиль',
            navPrivacy: 'Приватность',
            navNotifications: 'Уведомления',
            navSecurity: 'Безопасность',
            navInterface: 'Интерфейс',
            navDevices: 'Микрофон и звук',
            navAppearance: 'Чат и фон',
            navAi: 'ИИ в чатах',
            profileH: 'Профиль',
            profileCallout:
                'Аватар и баннер сохраняются в аккаунте. Отображаемое имя внизу слева — только в этом браузере.',
            photo: 'Фото профиля',
            pickFile: 'Выбрать файл…',
            photoHint: 'JPEG, PNG, GIF, WebP до 4 МБ',
            banner: 'Баннер (фон карточки профиля)',
            displayName: 'Как показывать имя внизу слева',
            bio: 'О себе (видят друзья в профиле)',
            bioPlaceholder: 'Коротко о себе…',
            avatarLetters: 'Или буквы в аватаре (до 4 символов)',
            privacyH: 'Приватность',
            privacyCallout:
                'Дополнительные ограничения для интерфейса. Основные правила чатов задаёт администратор сервера.',
            dmFriendsOnly: 'Писать в личку могут только друзья',
            groupInvitesFriends: 'Приглашения в группы только от друзей',
            hideOnline: 'Показывать статус «Невидимка»',
            notifH: 'Уведомления',
            desktopNotif: 'Уведомления рабочего стола',
            soundInApp: 'Звук в открытом чате',
            dndH: 'Не беспокоить',
            dndOn: 'Включить по расписанию',
            dndFrom: 'С',
            dndTo: 'до',
            securityH: 'Безопасность',
            securityCallout: 'Недавние входы в этом браузере (для вашего контроля).',
            qrSignInH: 'Вход с другого устройства по QR',
            qrSignInP:
                'Сканируйте QR, который показан на ПК, чтобы подтвердить вход там. На этом устройстве вы остаётесь в аккаунте — выходить не нужно.',
            qrSignInBtn: 'Сканировать QR-код',
            qrScanTitle: 'Подтвердить вход на другом устройстве',
            qrScanIntro: 'Наведите камеру на QR с экрана компьютера (тот же код, что на странице входа).',
            qrSignInConfirm: 'Выйти из аккаунта на этом устройстве и открыть страницу входа со сканером QR?',
            changePwd: 'Смена пароля',
            pwdChangeLead: 'Сначала введите текущий пароль, на следующем шаге — новый.',
            pwdChangeNext: 'Далее',
            pwdChangeBack: 'Назад',
            pwdChangeNeedCurrent: 'Введите текущий пароль.',
            pwdChangeNeedNew: 'Новый пароль — не менее 6 символов.',
            pwdChangeOk: 'Пароль обновлён.',
            currentPwd: 'Текущий пароль',
            newPwd: 'Новый пароль',
            changePwdBtn: 'Сменить пароль',
            interfaceH: 'Интерфейс',
            language: 'Язык интерфейса',
            languageHint: 'Текст и направление (например, для арабского) обновляются после «Сохранить».',
            interfaceCallout: 'Тема также доступна кнопкой внизу слева.',
            compact: 'Компактные сообщения',
            fontScale: 'Масштаб шрифта',
            sidebarWidth: 'Ширина боковой колонки',
            linksNewTab: 'Ссылки в чатах открывать в новой вкладке',
            hotkeysH: 'Горячие клавиши',
            hotkeySearch: '— фокус поиска в чате',
            hotkeyEsc: '— закрыть модальные окна',
            hotkeySearchHtml: '<kbd>Ctrl</kbd> + <kbd>K</kbd> — фокус поиска в чате',
            hotkeyEscHtml: '<kbd>Esc</kbd> — закрыть модальные окна',
            devicesH: 'Микрофон и наушники',
            mediaWarn:
                'Браузер не даёт микрофон и часть аудио по обычному http:// с IP (кроме localhost). Включите HTTPS (см. .env).',
            devicesCallout:
                'Выбор устройства применится при следующем подключении к звонку. Проверка микрофона — ниже.',
            mic: 'Микрофон',
            output: 'Вывод звука',
            refreshDevices: 'Обновить список устройств',
            micTest: 'Проверить микрофон',
            stop: 'Остановить',
            voiceGroupH: 'Голос в группе (только у вас)',
            voiceGroupHint:
                'Во время группового звонка в списке участников нажмите иконку настроек: громкость и «Не слышать у себя». Сохраняется в этом браузере.',
            resetVoicePrefs: 'Сбросить все настройки громкости участников',
            aiH: 'ИИ в чатах',
            aiCallout:
                'Краткий пересказ и правка текста перед отправкой. Запросы идут через ваш сервер — проверьте политику. Ключ в localStorage, если не в .env.',
            aiProvider: 'Провайдер',
            aiOff: 'Выключено',
            aiKey: 'API-ключ (необязательно, если на сервере)',
            aiModel: 'Модель (пусто = по умолчанию)',
            aiAssist: 'Панель «авто-редактор» у поля ввода (подсказки при наборе)',
            appearanceH: 'Оформление чата',
            appearanceCallout: 'Фон и размытие в области сообщений.',
            preset: 'Пресет фона',
            customUrl: 'Свой URL картинки (опционально)',
            blur: 'Размытие фона',
            saveBtn: 'Сохранить',
            legalPrivacy: 'Конфиденциальность',
            legalTerms: 'Условия',
            securityFooter:
                'Не передавайте пароли и платёжные данные в чатах. Для максимальной приватности — сквозное шифрование.',
            updatePwdOk: 'Пароль обновлён',
            saveProfileFail: 'Не удалось сохранить профиль на сервере; остальные настройки — локально.',
            uploadFail: 'Не удалось загрузить',
            avatarLen: 'Текстовый аватар — не более 4 символов (или загрузите фото).',
            openSettings: 'Открыть настройки'
        },
        profile: {
            screenTitle: 'Профиль',
            online: 'в сети',
            statusInvisible: 'Невидимка',
            account: 'Аккаунт',
            notifications: 'Уведомления',
            appearance: 'Оформление',
            myServers: 'Мои серверы',
            about: 'О приложении',
            edit: 'Редактировать'
        },
        confirm: {
            title: 'Подтверждение',
            logout: 'Выйти из аккаунта? Сессия на этом устройстве завершится.',
            logoutTitle: 'Выход',
            confirmBtn: 'Выйти',
            deleteBtn: 'Удалить'
        }
    };

    function deepMerge(base, over) {
        if (!over || typeof over !== 'object') return base;
        const out = Array.isArray(base) ? base.slice() : { ...base };
        for (const k of Object.keys(over)) {
            const vb = out[k];
            const vo = over[k];
            if (vo && typeof vo === 'object' && !Array.isArray(vo) && vb && typeof vb === 'object' && !Array.isArray(vb)) {
                out[k] = deepMerge(vb, vo);
            } else {
                out[k] = vo;
            }
        }
        return out;
    }

    const PATCH = {
        // Неполные словари дополняются из EN
        fr: { settings: { title: 'Paramètres', saveBtn: 'Enregistrer', cancel: 'Annuler' } },
        es: { settings: { title: 'Ajustes', saveBtn: 'Guardar' } },
        de: { settings: { title: 'Einstellungen' } },
        be: { settings: { title: 'Налады', saveBtn: 'Захаваць' } }
    };
    // Remove invalid key 'de' if not in FLOR_LOCALE_META - we don't have de in list, remove de from PATCH
    delete PATCH.de;

    const bundles = { en: EN, ru: deepMerge(EN, RU) };

    FLOR_LOCALE_META.forEach(({ code }) => {
        if (code === 'en' || code === 'ru') return;
        const extUk = typeof window !== 'undefined' && window.FLOR_I18N_UK;
        const extTt = typeof window !== 'undefined' && window.FLOR_I18N_TT;
        if (code === 'uk') {
            bundles[code] = extUk ? deepMerge(EN, deepMerge(RU, extUk)) : deepMerge(EN, RU);
            return;
        }
        if (code === 'tt') {
            bundles[code] = extTt ? deepMerge(EN, deepMerge(RU, extTt)) : deepMerge(EN, RU);
            return;
        }
        if (PATCH[code]) {
            bundles[code] = deepMerge(EN, PATCH[code]);
        } else {
            bundles[code] = EN;
        }
    });

    let currentLocale = 'en';
    let currentBundle = EN;

    function getPath(obj, path) {
        if (!obj || !path) return undefined;
        const parts = path.split('.');
        let x = obj;
        for (const p of parts) {
            if (x == null) return undefined;
            x = x[p];
        }
        return x;
    }

    function t(path) {
        let v = getPath(currentBundle, path);
        if (typeof v === 'string') return v;
        v = getPath(EN, path);
        return typeof v === 'string' ? v : path;
    }

    function applyDom(root) {
        const r = root || document;
        r.querySelectorAll('[data-i18n]').forEach((el) => {
            const k = el.getAttribute('data-i18n');
            if (!k) return;
            const s = t(k);
            if (el.hasAttribute('data-i18n-html')) {
                el.innerHTML = s;
            } else {
                el.textContent = s;
            }
        });
        r.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            const k = el.getAttribute('data-i18n-placeholder');
            if (k) el.setAttribute('placeholder', t(k));
        });
        r.querySelectorAll('[data-i18n-aria]').forEach((el) => {
            const k = el.getAttribute('data-i18n-aria');
            if (k) el.setAttribute('aria-label', t(k));
        });
        r.querySelectorAll('[data-i18n-title]').forEach((el) => {
            const k = el.getAttribute('data-i18n-title');
            if (k) el.setAttribute('title', t(k));
        });
    }

    function setDocumentDirAndLang() {
        const el = document.documentElement;
        el.setAttribute('lang', currentLocale);
        if (RTL_LOCALES.has(currentLocale)) {
            el.setAttribute('dir', 'rtl');
        } else {
            el.removeAttribute('dir');
        }
    }

    function setLocale(code) {
        const c = florNormalizeLocaleCode(code);
        currentLocale = c;
        currentBundle = bundles[c] || EN;
        setDocumentDirAndLang();
        try {
            document.title = t('meta.appTitle');
        } catch (_) {}
    }

    function initFromSettings() {
        const c = florDetectInitialLocale();
        setLocale(c);
        applyDom(document);
    }

    function persistLocaleToSettings(code) {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : {};
            s.locale = florNormalizeLocaleCode(code);
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch (_) {}
    }

    function bootEarly() {
        try {
            const c = florDetectInitialLocale();
            currentLocale = florNormalizeLocaleCode(c);
            currentBundle = bundles[currentLocale] || EN;
            setDocumentDirAndLang();
        } catch (_) {}
    }

    global.florI18n = {
        t,
        applyDom,
        setLocale,
        getLocale: () => currentLocale,
        init: initFromSettings,
        bootEarly,
        persistLocale: persistLocaleToSettings,
        normalizeLocale: florNormalizeLocaleCode,
        FLOR_LOCALE_META,
        RTL_LOCALES
    };
})(typeof window !== 'undefined' ? window : this);
