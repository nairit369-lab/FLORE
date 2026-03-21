let isLoginMode = true;

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

function mapApiError(msg) {
    if (!msg || typeof msg !== 'string') return msg;
    const m = {
        'Invalid credentials': 'Неверный email или пароль',
        'Email and password required': 'Введите email и пароль',
        'Login failed': 'Ошибка входа',
        'Registration failed': 'Ошибка регистрации',
        'All fields required': 'Заполните все поля',
        'Email already registered': 'Этот email уже зарегистрирован',
        'Password must be at least 6 characters': 'Пароль не короче 6 символов'
    };
    return m[msg] || msg;
}

function initializeAuth() {
    const authForm = document.getElementById('authForm');
    const switchLink = document.getElementById('switchLink');

    loadSavedLoginFields();

    const token = localStorage.getItem('token');
    const currentUser = localStorage.getItem('currentUser');

    if (token && currentUser) {
        try {
            JSON.parse(currentUser);
            setTimeout(() => {
                window.location.replace('index.html');
            }, 100);
            return;
        } catch (e) {
            localStorage.removeItem('token');
            localStorage.removeItem('currentUser');
        }
    }

    authForm.addEventListener('submit', handleSubmit);
    switchLink.addEventListener('click', toggleMode);
}

function toggleMode(e) {
    e.preventDefault();

    isLoginMode = !isLoginMode;

    const usernameGroup = document.getElementById('usernameGroup');
    const confirmPasswordGroup = document.getElementById('confirmPasswordGroup');
    const submitBtn = document.getElementById('submitBtn');
    const switchText = document.getElementById('switchText');
    const switchLink = document.getElementById('switchLink');
    const rememberRow = document.getElementById('rememberRow');

    if (isLoginMode) {
        usernameGroup.style.display = 'none';
        confirmPasswordGroup.style.display = 'none';
        if (rememberRow) rememberRow.style.display = 'block';
        submitBtn.textContent = 'Войти';
        switchText.textContent = 'Нет аккаунта?';
        switchLink.textContent = 'Регистрация';
        document.querySelector('.logo h1').textContent = 'С возвращением';
        document.querySelector('.logo p').textContent = 'Войдите в аккаунт, чтобы продолжить переписку.';
    } else {
        usernameGroup.style.display = 'block';
        confirmPasswordGroup.style.display = 'block';
        if (rememberRow) rememberRow.style.display = 'block';
        submitBtn.textContent = 'Зарегистрироваться';
        switchText.textContent = 'Уже есть аккаунт?';
        switchLink.textContent = 'Войти';
        document.querySelector('.logo h1').textContent = 'Регистрация';
        document.querySelector('.logo p').textContent = 'Создайте аккаунт во FLOR MESSENGER.';
    }

    removeMessage('error-message');
    removeMessage('success-message');
}

async function handleSubmit(e) {
    e.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const username = document.getElementById('username').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (!isLoginMode) {
        if (!username || username.trim().length < 3) {
            showError('Имя пользователя — не менее 3 символов');
            return;
        }

        if (password !== confirmPassword) {
            showError('Пароли не совпадают');
            return;
        }
    }

    if (!email || !validateEmail(email)) {
        showError('Введите корректный адрес email');
        return;
    }

    if (!password || password.length < 6) {
        showError('Пароль — не менее 6 символов');
        return;
    }

    if (isLoginMode) {
        await login(email, password);
    } else {
        await register(username, email, password);
    }
}

async function login(email, password) {
    try {
        const response = await fetch(florApi('/api/login'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showError(mapApiError(data.error) || 'Не удалось войти');
            return;
        }

        persistLoginPreferences(email, null);

        try {
            const key = 'florLoginHistory';
            const hist = JSON.parse(localStorage.getItem(key) || '[]');
            hist.unshift({ t: Date.now(), email: email.trim() });
            localStorage.setItem(key, JSON.stringify(hist.slice(0, 25)));
        } catch (e) {
            /* ignore */
        }

        localStorage.setItem('token', data.token);
        localStorage.setItem('currentUser', JSON.stringify(data.user));

        showSuccess('Вход выполнен. Переход…');

        setTimeout(() => {
            window.location.href = 'index.html';
        }, 800);
    } catch (error) {
        console.error('Login error:', error);
        showError('Сеть недоступна. Проверьте подключение и попробуйте снова.');
    }
}

async function register(username, email, password) {
    try {
        const response = await fetch(florApi('/api/register'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showError(mapApiError(data.error) || 'Не удалось зарегистрироваться');
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

        localStorage.setItem('token', data.token);
        localStorage.setItem('currentUser', JSON.stringify(data.user));

        showSuccess('Аккаунт создан. Переход…');

        setTimeout(() => {
            window.location.href = 'index.html';
        }, 800);
    } catch (error) {
        console.error('Registration error:', error);
        showError('Сеть недоступна. Проверьте подключение и попробуйте снова.');
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
