/**
 * Server rendered pages. Keystone proper renders these through keystone-web; the mock has its own
 * so that a browser flow works before keystone-web is running, and so curl based smoke tests can
 * drive it with two form posts.
 */

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Meridian Trust Bank</title>
<style>
  body { margin: 0; font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f3f5f8; color: #1d2733; }
  header { background: #0b2a4a; color: #fff; padding: 14px 24px; font-weight: 600; letter-spacing: .02em; }
  header span { color: #8ec5ff; font-weight: 400; margin-left: 8px; font-size: .9em; }
  main { max-width: 420px; margin: 48px auto; background: #fff; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 28px 32px; }
  h1 { font-size: 1.25rem; margin: 0 0 16px; }
  label { display: block; font-size: .85rem; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #b9c2cc; border-radius: 4px; font-size: 1rem; }
  button { margin-top: 20px; width: 100%; padding: 12px; background: #0b5cad; color: #fff; border: 0; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  .error { background: #fdecea; color: #8a1c1c; padding: 10px 12px; border-radius: 4px; font-size: .9rem; }
  .hint { font-size: .8rem; color: #5b6772; margin-top: 18px; border-top: 1px solid #e3e8ee; padding-top: 12px; }
  footer { text-align: center; font-size: .75rem; color: #7a8590; margin-top: 24px; }
</style>
</head>
<body>
<header>Meridian Trust Bank <span>Keystone sign in (mock)</span></header>
<main>${body}</main>
<footer>Keystone IdP mock. Not a bank system. Synthetic users only.</footer>
</body>
</html>`;
}

export function loginPage(txn: string, error?: string): string {
  return shell('Sign in', `
<h1>Sign in to Meridian Online</h1>
${error ? `<div class="error">${esc(error)}</div>` : ''}
<form method="post" action="/login">
  <input type="hidden" name="txn" value="${esc(txn)}">
  <label for="username">Username or email</label>
  <input id="username" name="username" autocomplete="username" autofocus required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Continue</button>
</form>
<div class="hint">Mock environment. Any fixture username with password <code>Passw0rd</code>. Usernames are listed at <code>/debug/users</code>.</div>`);
}

export function mfaPage(txn: string, maskedPhone: string, error?: string): string {
  return shell('Verify it is you', `
<h1>Enter the code we sent to ${esc(maskedPhone)}</h1>
${error ? `<div class="error">${esc(error)}</div>` : ''}
<form method="post" action="/mfa">
  <input type="hidden" name="txn" value="${esc(txn)}">
  <label for="code">6 digit code</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" autofocus required>
  <button type="submit">Verify</button>
</form>
<div class="hint">Mock environment. The code is always <code>123456</code>.</div>`);
}

export function errorPage(title: string, detail: string): string {
  return shell(title, `<h1>${esc(title)}</h1><div class="error">${esc(detail)}</div>`);
}

export function loggedOutPage(): string {
  return shell('Signed out', `<h1>You have been signed out</h1><p>Close this window or return to Meridian Online.</p>`);
}
