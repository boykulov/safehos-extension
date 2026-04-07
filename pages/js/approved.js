const params = new URLSearchParams(window.location.search);
const domain = params.get('domain') || 'Неизвестный домен';
const originalUrl = params.get('url') || ('https://' + domain);
const checkTime = params.get('time');

document.getElementById('domain').textContent = domain;
document.getElementById('subtitle').textContent = `Модератор проверил и одобрил ${domain}`;
if (checkTime) {
  const t = parseInt(checkTime);
  document.getElementById('check-time').textContent = t < 60 ? `${t} сек` : `${Math.floor(t/60)}м ${t%60}с`;
}

// Конфетти
function createConfetti() {
  const colors = ['#3fb950','#388bfd','#8957e5','#f0a84a','#56d364'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2 + Math.random() * 3) + 's';
    piece.style.animationDelay = (Math.random() * 2) + 's';
    piece.style.width = (6 + Math.random() * 8) + 'px';
    piece.style.height = (6 + Math.random() * 8) + 'px';
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 5000);
  }
}
createConfetti();

// Обратный отсчёт
let count = 3;
const countEl = document.getElementById('countdown');
const timer = setInterval(() => {
  count--;
  countEl.textContent = count;
  if (count <= 0) {
    clearInterval(timer);
    window.location.href = originalUrl;
  }
}, 1000);

document.getElementById('enter-btn').addEventListener('click', () => {
  clearInterval(timer);
  window.location.href = originalUrl;
});
