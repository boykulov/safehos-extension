const API_BASE = 'https://api.safehos.com/api/v1';

// Локальный кэш — только для производительности
// Сервер всегда является источником истины
const domainCache = new Map();    // domain → { decision, timestamp, eventId }
const CACHE_TTL = 30 * 60 * 1000; // 30 минут (было 24ч — уменьшаем для Default Deny)

const pendingTabs = new Map();    // eventId → { tabId, domain, url, startTime, autoBlocked }
const blockedTabs = new Map();    // domain → [{ tabId, originalUrl }]
const resolvedDecisions = new Map(); // eventId → { decision, originalUrl }
const checkingDomains = new Set();

// Минимальный список — только служебные URL которые никогда не проверяем
// Все остальные домены идут на проверку к серверу
const SKIP_URLS = new Set([
  'safehos.com',
]);

function shouldSkip(domain) {
  if (!domain) return true;
  for (const skip of SKIP_URLS) {
    if (domain === skip || domain.endsWith('.' + skip)) return true;
  }
  return false;
}

chrome.runtime.onInstalled.addListener(() => loadCacheFromStorage());
chrome.runtime.onStartup.addListener(() => loadCacheFromStorage());

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await handleNavigation(details.url, details.tabId);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.transitionType === 'auto_subframe') return;
  await handleNavigation(details.url, details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [domain, tabs] of blockedTabs.entries()) {
    const filtered = tabs.filter(t => t.tabId !== tabId);
    if (filtered.length === 0) blockedTabs.delete(domain);
    else blockedTabs.set(domain, filtered);
  }
});

async function handleNavigation(url, tabId) {
  if (!url) return;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url.startsWith('data:') || url.startsWith('file:')) return;

  const domain = extractDomain(url);
  if (!domain || shouldSkip(domain)) return;

  // Проверяем кэш
  const cached = getCachedDecision(domain);
  if (cached) {
    if (cached.decision === 'blocked' || cached.decision === 'pending') {
      // pending тоже блокируем — Default Deny
      blockTab(tabId, domain, cached.reason || 'Домен не одобрён', url);
    }
    // trusted/approved → пропускаем
    return;
  }

  await checkDomain(url, domain, tabId);
}

async function checkDomain(url, domain, tabId) {
  if (checkingDomains.has(domain)) return;
  checkingDomains.add(domain);

  try {
    const token = await getToken();
    if (!token) { checkingDomains.delete(domain); return; }

    const res = await fetch(`${API_BASE}/domain/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ url, tabId: String(tabId) }),
    });

    if (res.status === 401) {
      await chrome.storage.session.remove('token');
      checkingDomains.delete(domain);
      return;
    }

    const result = await res.json();
    checkingDomains.delete(domain);

    handleCheckResult(result, tabId, url, domain);

  } catch (e) {
    console.error('checkDomain error:', e);
    checkingDomains.delete(domain);
    // При ошибке сети — НЕ блокируем (сервер недоступен)
    // Fail Open для network errors, чтобы не мешать работе при проблемах с API
    // Но очищаем кэш чтобы при следующем открытии перепроверить
    domainCache.delete(domain);
  }
}

function handleCheckResult(result, tabId, url, domain) {
  const { decision, eventId, message, riskScore, flags, category } = result;

  if (decision === 'trusted' || decision === 'approved') {
    // Домен в allowlist → открываем
    cacheDecision(domain, 'trusted', 'Разрешено', null, CACHE_TTL);
    return;
  }

  if (decision === 'blocked') {
    // Домен в blocklist → блокируем навсегда
    cacheDecision(domain, 'blocked', message || 'Заблокировано', null, CACHE_TTL);
    blockTab(tabId, domain, message || 'Заблокировано', url);
    return;
  }

  if (decision === 'pending') {
    // DEFAULT DENY — домен неизвестен
    // Блокируем И добавляем в pendingTabs для ожидания решения модератора
    cacheDecision(domain, 'pending', message || 'Не одобрен', eventId, CACHE_TTL);

    if (eventId) {
      pendingTabs.set(eventId, {
        tabId, domain, url,
        startTime: Date.now(),
        autoBlocked: true,
        riskScore: riskScore || 0,
        flags: flags || [],
      });
    }

    // Показываем страницу блокировки с пометкой "Not approved yet"
    blockTab(tabId, domain, message || 'Домен не в списке разрешённых', url, 'pending');
    return;
  }

  if (decision === 'dangerous') {
    // GSB или критический риск
    cacheDecision(domain, 'blocked', message, eventId, CACHE_TTL);
    blockTab(tabId, domain, message || 'Опасный сайт', url, 'dangerous');

    if (eventId) {
      pendingTabs.set(eventId, {
        tabId, domain, url,
        startTime: Date.now(),
        autoBlocked: true,
      });
    }
  }
}

function blockTab(tabId, domain, reason, originalUrl, type = 'blocked') {
  // Запоминаем оригинальный URL для возможной разблокировки
  if (originalUrl && !originalUrl.includes('chrome-extension://')) {
    if (!blockedTabs.has(domain)) blockedTabs.set(domain, []);
    const existing = blockedTabs.get(domain);
    if (!existing.find(t => t.tabId === tabId)) {
      existing.push({ tabId, originalUrl });
    }
  }

  const blockedUrl = chrome.runtime.getURL('pages/blocked.html') +
    `?domain=${encodeURIComponent(domain)}&reason=${encodeURIComponent(reason || 'Заблокировано')}&type=${type}`;
  chrome.tabs.update(tabId, { url: blockedUrl });

  // Уведомление
  chrome.notifications.create(`block_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: type === 'pending' ? '⏳ SafeHos — Сайт не одобрён' : '🚫 SafeHos — Сайт заблокирован',
    message: domain,
  });
}

function showApprovedPage(tabId, domain, originalUrl, responseTime) {
  const url = chrome.runtime.getURL('pages/approved.html') +
    `?domain=${encodeURIComponent(domain)}&url=${encodeURIComponent(originalUrl)}&time=${responseTime || 0}`;
  chrome.tabs.update(tabId, { url });
  chrome.notifications.create(`approved_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: '✅ SafeHos — Доступ разрешён',
    message: `Модератор одобрил: ${domain}`,
  });
}

async function approveAllTabsWithDomain(domain) {
  // Обновляем кэш — убираем pending/blocked
  cacheDecision(domain, 'trusted', 'Одобрено модератором', null, CACHE_TTL);

  const blocked = blockedTabs.get(domain);
  if (blocked && blocked.length > 0) {
    for (const { tabId, originalUrl } of blocked) {
      try {
        await chrome.tabs.get(tabId);
        showApprovedPage(tabId, domain, originalUrl, null);
      } catch(e) {}
    }
    blockedTabs.delete(domain);
    return;
  }

  // Ищем вкладки на blocked.html с этим доменом
  try {
    const tabs = await chrome.tabs.query({});
    let found = false;
    for (const tab of tabs) {
      if (tab.url && tab.url.includes('pages/blocked.html') &&
          tab.url.includes(encodeURIComponent(domain))) {
        showApprovedPage(tab.id, domain, `https://${domain}`, null);
        found = true;
      }
    }
    if (!found) {
      chrome.notifications.create(`approved_${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/icon48.png',
        title: '✅ SafeHos — Доступ разрешён',
        message: `Модератор одобрил: ${domain}`,
      });
    }
  } catch(e) {}
}

async function blockAllTabsWithDomain(domain) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      const tabDomain = extractDomain(tab.url);
      if (tabDomain === domain && !tab.url.startsWith('chrome-extension://')) {
        blockTab(tab.id, domain, 'Заблокировано модератором', tab.url);
      }
    }
  } catch(e) {}
}

// ============================================================
// POLLING — каждые 2 сек для pending событий
// ============================================================
let pollingInterval = null;

async function startPolling(token) {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(async () => {
    if (pendingTabs.size === 0) return;

    for (const [eventId, tabInfo] of pendingTabs.entries()) {
      if (eventId.startsWith('tmp_')) continue;
      try {
        const res = await fetch(`${API_BASE}/decision/status/${eventId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) continue;
        const status = await res.json();
        if (!status.resolved || status.decision === 'pending') continue;

        pendingTabs.delete(eventId);
        const responseTime = Math.floor((Date.now() - tabInfo.startTime) / 1000);

        if (status.decision === 'approved') {
          cacheDecision(tabInfo.domain, 'trusted', 'Одобрено', null, CACHE_TTL);
          resolvedDecisions.set(eventId, { decision: 'approved', originalUrl: tabInfo.url });
          await approveAllTabsWithDomain(tabInfo.domain);
        } else {
          cacheDecision(tabInfo.domain, 'blocked', 'Заблокировано', null, CACHE_TTL);
          resolvedDecisions.set(eventId, { decision: 'blocked', originalUrl: tabInfo.url });
          // Уже на blocked странице — просто обновляем сообщение
          chrome.notifications.create(`blocked_mod_${Date.now()}`, {
            type: 'basic', iconUrl: 'icons/icon48.png',
            title: '🚫 SafeHos — Заблокировано модератором',
            message: tabInfo.domain,
          });
        }
      } catch(e) {}
    }
  }, 2000);
}

// ============================================================
// SYNC — каждые 10 сек синхронизирует кэш с сервером
// ============================================================
let syncInterval = null;
let lastSyncTime = 0;

async function startSync(token) {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/domain/decisions/sync`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return;
      const serverDecisions = await res.json();

      // Собираем домены которые есть на сервере
      const serverDomains = new Set(serverDecisions.map(d => d.domain));

      for (const dec of serverDecisions) {
        const cached = domainCache.get(dec.domain);
        const serverTime = new Date(dec.updatedAt).getTime();

        if (!cached || serverTime > cached.timestamp) {
          const oldDecision = cached?.decision;
          const newDecision = dec.decision === 'approved' ? 'trusted' : 'blocked';
          cacheDecision(dec.domain, newDecision, 'Синхронизировано', null, CACHE_TTL);

          if (newDecision === 'blocked' && oldDecision !== 'blocked') {
            // Домен стал заблокированным → блокируем все вкладки
            blockAllTabsWithDomain(dec.domain);
          } else if (newDecision === 'trusted' && oldDecision === 'blocked') {
            // Домен разблокирован → открываем заблокированные вкладки
            approveAllTabsWithDomain(dec.domain);
          }
        }
      }

      // Проверяем домены в кэше которых больше нет на сервере
      // Это значит их удалили из allowlist/blocklist → нужно сбросить кэш
      if (lastSyncTime > 0) {
        for (const [domain, cached] of domainCache.entries()) {
          // Пропускаем служебные записи
          if (cached.decision === 'pending' && !serverDomains.has(domain)) {
            // Pending домен исчез с сервера — возможно одобрен/заблокирован
            // Не трогаем — polling сам обработает через eventId
            continue;
          }
          if ((cached.decision === 'trusted' || cached.decision === 'blocked') &&
              !serverDomains.has(domain)) {
            // Домен удалён из списков → сбрасываем кэш
            // При следующем открытии extension заново спросит сервер
            console.log(`Cache cleared for removed domain: ${domain} (was: ${cached.decision})`);
            domainCache.delete(domain);
          }
        }
        saveCacheToStorage();
      }

      lastSyncTime = Date.now();
    } catch(e) {}
  }, 10000);
}

// ============================================================
// MESSAGES
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LOGIN') {
    handleLogin(message.email, message.password)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (message.type === 'GET_STATUS') {
    getToken().then(token => sendResponse({ loggedIn: !!token }));
    return true;
  }
  if (message.type === 'LOGOUT') {
    chrome.storage.session.clear();
    domainCache.clear();
    chrome.storage.local.remove('domainCache');
    if (pollingInterval) clearInterval(pollingInterval);
    if (syncInterval) clearInterval(syncInterval);
    sendResponse({ success: true });
  }
  if (message.type === 'GET_DECISION') {
    const dec = resolvedDecisions.get(message.eventId);
    if (dec) { sendResponse(dec); }
    else {
      const cached = domainCache.get(message.domain);
      sendResponse(cached && cached.decision !== 'pending'
        ? { decision: cached.decision === 'trusted' ? 'approved' : cached.decision, originalUrl: null }
        : { decision: null });
    }
  }
  if (message.type === 'CLEAR_DOMAIN_CACHE') {
    if (message.domain) domainCache.delete(message.domain);
    else domainCache.clear();
    saveCacheToStorage();
    sendResponse({ success: true });
  }
});

async function handleLogin(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Ошибка входа');
  await chrome.storage.session.set({
    token: data.access_token, userId: data.user.id,
    role: data.user.role, companyId: data.user.companyId, email: data.user.email,
  });
  startPolling(data.access_token);
  startSync(data.access_token);
  return { success: true, user: data.user };
}

async function getToken() {
  const data = await chrome.storage.session.get('token');
  return data.token || null;
}

function extractDomain(url) {
  try {
    let h = new URL(url).hostname;
    if (h.startsWith('www.')) h = h.slice(4);
    return h.toLowerCase();
  } catch { return null; }
}

function cacheDecision(domain, decision, reason, eventId, ttl) {
  domainCache.set(domain, { decision, reason, eventId, timestamp: Date.now(), ttl: ttl || CACHE_TTL });
  saveCacheToStorage();
}

function getCachedDecision(domain) {
  const c = domainCache.get(domain);
  if (!c) return null;
  const ttl = c.ttl || CACHE_TTL;
  if (Date.now() - c.timestamp > ttl) { domainCache.delete(domain); return null; }
  return c;
}

async function saveCacheToStorage() {
  const obj = {};
  for (const [k, v] of domainCache.entries()) obj[k] = v;
  await chrome.storage.local.set({ domainCache: obj });
}

async function loadCacheFromStorage() {
  const data = await chrome.storage.local.get('domainCache');
  if (data.domainCache) {
    for (const [domain, value] of Object.entries(data.domainCache)) {
      const ttl = value.ttl || CACHE_TTL;
      if (Date.now() - value.timestamp < ttl) {
        domainCache.set(domain, value);
      }
    }
  }
  const tokenData = await chrome.storage.session.get('token');
  if (tokenData.token) {
    startPolling(tokenData.token);
    startSync(tokenData.token);
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});
