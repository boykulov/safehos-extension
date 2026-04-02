// ============================================================
// SafeHos Extension - Background Service Worker
// Этот скрипт работает постоянно в фоне
// ============================================================

const API_BASE = 'https://api.safehos.com/api/v1';

// Локальный кэш решений (чтобы не спрашивать сервер каждый раз)
// domain → { decision, timestamp }
const domainCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа

// Ожидающие решения: tabId → { domain, url, resolve }
const pendingTabs = new Map();

// Домены которые сейчас проверяются (чтобы не дублировать запросы)
const checkingDomains = new Set();

// ============================================================
// БЕЛЫЙ СПИСОК — эти домены никогда не проверяем
// ============================================================
const WHITELIST = new Set([
  'google.com', 'gmail.com', 'microsoft.com', 'office.com',
  'outlook.com', 'openai.com', 'chatgpt.com', 'github.com',
  'stackoverflow.com', 'apple.com', 'linkedin.com', 'zoom.us',
  'slack.com', 'notion.so', 'amazon.com', 'cloudflare.com',
  'newtab', 'extensions', 'chrome',
]);

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  console.log('SafeHos Extension установлен');
  loadCacheFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  loadCacheFromStorage();
  connectWebSocket();
});

// ============================================================
// ПЕРЕХВАТ НАВИГАЦИИ
// Срабатывает когда пользователь переходит на новый сайт
// ============================================================
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Только главная вкладка (не iframe, не popup)
  if (details.frameId !== 0) return;

  const url = details.url;
  const tabId = details.tabId;

  // Пропускаем служебные страницы
  if (url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('about:') ||
      url.startsWith('data:') ||
      url === 'about:blank') {
    return;
  }

  const domain = extractDomain(url);
  if (!domain) return;

  // Пропускаем белый список
  if (WHITELIST.has(domain)) return;

  // Пропускаем safehos.com (наш сайт)
  if (domain.includes('safehos.com')) return;

  // Проверяем локальный кэш
  const cached = getCachedDecision(domain);
  if (cached) {
    if (cached.decision === 'blocked') {
      blockTab(tabId, domain, cached.reason || 'Домен заблокирован');
    }
    // trusted или approved — пропускаем
    return;
  }

  // Отправляем на проверку серверу
  await checkDomain(url, domain, tabId);
});

// ============================================================
// ПРОВЕРКА ДОМЕНА ЧЕРЕЗ API
// ============================================================
async function checkDomain(url, domain, tabId) {
  // Если уже проверяется — не дублируем
  if (checkingDomains.has(domain)) return;
  checkingDomains.add(domain);

  try {
    const token = await getToken();
    if (!token) {
      // Не авторизован — показываем страницу логина
      checkingDomains.delete(domain);
      return;
    }

    const response = await fetch(`${API_BASE}/domain/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: url,
        tabId: String(tabId),
      }),
    });

    if (response.status === 401) {
      // Токен истёк — очищаем
      await chrome.storage.session.remove('token');
      checkingDomains.delete(domain);
      return;
    }

    const result = await response.json();
    checkingDomains.delete(domain);

    // Сохраняем в кэш
    cacheDecision(domain, result.decision, result.message);

    if (result.decision === 'dangerous' || result.decision === 'blocked') {
      blockTab(tabId, domain, result.message);

    } else if (result.decision === 'suspicious') {
      // Показываем страницу ожидания
      showWaitingPage(tabId, domain, result.eventId);
      // Сохраняем pending
      pendingTabs.set(result.eventId, { tabId, domain, url });

    }
    // trusted или approved — ничего не делаем, сайт открывается

  } catch (error) {
    console.error('Ошибка проверки домена:', error);
    checkingDomains.delete(domain);
  }
}

// ============================================================
// БЛОКИРОВКА ВКЛАДКИ
// ============================================================
function blockTab(tabId, domain, reason) {
  const blockedUrl = chrome.runtime.getURL('pages/blocked.html') +
    `?domain=${encodeURIComponent(domain)}&reason=${encodeURIComponent(reason || 'Фишинговый сайт')}`;

  chrome.tabs.update(tabId, { url: blockedUrl });

  // Уведомление
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '🚫 SafeHos заблокировал сайт',
    message: `Опасный домен: ${domain}`,
  });
}

// ============================================================
// СТРАНИЦА ОЖИДАНИЯ
// ============================================================
function showWaitingPage(tabId, domain, eventId) {
  const waitingUrl = chrome.runtime.getURL('pages/waiting.html') +
    `?domain=${encodeURIComponent(domain)}&eventId=${encodeURIComponent(eventId)}`;

  chrome.tabs.update(tabId, { url: waitingUrl });
}

// ============================================================
// WEBSOCKET — получаем решения модератора в реальном времени
// ============================================================
let ws = null;
let wsReconnectTimer = null;

async function connectWebSocket() {
  const token = await getToken();
  if (!token) return;

  const userData = await chrome.storage.session.get(['userId', 'role', 'companyId']);
  if (!userData.userId) return;

  if (ws) {
    ws.close();
    ws = null;
  }

  try {
    // Используем socket.io через fetch (простой polling для MV3)
    // Polling каждые 3 секунды для pending решений
    startPolling(token, userData);
  } catch (error) {
    console.error('WebSocket ошибка:', error);
  }
}

// Polling — проверяем есть ли решения для ожидающих вкладок
let pollingInterval = null;

async function startPolling(token, userData) {
  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    if (pendingTabs.size === 0) return;

    try {
      const response = await fetch(`${API_BASE}/domain/pending`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!response.ok) return;

      const pending = await response.json();

      // Проверяем решения для наших ожидающих вкладок
      for (const [eventId, tabInfo] of pendingTabs.entries()) {
        const serverEvent = pending.find(e => e.id === eventId);

        if (!serverEvent) {
          // Событие исчезло из pending — значит решение принято
          pendingTabs.delete(eventId);
          continue;
        }

        if (serverEvent.decision !== 'pending') {
          pendingTabs.delete(eventId);

          if (serverEvent.decision === 'approved') {
            // Открываем оригинальный URL
            chrome.tabs.update(tabInfo.tabId, { url: tabInfo.url });
            cacheDecision(tabInfo.domain, 'approved', 'Одобрено модератором');
          } else {
            blockTab(tabInfo.tabId, tabInfo.domain, 'Заблокировано модератором');
            cacheDecision(tabInfo.domain, 'blocked', 'Заблокировано модератором');
          }
        }
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, 3000); // каждые 3 секунды
}

// ============================================================
// СООБЩЕНИЯ ОТ СТРАНИЦ (blocked.html, waiting.html, login.html)
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'LOGIN') {
    handleLogin(message.email, message.password)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // важно для async
  }

  if (message.type === 'GET_STATUS') {
    getToken().then(token => {
      sendResponse({ loggedIn: !!token });
    });
    return true;
  }

  if (message.type === 'LOGOUT') {
    chrome.storage.session.clear();
    sendResponse({ success: true });
  }

  if (message.type === 'CHECK_DECISION') {
    // waiting.html спрашивает — есть ли уже решение?
    const eventId = message.eventId;
    const pending = pendingTabs.get(eventId);
    sendResponse({ waiting: !!pending });
  }
});

// ============================================================
// АВТОРИЗАЦИЯ
// ============================================================
async function handleLogin(email, password) {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Ошибка входа');
  }

  // Сохраняем токен и данные пользователя
  await chrome.storage.session.set({
    token: data.access_token,
    userId: data.user.id,
    role: data.user.role,
    companyId: data.user.companyId,
    email: data.user.email,
  });

  // Запускаем polling
  startPolling(data.access_token, {
    userId: data.user.id,
    role: data.user.role,
    companyId: data.user.companyId,
  });

  return { success: true, user: data.user };
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================
async function getToken() {
  const data = await chrome.storage.session.get('token');
  return data.token || null;
}

function extractDomain(url) {
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    return hostname;
  } catch { return null; }
}

function cacheDecision(domain, decision, reason) {
  domainCache.set(domain, {
    decision,
    reason,
    timestamp: Date.now(),
  });
  // Сохраняем в chrome.storage чтобы кэш выжил при перезапуске SW
  saveCacheToStorage();
}

function getCachedDecision(domain) {
  const cached = domainCache.get(domain);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    domainCache.delete(domain);
    return null;
  }
  return cached;
}

async function saveCacheToStorage() {
  const cacheObj = {};
  for (const [key, value] of domainCache.entries()) {
    cacheObj[key] = value;
  }
  await chrome.storage.local.set({ domainCache: cacheObj });
}

async function loadCacheFromStorage() {
  const data = await chrome.storage.local.get('domainCache');
  if (data.domainCache) {
    for (const [domain, value] of Object.entries(data.domainCache)) {
      if (Date.now() - value.timestamp < CACHE_TTL) {
        domainCache.set(domain, value);
      }
    }
  }
}

// Keepalive для Service Worker (MV3 убивает SW через 30 сек)
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // просто держим SW живым
  }
});
