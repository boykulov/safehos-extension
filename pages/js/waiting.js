const params = new URLSearchParams(window.location.search);
const domain = params.get('domain') || 'Неизвестный домен';
const eventId = params.get('eventId');

document.getElementById('domain').textContent = domain;

let checkCount = 0;
const checker = setInterval(() => {
  checkCount++;
  if (checkCount > 60) {
    clearInterval(checker);
    document.getElementById('status-text').textContent =
      'Время ожидания истекло. Обратитесь к модератору.';
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'CHECK_DECISION', eventId },
    (response) => {
      if (!response?.waiting) clearInterval(checker);
    }
  );
}, 2000);

function goBack() { history.back(); }
