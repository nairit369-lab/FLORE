# FLOR MESSENGER — развёртывание на VDS (кратко)

## Что на сервере

| Компонент | Роль |
|-----------|------|
| **Node.js** (≥18) | Запуск `server.js` |
| **PM2** (или systemd) | Чтобы сервер не падал и перезапускался |
| **Nginx** | Прокси с 80/443 на порт Node |
| **`.env`** | Секреты и `PORT` — без него 502 и отказ в production |

## 1. Установка

```bash
# Ubuntu/Debian: Node 20, nginx, PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt update && sudo apt install -y nodejs git nginx
sudo npm i -g pm2
```

## 2. Код

```bash
cd /var/www   # или своя папка
git clone <URL> flormessenger && cd flormessenger
npm ci
```

**Не копируй `node_modules` с Windows/Mac** — нативные модули (например `sqlite3`) не подойдут. Поставь зависимости **на сервере** (`npm ci` / `npm install`).

## 2a. Сборка нативных модулей (обязательно на Ubuntu)

Для `sqlite3` нужны компилятор и python для node-gyp:

```bash
sudo apt install -y build-essential python3 make g++
```

Без этого или при «чужом» `node_modules` в логах бывает: `GLIBC_2.xx not found` / `ERR_DLOPEN_FAILED` для `node_sqlite3.node`.

## 3. Настройка `.env`

**Файл нельзя «запустить» командами** `.env` или `.env.example` — в консоли это ошибка. Нужно **отредактировать** файл, например:

```bash
cd /opt/flor-messenger   # своя папка с проектом
cp -n .env.example .env  # копия примера, если .env ещё нет (-n не затирает)
nano .env                # вставь переменные, Ctrl+O — сохранить, Ctrl+X — выход
```

В `.env` **обязательно** задай (рядом с `server.js`):

```env
NODE_ENV=production
JWT_SECRET=своя_длинная_случайная_строка
PORT=3000
HOST=0.0.0.0
TRUST_PROXY=1
```

Без **своего** `JWT_SECRET` в production приложение **не стартует** → Nginx даст **502**.

## 4. Запуск Node

```bash
pm2 start server.js --name flor
pm2 save
pm2 startup   # выполни одноразовую команду, которую выдаст
```

Уже настроен PM2? Не дублируй `start` — при смене `.env`: **`pm2 restart flor --update-env`** (иначе переменные из `.env` могут не подхватиться).

Если в колонке **↺** (restarts) большое число — процесс **падает в цикле** (частая причина 502). Смотри логи: `pm2 logs flor --lines 80` и устраняй ошибку в выводе (БД, права на файлы, порт, SSL-пути).

Проверка: `curl -I http://127.0.0.1:3000` — не должно быть «Connection refused».

## 5. Nginx

Файл сайта, например `/etc/nginx/sites-available/flor`:

```nginx
server {
    listen 80;
    server_name ваш.домен;

    location / {
        proxy_pass http://127.0.0.1:3000;   # тот же PORT, что в .env
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/flor /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 6. HTTPS (рекомендуется)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш.домен
```

Потом в `.env` можно указать `CORS_ORIGIN=https://ваш.домен` и `pm2 restart flor`.

## 7. Если 502

1. `pm2 logs flor` — ошибки, БД, `JWT`.
2. `curl http://127.0.0.1:3000` — отвечает ли Node.
3. В Nginx `proxy_pass` = тот же порт, что `PORT` в `.env`.
4. После правок `.env`: `pm2 restart flor --update-env`.

**Ошибка `GLIBC_… not found` / `ERR_DLOPEN_FAILED` + `node_sqlite3.node`:** `sqlite3` собран не под твою ОС. Установи `build-essential` (см. п. 2a), в каталоге проекта: `npm rebuild sqlite3 --build-from-source` или `rm -rf node_modules && npm ci`, затем `pm2 restart flor`.

## Файрвол (если нужен)

```bash
sudo ufw allow 22
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

Подробные переменные — в `.env.example` в репозитории.
