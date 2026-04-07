const params = new URLSearchParams(window.location.search);
const domain = params.get('domain') || 'Неизвестный домен';
const eventId = params.get('eventId');
const originalUrl = params.get('url') || ('https://' + domain);

document.getElementById('domain').textContent = domain;
document.getElementById('back-btn').addEventListener('click', function() { history.back(); });

// Таймер ожидания
let waitSeconds = 0;
const timerEl = document.getElementById('timer');
const timerInterval = setInterval(function() {
  waitSeconds++;
  timerEl.textContent = `Время ожидания: ${waitSeconds}с`;
}, 1000);

function showApproved() {
  clearInterval(timerInterval);
  clearInterval(checker);

  document.body.classList.add('approved');
  document.getElementById('spinner').style.display = 'none';

  const resultIcon = document.getElementById('result-icon');
  resultIcon.textContent = '✅';
  resultIcon.style.display = 'block';

  document.getElementById('title').textContent = 'Доступ разрешён!';
  document.getElementById('title').style.color = '#3fb950';
  document.getElementById('subtitle').textContent = `Модератор проверил и одобрил ${domain}`;

  const card = document.getElementById('status-card');
  card.style.borderColor = 'rgba(63,185,80,0.4)';
  card.style.background = 'rgba(63,185,80,0.05)';

  document.getElementById('status-dot').style.background = '#3fb950';
  document.getElementById('status-value-text').textContent = 'Одобрено ✓';
  document.getElementById('status-value-text').style.color = '#3fb950';
  document.getElementById('progress-bar').style.display = 'none';
  document.getElementById('status-text').textContent = `✅ Одобрено за ${waitSeconds}с`;
  document.getElementById('info-card').textContent = '🚀 Открываем сайт через 2 секунды...';
  document.getElementById('info-card').style.borderColor = 'rgba(63,185,80,0.3)';
  document.getElementById('info-card').style.background = 'rgba(63,185,80,0.05)';
  document.getElementById('info-card').style.color = '#3fb950';

  setTimeout(function() {
    window.location.href = originalUrl;
  }, 2000);
}

function showBlocked() {
  clearInterval(timerInterval);
  clearInterval(checker);
  window.location.href = chrome.runtime.getURL('pages/blocked.html') +
    '?domain=' + encodeURIComponent(domain) +
    '&reason=' + encodeURIComponent('Заблокировано модератором');
}

// Слушаем прямые сообщения от background
chrome.runtime.onMessage.addListener(function(message) {
  if (message.type === 'MODERATOR_DECISION') {
    if (message.decision === 'approved') {
      showApproved();
    } else if (message.decision === 'blocked') {
      showBlocked();
    }
  }
});

// Также polling на случай если сообщение не дошло
let checkCount = 0;
const checker = setInterval(function() {
  checkCount++;
  if (checkCount > 120) {
    clearInterval(checker);
    clearInterval(timerInterval);
    document.getElementById('status-text').textContent = 'Время ожидания истекло.';
    return;
  }

  chrome.runtime.sendMessage({ type: 'GET_DECISION', eventId, domain }, function(response) {
    if (!response) return;
    if (response.decision === 'approved') {
      showApproved();
    } else if (response.decision === 'blocked') {
      showBlocked();
    }
  });
}, 1500);
