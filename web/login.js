'use strict';
document.getElementById('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('login-error');
  error.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('password').value }),
  });
  if (res.ok) location.href = '/';
  else error.textContent = (await res.json().catch(() => ({}))).error || 'Could not sign in.';
});
