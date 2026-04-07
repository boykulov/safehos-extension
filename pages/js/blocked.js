const params = new URLSearchParams(window.location.search);
document.getElementById('domain').textContent = params.get('domain') || 'Неизвестный домен';
document.getElementById('reason').textContent = params.get('reason') || 'Фишинговый сайт';
document.getElementById('back-btn').addEventListener('click', () => history.back());

// Частицы
const container = document.getElementById('particles');
for (let i = 0; i < 20; i++) {
  const p = document.createElement('div');
  p.className = 'particle';
  p.style.left = Math.random() * 100 + 'vw';
  p.style.animationDuration = (8 + Math.random() * 12) + 's';
  p.style.animationDelay = (Math.random() * 8) + 's';
  p.style.width = p.style.height = (2 + Math.random() * 4) + 'px';
  container.appendChild(p);
}

// Слушаем сообщение об одобрении от background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DOMAIN_APPROVED') {
    window.location.href = chrome.runtime.getURL('pages/approved.html') +
      '?domain=' + encodeURIComponent(message.domain) +
      '&url=' + encodeURIComponent(message.originalUrl) +
      '&time=' + encodeURIComponent(message.time || '0');
  }
});
