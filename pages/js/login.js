chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
  if (response?.loggedIn) showLoggedIn();
});

function doLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('login-btn');

  if (!email || !password) {
    showStatus('Введите email и пароль', 'error');
    return;
  }

  btn.textContent = 'Входим...';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'LOGIN', email, password }, (response) => {
    btn.textContent = 'Войти в систему';
    btn.disabled = false;

    if (response?.success) {
      showLoggedIn(response.user);
      showStatus('Защита активирована! ✓', 'success');
    } else {
      showStatus(response?.error || 'Неверный email или пароль', 'error');
    }
  });
}

function doLogout() {
  chrome.runtime.sendMessage({ type: 'LOGOUT' }, () => {
    document.getElementById('logged-in').style.display = 'none';
    document.getElementById('login-form').style.display = 'flex';
  });
}

function showLoggedIn(user) {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('logged-in').style.display = 'flex';

  chrome.storage.session.get(['email', 'role'], (data) => {
    const email = user?.email || data.email || '';
    const role = user?.role || data.role || '';
    document.getElementById('user-email').textContent = email;
    document.getElementById('user-role').textContent = role;
    document.getElementById('role-badge').textContent = role;
    const letter = email.charAt(0).toUpperCase();
    document.getElementById('avatar-letter').textContent = letter;
  });

  // Загружаем статистику из локального кэша
  chrome.storage.local.get(['stat_checked', 'stat_blocked'], (data) => {
    document.getElementById('stat-checked').textContent = data.stat_checked || 0;
    document.getElementById('stat-blocked').textContent = data.stat_blocked || 0;
  });
}

function showStatus(msg, type) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = 'status-bar ' + type;
  bar.style.display = 'block';
  setTimeout(() => { bar.style.display = 'none'; }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('logout-btn') &&
    document.getElementById('logout-btn').addEventListener('click', doLogout);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
