const { chromium } = require('playwright');
const Keygrip = require(process.env.H + '/node_modules/keygrip');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8766';
const res = []; const ok = (n, c) => res.push((c ? 'PASS ' : 'FAIL ') + n);
const keep = p => p.evaluate(() => fetch('/admin/api/keepalive').then(r => r.status));
const path = p => new URL(p.url()).pathname;
async function login(p, pw = 'testpw') {
  await p.goto(BASE + '/'); await p.click('#cfg'); await p.waitForURL('**/admin/login.html');
  await p.fill('#password', pw); await p.click('input[type=submit]');
}
(async () => {
  const b = await chromium.launch();
  if (process.env.MODE === 'idle') {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    await login(p); await p.waitForURL(u => new URL(u).pathname === '/admin/');
    ok('logged in', await keep(p) === 200);
    await p.waitForTimeout(4500);
    const c = (await ctx.cookies()).filter(c => c.name.startsWith('connectbox'));
    ok('box refuses a session idle longer than the limit', await keep(p) === 401);
    // a cookie made before this change: signed, username set, no "seen" time
    const key = fs.readFileSync('/usr/local/connectbox/admin_session.key', 'utf8').trim();
    const val = Buffer.from(JSON.stringify({username: 'admin'})).toString('base64');
    const sig = new Keygrip([key]).sign('connectbox=' + val);
    const ctx2 = await b.newContext(); await ctx2.addCookies([
      {name: 'connectbox', value: val, url: BASE}, {name: 'connectbox.sig', value: sig, url: BASE}]);
    const p2 = await ctx2.newPage(); await p2.goto(BASE + '/');
    ok('old-style login cookie (no last-use time) refused', await keep(p2) === 401);
  } else {
    const ctx = await b.newContext({acceptDownloads: true}); const p = await ctx.newPage();
    await login(p, 'wrong'); await p.waitForTimeout(800);
    ok('wrong password stays on login page', path(p) === '/admin/login.html');
    await p.fill('#password', 'testpw'); await p.click('input[type=submit]');
    await p.waitForURL(u => new URL(u).pathname === '/admin/'); await p.waitForTimeout(500);
    ok('correct password -> Configuration page', path(p) === '/admin/');
    ok('keepalive accepted while open', await keep(p) === 200);
    const sc = (await ctx.cookies()).find(c => c.name === 'connectbox');
    const left = sc.expires - Date.now() / 1000;
    ok('login cookie expires in about 5 minutes (' + Math.round(left) + ' s)', left > 280 && left <= 301);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => document.querySelector('a[href="/admin/api/downloadweblog"]').click())]);
    await p.waitForTimeout(500);
    ok('CSV download keeps the session', path(p) === '/admin/' && await keep(p) === 200);
    await p.goto(BASE + '/'); await p.waitForTimeout(500);
    ok('leaving by another address ends the session', await keep(p) === 401);
    await login(p); await p.waitForURL(u => new URL(u).pathname === '/admin/');
    await p.goBack(); await p.waitForTimeout(800);
    ok('Back button ends the session', await keep(p) === 401);
    await login(p); await p.waitForURL(u => new URL(u).pathname === '/admin/');
    await p.reload(); await p.waitForURL('**/admin/login.html', {timeout: 5000}).catch(() => {});
    ok('reload asks for the password', path(p) === '/admin/login.html');
    await p.fill('#password', 'testpw'); await p.click('input[type=submit]');
    await p.waitForURL(u => new URL(u).pathname === '/admin/');
    await p.click('#logout'); await p.waitForURL(u => new URL(u).pathname === '/');
    ok('Exit -> main screen and session ended', path(p) === '/' && await keep(p) === 401);
    await login(p); await p.waitForURL(u => new URL(u).pathname === '/admin/');
    await p.goBack(); await p.waitForTimeout(500); await p.goForward(); await p.waitForTimeout(1000);
    ok('Forward back into Configuration asks for the password', path(p) === '/admin/login.html');
    await p.fill('#password', 'testpw'); await p.click('input[type=submit]');
    await p.waitForURL(u => new URL(u).pathname === '/admin/');
    await p.close({runBeforeUnload: true}); await new Promise(r => setTimeout(r, 800));
    const p3 = await ctx.newPage(); await p3.goto(BASE + '/');
    ok('closing the tab ends the session', await keep(p3) === 401);
  }
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.error(e); process.exit(1); });
