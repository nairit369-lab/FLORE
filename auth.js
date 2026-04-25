let isLoginMode = true;
let qrPollTimer = null;
let waitingTwoFactor = false;
let qrScanStream = null;
let qrScanTimer = null;
let qrScanCanvas = null;

function florOrigin() {
    try {
        const p = window.location.protocol;
        if (p === 'http:' || p === 'https:') {
            return window.location.origin.replace(/\/$/, '');
        }
    } catch (_) {}
    try {
        const s = localStorage.getItem('florServerBase');
        if (s && /^https?:\/\//i.test(String(s).trim())) {
            return String(s).trim().replace(/\/$/, '');
        }
    } catch (_) {}
    return 'http://127.0.0.1:3000';
}

function florApi(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${florOrigin()}${p}`;
}

function florNormalizeStoredToken(raw) {
    if (raw == null) return null;
    let t = String(raw).trim();
    if (!t) return null;
    if (/^bearer\s+/i.test(t)) {
        t = t.replace(/^bearer\s+/i, '').trim();
    }
    return t || null;
}

function florInviteCodeFromUrl() {
    try {
        const u = new URL(window.location.href);
        return (u.searchParams.get('invite') || '').trim();
    } catch (_) {
        return '';
    }
}

function florNavigateToApp() {
    const invite = florInviteCodeFromUrl();
    const next = invite ? `index.html?invite=${encodeURIComponent(invite)}` : 'index.html';
    window.location.href = next;
}

const REMEMBER_KEY = 'florRememberEmail';
const SAVED_EMAIL_KEY = 'florSavedEmail';
const SAVED_USERNAME_KEY = 'florSavedUsername';

document.addEventListener('DOMContentLoaded', () => {
    initializeAuth();
});

function loadSavedLoginFields() {
    const rememberCb = document.getElementById('rememberEmail');
    const emailInput = document.getElementById('email');
    const usernameInput = document.getElementById('username');
    const remember = localStorage.getItem(REMEMBER_KEY) === '1';
    const savedEmail = localStorage.getItem(SAVED_EMAIL_KEY) || '';
    const savedUsername = localStorage.getItem(SAVED_USERNAME_KEY) || '';

    if (rememberCb) rememberCb.checked = remember;
    if (remember && savedEmail && emailInput) emailInput.value = savedEmail;
    if (savedUsername && usernameInput) usernameInput.value = savedUsername;
}

function persistLoginPreferences(email, usernameForRegister) {
    const rememberCb = document.getElementById('rememberEmail');
    const remember = rememberCb && rememberCb.checked;
    if (remember) {
        localStorage.setItem(REMEMBER_KEY, '1');
        if (email) localStorage.setItem(SAVED_EMAIL_KEY, email.trim());
        if (usernameForRegister) localStorage.setItem(SAVED_USERNAME_KEY, usernameForRegister.trim());
    } else {
        localStorage.setItem(REMEMBER_KEY, '0');
        localStorage.removeItem(SAVED_EMAIL_KEY);
    }
}

const FLOR_API_ERR_KEYS = {
    'Invalid credentials': 'authApi.invalidCredentials',
    'Email and password required': 'authApi.emailPasswordRequired',
    'Login failed': 'authApi.loginFailed',
    'Registration failed': 'authApi.registrationFailed',
    'All fields required': 'authApi.allFieldsRequired',
    'Email already registered': 'authApi.emailRegistered',
    'Password must be at least 6 characters': 'authApi.passwordShort',
    'Email verification code required': 'authApi.emailCodeRequired',
    'Invalid email verification code': 'authApi.invalidEmailCode',
    'Email verification code expired': 'authApi.emailCodeExpired',
    'Invalid email format': 'authApi.invalidEmailFormat',
    'Please wait before requesting another email code': 'authApi.waitBeforeEmailCode',
    'Email transport is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env':
        'authApi.smtpNotConfigured',
    'Failed to send verification code': 'authApi.sendCodeFailed',
    'QR session expired': 'authApi.qrSessionExpired',
    'Failed to create QR session': 'authApi.qrCreateFailed',
    'QR approve failed': 'authApi.qrApproveFailed',
    'Failed to enable email alerts': 'authApi.emailAlertsFailed',
    'Two-factor code required': 'authApi.twoFactorRequired'
};

/**
 * i18n.applyDom перезаписывает все [data-i18n]. Заголовок/кнопка входа — без data-i18n,
 * но applyDom оставляет рассинхрон при смене языка / init. Синхронизируем режим сразу после applyDom.
 */
function florInstallAuthI18nApplyDomSync() {
    if (!window.florI18n || window.florI18n._florAuthApplyDomWrapped) return;
    const orig = window.florI18n.applyDom;
    window.florI18n.applyDom = function (root) {
        orig.call(window.florI18n, root);
        if (document.getElementById('authForm')) {
            try {
                applyAuthModeUI();
            } catch (e) {
                console.error('applyAuthModeUI after i18n.applyDom', e);
            }
        }
    };
    window.florI18n._florAuthApplyDomWrapped = true;
}

function mapApiError(msg) {
    if (!msg || typeof msg !== 'string') return msg;
    const p = FLOR_API_ERR_KEYS[msg];
    if (p && window.florI18n && window.florI18n.t) {
        return window.florI18n.t(p);
    }
    return msg;
}

function florSetupAuthLocaleSelect() {
    const sel = document.getElementById('florAuthLocale');
    if (!sel || !window.florI18n) return;
    if (!sel.dataset.florPopulated) {
        sel.innerHTML = '';
        const meta = window.florI18n.FLOR_LOCALE_META;
        for (let i = 0; i < meta.length; i++) {
            const o = document.createElement('option');
            o.value = meta[i].code;
            o.textContent = meta[i].label;
            sel.appendChild(o);
        }
        sel.dataset.florPopulated = '1';
    }
    try {
        sel.value = window.florI18n.getLocale();
    } catch (_) {}
    if (!sel.dataset.florListener) {
        sel.addEventListener('change', () => {
            const v = sel.value;
            window.florI18n.setLocale(v);
            window.florI18n.persistLocale(v);
            window.florI18n.applyDom(document);
            const qimg = document.getElementById('qrLoginImage');
            if (qimg) {
                qimg.setAttribute('alt', window.florI18n.t('auth.qrAlt'));
            }
        });
        sel.dataset.florListener = '1';
    }
}

function initializeAuth() {
    const authForm = document.getElementById('authForm');
    const switchLink = document.getElementById('switchLink');
    const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
    const sendEmailCodeBtn = document.getElementById('sendEmailCodeBtn');
    const qrLoginBtn = document.getElementById('qrLoginBtn');
    const qrApproveBtn = document.getElementById('qrApproveBtn');

    if (window.florI18n) {
        florInstallAuthI18nApplyDomSync();
        window.florI18n.init();
        florSetupAuthLocaleSelect();
        const qimg = document.getElementById('qrLoginImage');
        if (qimg) {
            qimg.setAttribute('alt', window.florI18n.t('auth.qrAlt'));
        }
    } else {
        applyAuthModeUI();
    }

    loadSavedLoginFields();

    const rawTok = localStorage.getItem('token');
    let token = florNormalizeStoredToken(rawTok);
    if (token !== rawTok) {
        try {
            if (token) localStorage.setItem('token', token);
            else localStorage.removeItem('token');
        } catch (_) {}
    }
    const currentUser = localStorage.getItem('currentUser');
    const sessionFromUrl = getQrSessionFromUrl();

    if (token && currentUser) {
        try {
            JSON.parse(currentUser);
            if (!sessionFromUrl) {
                setTimeout(() => {
                    const invite = florInviteCodeFromUrl();
                    window.location.replace(invite ? `index.html?invite=${encodeURIComponent(invite)}` : 'index.html');
                }, 100);
                return;
            }
        } catch (e) {
            localStorage.removeItem('token');
            localStorage.removeItem('currentUser');
        }
    }

    authForm.addEventListener('submit', handleSubmit);
    switchLink.addEventListener('click', toggleMode);
    forgotPasswordBtn?.addEventListener('click', handleForgotPassword);
    const changePwdModal = document.getElementById('changePasswordModal');
    document.getElementById('changePasswordModalBackdrop')?.addEventListener('click', closeChangePasswordModal);
    document.getElementById('changePasswordModalClose')?.addEventListener('click', closeChangePasswordModal);
    document.getElementById('changePwdSubmit')?.addEventListener('click', handleChangePasswordPrelogin);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('changePasswordModal');
            if (modal && !modal.hidden) {
                e.preventDefault();
                closeChangePasswordModal();
            }
        }
    });
    sendEmailCodeBtn?.addEventListener('click', handleSendEmailCode);
    qrLoginBtn?.addEventListener('click', startQrLoginFlow);
    qrApproveBtn?.addEventListener('click', approveQrFromPhone);
    document.getElementById('qrScanCameraBtn')?.addEventListener('click', startQrScanCamera);
    document.getElementById('authQrScanClose')?.addEventListener('click', stopQrScanCamera);
    window.addEventListener('resize', florUpdateAuthQrScanVisibility, { passive: true });

    handleQrQueryOnLoad();
    florMaybeStartQrScanFromSettingsHash();

    window.florRegisterEmailCodeRequired = false;
    fetch(florApi('/api/config'))
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
            if (cfg && typeof cfg.requireRegisterEmailCode === 'boolean') {
                window.florRegisterEmailCodeRequired = cfg.requireRegisterEmailCode;
            }
        })
        .catch(() => {
            window.florRegisterEmailCodeRequired = false;
        })
        .finally(() => {
            applyAuthModeUI();
        });
}

function toggleMode(e) {
    e.preventDefault();

    isLoginMode = !isLoginMode;
    applyAuthModeUI();
    removeMessage('error-message');
    removeMessage('success-message');
}

function setQrLayoutVisible(visible) {
    const container = document.querySelector('.auth-container');
    if (!container) return;
    container.classList.toggle('auth-container--with-qr', !!visible);
}

function florRegisterEmailCodeRequired() {
    return !!window.florRegisterEmailCodeRequired;
}

function applyAuthModeUI() {

    const authBox = document.querySelector('.auth-box');
    const usernameGroup = document.getElementById('usernameGroup');
    const confirmPasswordGroup = document.getElementById('confirmPasswordGroup');
    const submitBtn = document.getElementById('submitBtn');
    const switchText = document.getElementById('switchText');
    const switchLink = document.getElementById('switchLink');
    const rememberRow = document.getElementById('rememberRow');
    const termsConsentRow = document.getElementById('termsConsentRow');
    const termsConsent = document.getElementById('termsConsent');
    const forgotPasswordRow = document.getElementById('forgotPasswordRow');
    const emailCodeGroup = document.getElementById('emailCodeGroup');
    const sendCodeRow = document.getElementById('sendCodeRow');
    const loginTwoFactorGroup = document.getElementById('loginTwoFactorGroup');
    const loginTwoFactorCode = document.getElementById('loginTwoFactorCode');
    const qrLoginBtn = document.getElementById('qrLoginBtn');
    const qrLoginPanel = document.getElementById('qrLoginPanel');
    const qrApprovePanel = document.getElementById('qrApprovePanel');
    const modeTitle = document.getElementById('authModeTitle');
    const modeLead = document.getElementById('authModeLead');

    if (isLoginMode) {
        if (authBox) authBox.classList.remove('auth-box--register');
        if (usernameGroup) usernameGroup.style.display = 'none';
        if (confirmPasswordGroup) confirmPasswordGroup.style.display = 'none';
        if (emailCodeGroup) emailCodeGroup.style.display = 'none';
        if (sendCodeRow) sendCodeRow.style.display = 'none';
        if (loginTwoFactorGroup) {
            loginTwoFactorGroup.style.display = waitingTwoFactor ? 'block' : 'none';
        }
        if (rememberRow) rememberRow.style.display = 'block';
        if (termsConsentRow) termsConsentRow.style.display = 'none';
        if (termsConsent) termsConsent.checked = false;
        if (forgotPasswordRow) forgotPasswordRow.style.display = 'flex';
        if (qrLoginBtn) qrLoginBtn.style.display = 'block';
        if (submitBtn) {
            submitBtn.textContent = window.florI18n ? window.florI18n.t('auth.submitLogin') : 'Sign in';
        }
        if (switchText) {
            switchText.textContent = window.florI18n ? window.florI18n.t('auth.noAccount') : 'No account?';
        }
        if (switchLink) {
            switchLink.textContent = window.florI18n ? window.florI18n.t('auth.linkRegister') : 'Register';
        }
        if (modeTitle) {
            modeTitle.textContent = window.florI18n
                ? window.florI18n.t('auth.titleWelcome')
                : 'Welcome back';
        }
        if (modeLead) modeLead.textContent = '';
        if (window.florI18n) {
            document.title =
                'FLOR MESSENGER — ' + window.florI18n.t('auth.pageTitle');
        }
    } else {
        if (authBox) authBox.classList.add('auth-box--register');
        if (usernameGroup) usernameGroup.style.display = 'block';
        if (confirmPasswordGroup) confirmPasswordGroup.style.display = 'block';
        const needRegCode = florRegisterEmailCodeRequired();
        if (emailCodeGroup) emailCodeGroup.style.display = needRegCode ? 'block' : 'none';
        if (sendCodeRow) sendCodeRow.style.display = needRegCode ? 'flex' : 'none';
        if (loginTwoFactorGroup) loginTwoFactorGroup.style.display = 'none';
        waitingTwoFactor = false;
        if (loginTwoFactorCode) loginTwoFactorCode.value = '';
        if (rememberRow) rememberRow.style.display = 'block';
        if (termsConsentRow) termsConsentRow.style.display = 'block';
        if (forgotPasswordRow) forgotPasswordRow.style.display = 'none';
        closeChangePasswordModal();
        if (qrLoginBtn) qrLoginBtn.style.display = 'none';
        if (qrLoginPanel) qrLoginPanel.hidden = true;
        if (qrApprovePanel) qrApprovePanel.hidden = true;
        setQrLayoutVisible(false);
        stopQrPolling();
        if (submitBtn) {
            submitBtn.textContent = window.florI18n ? window.florI18n.t('auth.submitRegister') : 'Create account';
        }
        if (switchText) {
            switchText.textContent = window.florI18n ? window.florI18n.t('auth.haveAccount') : 'Have an account?';
        }
        if (switchLink) {
            switchLink.textContent = window.florI18n ? window.florI18n.t('auth.linkLogin') : 'Sign in';
        }
        if (modeTitle) {
            modeTitle.textContent = window.florI18n
                ? window.florI18n.t('auth.titleRegister')
                : 'Create account';
        }
        if (modeLead) {
            modeLead.textContent = window.florI18n
                ? window.florI18n.t('auth.leadRegister')
                : '';
        }
        if (window.florI18n) {
            document.title =
                'FLOR MESSENGER — ' + window.florI18n.t('auth.pageTitleReg');
        }
        const scanBlock = document.getElementById('authQrScanBlock');
        if (scanBlock) scanBlock.hidden = true;
        stopQrScanCamera();
    }
    if (isLoginMode) {
        florUpdateAuthQrScanVisibility();
    }
}

function openChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (!modal) return;
    removeMessage('error-message');
    removeMessage('success-message');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('changePwdCurrent')?.focus();
    try {
        document.body.style.overflow = 'hidden';
    } catch (_) {}
    if (window.florI18n) {
        try {
            window.florI18n.applyDom(modal);
        } catch (_) {}
    }
}

function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.getElementById('changePwdCurrent') && (document.getElementById('changePwdCurrent').value = '');
    document.getElementById('changePwdNew') && (document.getElementById('changePwdNew').value = '');
    document.getElementById('changePwdConfirm') && (document.getElementById('changePwdConfirm').value = '');
    try {
        document.body.style.overflow = '';
    } catch (_) {}
}

function handleForgotPassword() {
    if (!isLoginMode) {
        return;
    }
    openChangePasswordModal();
}

function handleChangePasswordPrelogin() {
    const email = (document.getElementById('email') && document.getElementById('email').value) || '';
    const current = (document.getElementById('changePwdCurrent') && document.getElementById('changePwdCurrent').value) || '';
    const newPass = (document.getElementById('changePwdNew') && document.getElementById('changePwdNew').value) || '';
    const confirm = (document.getElementById('changePwdConfirm') && document.getElementById('changePwdConfirm').value) || '';
    const emailTrim = String(email).trim();
    if (!emailTrim) {
        showError(window.florI18n ? window.florI18n.t('authClient.changePwdEmailFirst') : 'Enter your email in the form above first.');
        return;
    }
    if (!current || !newPass || !confirm) {
        showError(window.florI18n ? window.florI18n.t('authClient.changePwdAllFields') : 'Fill in all fields.');
        return;
    }
    if (newPass.length < 6) {
        showError(window.florI18n ? window.florI18n.t('authClient.passwordMin') : 'Password at least 6 characters');
        return;
    }
    if (newPass !== confirm) {
        showError(window.florI18n ? window.florI18n.t('authClient.passwordMismatch') : 'Passwords do not match');
        return;
    }
    removeMessage('error-message');
    removeMessage('success-message');
    const btn = document.getElementById('changePwdSubmit');
    if (btn) {
        btn.disabled = true;
    }
    fetch(florApi('/api/auth/change-password-prelogin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: emailTrim,
            currentPassword: current,
            newPassword: newPass
        })
    })
        .then(async (r) => {
            let j = {};
            try {
                j = await r.json();
            } catch (_) {}
            return { ok: r.ok, j };
        })
        .then(({ ok, j }) => {
            if (ok) {
                closeChangePasswordModal();
                showSuccess(
                    window.florI18n ? window.florI18n.t('authClient.changePwdSuccess') : 'Password updated. You can sign in with the new password.'
                );
                const pw = document.getElementById('password');
                if (pw) pw.value = newPass;
            } else {
                const err = (j && j.error) || '';
                if (err === 'Invalid credentials') {
                    showError(window.florI18n ? window.florI18n.t('authApi.invalidCredentials') : 'Invalid email or password');
                } else if (err && err.indexOf('at least 6') !== -1) {
                    showError(window.florI18n ? window.florI18n.t('authClient.passwordMin') : 'Password at least 6 characters');
                } else if (err && err.indexOf('required') !== -1) {
                    showError(window.florI18n ? window.florI18n.t('authClient.changePwdAllFields') : 'Fill in all fields');
                } else {
                    showError(
                        window.florI18n ? window.florI18n.t('authClient.changePwdFail') : 'Could not change password. Try again.'
                    );
                }
            }
        })
        .catch(() => {
            showError(
                window.florI18n ? window.florI18n.t('authClient.networkError') : 'Network error. Try again.'
            );
        })
        .finally(() => {
            if (btn) btn.disabled = false;
        });
}

function getQrSessionFromUrl() {
    try {
        const u = new URL(window.location.href);
        return (u.searchParams.get('qrSession') || '').trim();
    } catch (_) {
        return '';
    }
}

function florAuthScanShouldShow() {
    try {
        const h = (window.location.hash || '').toLowerCase();
        if (h === '#qrscan') return true;
    } catch (_) {}
    try {
        return window.matchMedia('(max-width: 720px)').matches;
    } catch (_) {
        return typeof window !== 'undefined' && window.innerWidth <= 720;
    }
}

function florMaybeStartQrScanFromSettingsHash() {
    const h = (location.hash || '').toLowerCase();
    if (h !== '#qrscan') return;
    if (typeof isLoginMode !== 'undefined' && !isLoginMode) return;
    const block = document.getElementById('authQrScanBlock');
    if (block) block.hidden = false;
    florUpdateAuthQrScanVisibility();
    setTimeout(() => {
        startQrScanCamera();
    }, 350);
}

function florUpdateAuthQrScanVisibility() {
    const block = document.getElementById('authQrScanBlock');
    if (!block) return;
    if (!isLoginMode) {
        block.hidden = true;
        return;
    }
    block.hidden = !florAuthScanShouldShow();
}

function parseSessionFromScannedString(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m = /[?&]qrSession=([^&#'"]+)/.exec(s);
    if (m) {
        return decodeURIComponent(m[1]).trim();
    }
    try {
        const u = new URL(s, window.location.origin);
        return (u.searchParams.get('qrSession') || '').trim();
    } catch (_) {
        return '';
    }
}

function setQrLoginPanelWaitingVisual(on) {
    const img = document.getElementById('qrLoginImage');
    const wait = document.getElementById('qrLoginWait');
    if (img) img.hidden = !!on;
    if (wait) wait.hidden = !on;
}

function enterQrLoginWaitingState(sessionId, cleanUrl) {
    if (!sessionId) return;
    stopQrScanCamera();
    if (cleanUrl) {
        try {
            const u = new URL(window.location.href);
            u.searchParams.delete('qrSession');
            const q = u.searchParams.toString();
            history.replaceState({}, '', u.pathname + (q ? '?' + q : '') + u.hash);
        } catch (_) {}
    }
    const title = document.getElementById('qrLoginTitle');
    if (title && window.florI18n) {
        title.textContent = window.florI18n.t('auth.qrWaitOtherDevice');
    }
    const panel = document.getElementById('qrLoginPanel');
    if (panel) panel.hidden = false;
    setQrLoginPanelWaitingVisual(true);
    const approve = document.getElementById('qrApprovePanel');
    if (approve) approve.hidden = true;
    const scanBlock = document.getElementById('authQrScanBlock');
    if (scanBlock) scanBlock.hidden = true;
    setQrLayoutVisible(true);
    const hint = document.getElementById('qrLoginHint');
    if (hint && window.florI18n) {
        hint.textContent = window.florI18n.t('auth.qrWait');
    }
    beginQrPolling(String(sessionId).trim());
}

/** iOS Safari: несколько вариантов constraints; среда, затем любая камера */
async function florGetAuthQrVideoStream() {
    const fallbacks = [
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        { video: { facingMode: 'environment' }, audio: false },
        { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: true, audio: false }
    ];
    let lastErr = null;
    for (const c of fallbacks) {
        try {
            return await navigator.mediaDevices.getUserMedia(c);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('getUserMedia failed');
}

/** Полный кадр, затем центральный crop — так проще поймать QR с экрана ПК */
function florJsQrDecodeFrame(ctx, video) {
    if (!window.jsQR || !ctx || !video) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w <= 8 || h <= 8) return null;
    const opt = { inversionAttempts: 'attemptBoth' };
    if (!qrScanCanvas) return null;
    qrScanCanvas.width = w;
    qrScanCanvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    let d = ctx.getImageData(0, 0, w, h);
    let res = window.jsQR(d.data, w, h, opt);
    if (res && res.data) return res;
    const s = 0.7;
    const cw = Math.max(64, Math.floor(w * s));
    const ch = Math.max(64, Math.floor(h * s));
    const sx = Math.floor((w - cw) / 2);
    const sy = Math.floor((h - ch) / 2);
    qrScanCanvas.width = cw;
    qrScanCanvas.height = ch;
    ctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
    d = ctx.getImageData(0, 0, cw, ch);
    res = window.jsQR(d.data, cw, ch, opt);
    return res && res.data ? res : null;
}

function stopQrScanCamera() {
    if (qrScanTimer) {
        clearInterval(qrScanTimer);
        qrScanTimer = null;
    }
    if (qrScanStream) {
        try {
            qrScanStream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        qrScanStream = null;
    }
    const v = document.getElementById('authQrVideo');
    if (v) {
        v.srcObject = null;
    }
    const p = document.getElementById('authQrScanPanel');
    if (p) p.hidden = true;
    qrScanCanvas = null;
}

function handleQrDataFromScan(raw) {
    const sid = parseSessionFromScannedString(raw);
    if (sid) {
        stopQrScanCamera();
        enterQrLoginWaitingState(sid, true);
        return;
    }
    const hint = document.getElementById('authQrScanHint');
    if (hint && window.florI18n) {
        hint.textContent = window.florI18n.t('authClient.qrInvalidQr');
    }
}

function startQrScanCamera() {
    if (!florAuthScanShouldShow()) return;
    if (!('BarcodeDetector' in window) && typeof window.jsQR === 'undefined') {
        showError(
            window.florI18n
                ? window.florI18n.t('authClient.qrScanUnsupported')
                : 'QR library not available'
        );
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError(
            window.florI18n
                ? window.florI18n.t('authClient.qrNoCamera')
                : 'Camera not available'
        );
        return;
    }
    const panel = document.getElementById('authQrScanPanel');
    const v = document.getElementById('authQrVideo');
    const hint = document.getElementById('authQrScanHint');
    if (!v || !panel) return;
    stopQrScanCamera();
    if (hint && window.florI18n) {
        hint.textContent = window.florI18n.t('auth.qrScanning');
    }
    panel.hidden = false;
    (async () => {
        let detector = null;
        try {
            if (window.BarcodeDetector) {
                detector = new BarcodeDetector({ formats: ['qr_code'] });
            }
        } catch (_) {
            detector = null;
        }
        try {
            qrScanStream = await florGetAuthQrVideoStream();
        } catch (e) {
            console.error('getUserMedia', e);
            showError(
                window.florI18n
                    ? window.florI18n.t('authClient.qrNoCamera')
                    : 'Camera permission denied or unavailable'
            );
            panel.hidden = true;
            return;
        }
        v.setAttribute('playsinline', 'true');
        v.setAttribute('webkit-playsinline', 'true');
        v.playsInline = true;
        v.muted = true;
        v.srcObject = qrScanStream;
        v.play().catch(() => {});
        if (!qrScanCanvas) {
            qrScanCanvas = document.createElement('canvas');
        }
        const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
            if (!qrScanStream) return;
            if (v.readyState < 2) return;
            try {
                if (detector) {
                    const codes = await detector.detect(v);
                    for (const c of codes) {
                        const r = c.rawValue || c.displayValue;
                        if (r) {
                            handleQrDataFromScan(r);
                            return;
                        }
                    }
                } else if (window.jsQR && ctx) {
                    const res = florJsQrDecodeFrame(ctx, v);
                    if (res && res.data) {
                        handleQrDataFromScan(res.data);
                        return;
                    }
                }
            } catch (err) {
                if (err && err.name === 'NotSupportedError' && hint && window.florI18n) {
                    hint.textContent = window.florI18n.t('authClient.qrInvalidQr');
                }
            }
        };
        qrScanTimer = setInterval(tick, 220);
    })();
}

function handleQrQueryOnLoad() {
    const sessionFromUrl = getQrSessionFromUrl();
    if (!sessionFromUrl) {
        return;
    }
    const t = florNormalizeStoredToken(localStorage.getItem('token'));
    if (t && localStorage.getItem('currentUser')) {
        const form = document.getElementById('authForm');
        if (form) form.style.display = 'none';
        const block = document.getElementById('authQrScanBlock');
        if (block) block.hidden = true;
        const qbtn = document.getElementById('qrLoginBtn');
        if (qbtn) qbtn.style.display = 'none';
        const leg = document.querySelector('.auth-legal');
        if (leg) leg.style.display = 'none';
        const panel = document.getElementById('qrApprovePanel');
        if (panel) {
            panel.hidden = false;
        }
        setQrLayoutVisible(true);
        return;
    }
    enterQrLoginWaitingState(sessionFromUrl, true);
}

async function handleSubmit(e) {
    e.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const username = document.getElementById('username').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const emailCode = document.getElementById('emailCode').value;
    const termsAccepted = !!document.getElementById('termsConsent')?.checked;
    const twoFactorCode = document.getElementById('loginTwoFactorCode')?.value || '';

    if (!isLoginMode) {
        if (!username || username.trim().length < 3) {
            showError(window.florI18n ? window.florI18n.t('authClient.usernameMin') : 'Invalid username');
            return;
        }

        if (password !== confirmPassword) {
            showError(window.florI18n ? window.florI18n.t('authClient.passwordMismatch') : 'Password mismatch');
            return;
        }
        if (!termsAccepted) {
            showError(window.florI18n ? window.florI18n.t('authClient.termsRequired') : 'Accept terms to register');
            return;
        }
    }

    if (!email || !validateEmail(email)) {
        showError(window.florI18n ? window.florI18n.t('authClient.emailInvalid') : 'Invalid email');
        return;
    }

    if (!password || password.length < 6) {
        showError(window.florI18n ? window.florI18n.t('authClient.passwordMin') : 'Password too short');
        return;
    }

    if (isLoginMode) {
        await login(email, password, twoFactorCode);
    } else {
        const codeTrim = (emailCode || '').trim();
        if (florRegisterEmailCodeRequired() && !/^\d{6}$/.test(codeTrim)) {
            showError(window.florI18n ? window.florI18n.t('authClient.codeSix') : 'Enter 6-digit code');
            return;
        }
        await register(username, email, password, codeTrim);
    }
}

async function login(email, password, twoFactorCode) {
    try {
        const response = await fetch(florApi('/api/login'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password, twoFactorCode })
        });

        const data = await response.json();

        if (!response.ok) {
            if (data && data.code === 'TWO_FACTOR_REQUIRED') {
                waitingTwoFactor = true;
                const group = document.getElementById('loginTwoFactorGroup');
                const input = document.getElementById('loginTwoFactorCode');
                if (group) group.style.display = 'block';
                if (input) input.focus();
            }
            showError(
                mapApiError(data.error) ||
                    (window.florI18n ? window.florI18n.t('authClient.loginFail') : 'Login failed')
            );
            return;
        }
        waitingTwoFactor = false;
        const group = document.getElementById('loginTwoFactorGroup');
        const input = document.getElementById('loginTwoFactorCode');
        if (group) group.style.display = 'none';
        if (input) input.value = '';

        persistLoginPreferences(email, null);

        try {
            const key = 'florLoginHistory';
            const hist = JSON.parse(localStorage.getItem(key) || '[]');
            hist.unshift({ t: Date.now(), email: email.trim() });
            localStorage.setItem(key, JSON.stringify(hist.slice(0, 25)));
        } catch (e) {
            /* ignore */
        }

        const tok = florNormalizeStoredToken(data.token);
        if (!tok) {
            showError(window.florI18n ? window.florI18n.t('authClient.noToken') : 'No token');
            return;
        }
        localStorage.setItem('token', tok);
        localStorage.setItem('currentUser', JSON.stringify(data.user));

        showSuccess(window.florI18n ? window.florI18n.t('authClient.loginOk') : 'OK');

        setTimeout(() => {
            florNavigateToApp();
        }, 800);
    } catch (error) {
        console.error('Login error:', error);
        showError(
            window.florI18n ? window.florI18n.t('authClient.networkError') : 'Network error'
        );
    }
}

async function register(username, email, password, emailCode) {
    try {
        const response = await fetch(florApi('/api/register'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, password, emailCode })
        });

        const data = await response.json();

        if (!response.ok) {
            showError(
                mapApiError(data.error) ||
                    (window.florI18n ? window.florI18n.t('authClient.registerFail') : 'Register failed')
            );
            return;
        }

        persistLoginPreferences(email, username);

        try {
            const key = 'florLoginHistory';
            const hist = JSON.parse(localStorage.getItem(key) || '[]');
            hist.unshift({ t: Date.now(), email: email.trim() });
            localStorage.setItem(key, JSON.stringify(hist.slice(0, 25)));
        } catch (e) {
            /* ignore */
        }

        const tok = florNormalizeStoredToken(data.token);
        if (!tok) {
            showError(window.florI18n ? window.florI18n.t('authClient.noToken') : 'No token');
            return;
        }
        localStorage.setItem('token', tok);
        localStorage.setItem('currentUser', JSON.stringify(data.user));

        showSuccess(window.florI18n ? window.florI18n.t('authClient.accountOk') : 'OK');

        setTimeout(() => {
            florNavigateToApp();
        }, 800);
    } catch (error) {
        console.error('Registration error:', error);
        showError(
            window.florI18n ? window.florI18n.t('authClient.networkError') : 'Network error'
        );
    }
}

async function handleSendEmailCode() {
    const email = (document.getElementById('email')?.value || '').trim();
    if (!email || !validateEmail(email)) {
        showError(window.florI18n ? window.florI18n.t('authClient.enterEmailFirst') : 'Enter email first');
        return;
    }
    try {
        const btn = document.getElementById('sendEmailCodeBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = window.florI18n
                ? window.florI18n.t('authClient.sendingCode')
                : 'Sending…';
        }
        const response = await fetch(florApi('/api/auth/send-email-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, purpose: 'register' })
        });
        const data = await response.json();
        if (!response.ok) {
            showError(
                mapApiError(data.error) ||
                    (window.florI18n ? window.florI18n.t('authClient.sendCodeFail') : 'Failed')
            );
            return;
        }
        showSuccess(
            window.florI18n ? window.florI18n.t('authClient.codeSent') : 'Code sent'
        );
    } catch (error) {
        console.error('Send email code error:', error);
        showError(
            window.florI18n ? window.florI18n.t('authClient.codeSendNetwork') : 'Network error'
        );
    } finally {
        const btn = document.getElementById('sendEmailCodeBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = window.florI18n ? window.florI18n.t('auth.sendCode') : 'Send';
        }
    }
}

async function startQrLoginFlow() {
    try {
        stopQrScanCamera();
        const title = document.getElementById('qrLoginTitle');
        if (title && window.florI18n) {
            title.textContent = window.florI18n.t('auth.qrScanTitle');
        }
        setQrLoginPanelWaitingVisual(false);
        const panel = document.getElementById('qrLoginPanel');
        const img = document.getElementById('qrLoginImage');
        const hint = document.getElementById('qrLoginHint');
        if (!panel || !img || !hint) return;
        panel.hidden = false;
        setQrLayoutVisible(true);
        hint.textContent = window.florI18n
            ? window.florI18n.t('authClient.qrCreating')
            : '…';
        const r = await fetch(florApi('/api/auth/qr/start'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await r.json();
        if (!r.ok) {
            showError(
                mapApiError(data.error) ||
                    (window.florI18n ? window.florI18n.t('authClient.qrStartFail') : 'Failed')
            );
            return;
        }
        const qrData = String(data.qrData || '').trim();
        img.src = data.qrImage
            ? String(data.qrImage)
            : `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrData)}`;
        hint.textContent = window.florI18n
            ? window.florI18n.t('authClient.qrScanConfirm')
            : '';
        beginQrPolling(String(data.sessionId || '').trim());
        florUpdateAuthQrScanVisibility();
    } catch (e) {
        console.error('startQrLoginFlow:', e);
        showError(
            window.florI18n ? window.florI18n.t('authClient.qrStartFail') : 'Failed'
        );
    }
}

function stopQrPolling() {
    if (qrPollTimer) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
    }
}

function beginQrPolling(sessionId) {
    stopQrPolling();
    if (!sessionId) return;
    const hint = document.getElementById('qrLoginHint');
    qrPollTimer = setInterval(async () => {
        try {
            const r = await fetch(florApi(`/api/auth/qr/poll/${encodeURIComponent(sessionId)}`));
            const data = await r.json();
            if (!r.ok) {
                stopQrPolling();
                if (hint) hint.textContent = mapApiError(data.error) || 'QR-код устарел';
                return;
            }
            if (data.status !== 'approved') return;
            stopQrPolling();
            const tok = florNormalizeStoredToken(data.token);
            if (!tok || !data.user) {
                showError(
                    window.florI18n ? window.florI18n.t('authClient.qrFinishFail') : 'Failed'
                );
                return;
            }
            localStorage.setItem('token', tok);
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            if (hint) {
                hint.textContent = window.florI18n
                    ? window.florI18n.t('authClient.qrSignInProgress')
                    : 'OK';
            }
            setTimeout(() => {
                florNavigateToApp();
            }, 600);
        } catch (_) {}
    }, 2000);
}

async function approveQrFromPhone() {
    const qrSession = getQrSessionFromUrl();
    if (!qrSession) {
        showError(
            window.florI18n ? window.florI18n.t('authClient.qrSessionNotFound') : 'Not found'
        );
        return;
    }
    const token = florNormalizeStoredToken(localStorage.getItem('token'));
    if (!token) {
        showError(window.florI18n ? window.florI18n.t('authClient.qrNeedPhone') : 'Sign in first');
        return;
    }
    try {
        const r = await fetch(florApi('/api/auth/qr/approve'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ sessionId: qrSession })
        });
        const data = await r.json();
        if (!r.ok) {
            showError(
                mapApiError(data.error) ||
                    (window.florI18n ? window.florI18n.t('authClient.qrApproveFail2') : 'Failed')
            );
            return;
        }
        showSuccess(
            window.florI18n ? window.florI18n.t('authClient.qrDone') : 'Done'
        );
    } catch (e) {
        console.error('approveQrFromPhone:', e);
        showError(
            window.florI18n ? window.florI18n.t('authClient.qrNet') : 'Network'
        );
    }
}

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function showError(message) {
    removeMessage('error-message');
    removeMessage('success-message');

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message show';
    errorDiv.textContent = message;

    const form = document.getElementById('authForm');
    form.insertBefore(errorDiv, form.firstChild);
}

function showSuccess(message) {
    removeMessage('error-message');
    removeMessage('success-message');

    const successDiv = document.createElement('div');
    successDiv.className = 'success-message show';
    successDiv.textContent = message;

    const form = document.getElementById('authForm');
    form.insertBefore(successDiv, form.firstChild);
}

function removeMessage(className) {
    const existingMessage = document.querySelector('.' + className);
    if (existingMessage) {
        existingMessage.remove();
    }
}
