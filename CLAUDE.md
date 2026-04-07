# SafeHos — Claude Code Context

## Что такое SafeHos
Корпоративная антифишинговая система для логистических диспетчеров компании **NebUlaNet** (nebulanet.uz).
Chrome extension перехватывает все переходы диспетчеров и проверяет домены через API в реальном времени.
Неизвестные домены блокируются автоматически (Default Deny / Zero Trust).
Модератор видит все заблокированные запросы и одобряет/блокирует домены через панель.

---

## Инфраструктура

| Компонент | Расположение | URL |
|-----------|-------------|-----|
| Backend (NestJS) | `~/safehos-backend/` | `https://api.safehos.com/api/v1` |
| Moderator Panel (React) | `~/safehos-moderator/` | `https://app.safehos.com` |
| Chrome Extension (MV3) | `~/safehos-extension/` | — |
| База данных | `~/safehos-backend/safehos.sqlite` | SQLite + better-sqlite3 |
| Process manager | PM2 | `pm2 status` |
| Web server | Nginx | `/etc/nginx/sites-enabled/` |

**Сервер:** DigitalOcean `207.154.219.224`

---

## Тестовые аккаунты

| Email | Password | Role |
|-------|----------|------|
| `moderator@acme.com` | `password123` | moderator |
| `dispatcher@acme.com` | `password123` | dispatcher (companyId: company-001) |

---

## Архитектура: Default Deny / Zero Trust

### Приоритет решений при проверке домена:
1. `org_block` → BLOCK
2. `global_block` → BLOCK
3. `org_allow` → ALLOW
4. `global_allow` → ALLOW
5. Google Safe Browsing malicious → BLOCK + pending event
6. Unknown → BLOCK + pending_review event

### Wildcard логика (КРИТИЧНО):
- `findInList()` в `allowlist.service.ts` проверяет `isWildcard = 1` при проверке поддоменов
- БЕЗ wildcard: `sub.domain.com` → pending (не разрешён)
- С wildcard: `sub.domain.com` → trusted (покрыт `*.domain.com`)
- При wildcard одобрении поддомена — одобряется КОРНЕВОЙ домен, не сам поддомен

---

## Ключевые файлы

### Backend (`~/safehos-backend/src/`)
domain/
domain.entity.ts      — поля: id, domain, companyId, decision, listType,
isWildcard, isGlobal, category, approvedBy,
notes, reason, riskScore, decidedBy, createdAt, updatedAt
domain.service.ts     — checkDomain(), applyModeratorDecision(),
closeSubdomainPending()
domain.controller.ts  — все REST endpoints
allowlist.service.ts  — checkDomainPolicy(), findInList() (с isWildcard!),
addToAllowlist(), addToBlocklist()
decision/
decision.service.ts   — makeDecision(), getHistory()
gateway/
events.gateway.ts     — WebSocket (wsHub, ping каждые 25с)
main.ts                 — CORS: GET POST PUT PATCH DELETE OPTIONS

### Frontend (`~/safehos-moderator/src/`)
components/ModeratorPanel.tsx  — весь UI (очередь, allowlist, blocklist, история)
api.ts                         — все API вызовы

### Extension (`~/safehos-extension/`)
background.js    — Default Deny, SKIP_URLS только safehos.com,
Fail Open при ошибке сети, кэш TTL 30 мин, sync каждые 10с
blocked.html     — страница блокировки (жёлтая=suspicious, красная=blocked)
popup.html/js    — popup с анимацией щита

---

## Критические правила (НИКОГДА не нарушать)

1. **Verdict rule**: Одобренный/заблокированный домен НИКОГДА не триггерит алерты повторно
2. **Wildcard**: Поддомен разрешается ТОЛЬКО если у родителя `isWildcard=true`
3. **HTTP 403**: НЕ является угрозой (Cloudflare bot protection)
4. **Только NXDOMAIN, 404, 500, 502, 503** — валидные suspicious индикаторы
5. **Конфликт 409**: Домен не может быть в allowlist и blocklist одновременно
6. **SKIP_URLS**: Содержит только `safehos.com` — всё остальное через allowlist
7. **alerts таблица**: нет отдельных колонок reason/message — только в `details` jsonb

---

## Частые команды

```bash
# Перезапуск backend
pm2 restart safehos-backend

# Логи backend
pm2 logs safehos-backend --lines 50

# Сборка и деплой backend
cd ~/safehos-backend && npm run build && pm2 restart safehos-backend

# Сборка и деплой frontend
cd ~/safehos-moderator && npm run build && \
  chmod -R 755 /root/safehos-moderator/build && \
  find /root/safehos-moderator/build -type f -exec chmod 644 {} \; && \
  find /root/safehos-moderator/build -type d -exec chmod 755 {} \; && \
  systemctl reload nginx

# Проверка API
TOKEN=$(curl -s -X POST https://api.safehos.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"moderator@acme.com","password":"password123"}' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

# Проверка домена
curl -s -X POST https://api.safehos.com/api/v1/domain/check \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://example.com","tabId":"test"}' | python3 -m json.tool

# Просмотр БД
sqlite3 ~/safehos-backend/safehos.sqlite \
  "SELECT domain, listType, isWildcard, isGlobal FROM domain_decisions LIMIT 20;"

# Backup БД
cp ~/safehos-backend/safehos.sqlite ~/safehos-backup-$(date +%Y%m%d).sqlite
```

---

## Репозитории
https://github.com/boykulov/safehos-backend.git
https://github.com/boykulov/safehos-extension.git
https://github.com/boykulov/safehos-moderator.git

---

## База данных: таблица domain_decisions

Одна таблица для всего — pending события, allowlist, blocklist:

| listType | Значение |
|----------|----------|
| `pending_review` | Ожидает решения модератора |
| `org_allow` | Разрешён для компании |
| `global_allow` | Разрешён глобально |
| `org_block` | Заблокирован для компании |
| `global_block` | Заблокирован глобально |

**ВАЖНО**: При удалении записей из БД — используй точечные DELETE с конкретными id, НИКОГДА не делай `DELETE FROM domain_decisions` без WHERE!

---

## Известные особенности

- `corpMode` flag — скрывает кнопку logout для корпоративных аккаунтов диспетчеров
- `blocked.html` — 3 секунды countdown после одобрения модератором, потом редирект
- Extension кэш хранится в `chrome.storage.local` (не session)
- При approve домена — удалять из `block_rules`; при block — удалять из whitelist
- Nginx `proxy_read_timeout` = 86400 для WebSocket стабильности
- PATCH метод добавлен в CORS (main.ts)

---

## CSV формат для импорта Allowlist

```csv
domain,category,type,wildcard,notes,added_by,created_at
okta.com,auth,global,yes,Okta SSO,system,2026-04-07
dat.com,loadboard,global,yes,DAT Load Board,system,2026-04-07
```

Категории: `loadboard`, `factoring`, `broker`, `carrier`, `eld`, `tms`, `maps`, `email`, `auth`, `cdn`, `document`, `support`, `other`
Тип: `global` или `org`
Wildcard: `yes` или `no`

