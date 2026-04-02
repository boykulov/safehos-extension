const params = new URLSearchParams(window.location.search);
const domain = params.get('domain') || 'Неизвестный домен';
const reason = params.get('reason') || 'Фишинговый сайт';
document.getElementById('domain').textContent = domain;
document.getElementById('reason').textContent = reason;

function goBack() { history.back(); }
