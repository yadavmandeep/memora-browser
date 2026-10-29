/**
 * Selenium (W3C WebDriver) end-to-end verification
 *
 * Runs plain selenium-webdriver code — unchanged from what you'd run on Chrome —
 * against `memora-browser serve --protocol webdriver`, using a local test site.
 */
import http from 'node:http';
import net, { AddressInfo } from 'node:net';
import { Builder, Browser, By, Key, until, WebDriver, error as wdError } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { WebDriverServer } from '../src/webdriver/server.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e?.name}: ${e?.message}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function eq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- test site
const QUOTES = Array.from({ length: 10 }, (_, i) => ({ text: `Quote number ${i + 1}`, author: i === 0 ? 'Albert Einstein' : `Author ${i + 1}` }));
const layout = (title: string, body: string) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const site = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const cookies = req.headers.cookie || '';
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };

  if (url.pathname === '/') {
    const loggedIn = cookies.includes('session=panda');
    return html(layout('Quotes Home', `
      <h1>Quotes to Scrape</h1>
      <div class="header-box">${loggedIn ? '<a href="/logout">Logout</a>' : '<a href="/login">Login</a>'}</div>
      <a href="/js/">JS quotes</a> <a href="/form">Form playground</a>`));
  }
  if (url.pathname === '/login' && req.method === 'GET') {
    return html(layout('Login', `
      <form action="/login" method="post">
        <input type="hidden" name="csrf_token" value="tok123">
        <label for="username">Username</label><input type="text" id="username" name="username">
        <label for="password">Password</label><input type="password" id="password" name="password">
        <input type="submit" value="Login" class="btn">
      </form>`));
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const form = new URLSearchParams(data);
      if (form.get('username') === 'panda' && form.get('password') === 'secret' && form.get('csrf_token') === 'tok123') {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'session=panda; Path=/; HttpOnly' });
        return res.end();
      }
      html(layout('Login', '<p class="error">Invalid credentials</p>'), 200);
    });
    return;
  }
  if (url.pathname === '/logout') {
    return html('', 302, { Location: '/', 'Set-Cookie': 'session=; Max-Age=0; Path=/' });
  }
  if (url.pathname === '/js/') {
    return html(layout('JS Quotes', `
      <div class="container"></div>
      <script>
        var data = ${JSON.stringify(QUOTES)};
        var container = document.querySelector('.container');
        for (var i = 0; i < data.length; i++) {
          var q = document.createElement('div');
          q.className = 'quote';
          q.innerHTML = '<span class="text">' + data[i].text + '</span> <small class="author">' + data[i].author + '</small>';
          container.appendChild(q);
        }
      </script>`));
  }
  if (url.pathname === '/delayed') {
    return html(layout('Delayed', `
      <div id="root"></div>
      <script>
        setTimeout(function () {
          var el = document.createElement('p');
          el.id = 'late';
          el.textContent = 'I arrived late';
          document.getElementById('root').appendChild(el);
        }, 400);
      </script>`));
  }
  if (url.pathname === '/search') {
    return html(layout('Search', `
      <form action="/results" method="get"><input type="text" name="q" id="q"><button type="submit">Go</button></form>`));
  }
  if (url.pathname === '/results') {
    return html(layout('Results', `<h2 id="query">Results for: ${url.searchParams.get('q')}</h2>`));
  }
  if (url.pathname === '/js-redirect') {
    return html(layout('Redirecting', `<script>window.location.href = '/results?q=from-js';</script>`));
  }
  if (url.pathname === '/form') {
    return html(layout('Form Playground', `
      <form id="prefs" action="/echo" method="post">
        <input type="checkbox" id="news" name="news" value="yes">
        <input type="radio" name="plan" id="plan-free" value="free" checked>
        <input type="radio" name="plan" id="plan-pro" value="pro">
        <select id="country" name="country">
          <option value="in">India</option>
          <option value="fr">France</option>
          <option value="us">United States</option>
        </select>
        <textarea id="bio" name="bio">Initial bio</textarea>
        <input type="text" id="disabled-input" disabled value="locked">
        <button type="submit" id="save">Save</button>
      </form>
      <p id="status">idle</p>
      <button id="inline" onclick="document.getElementById('status').textContent = 'inline clicked'">Inline</button>
      <button id="listener">Listener</button>
      <a href="#" id="prevented">Prevented link</a>
      <div id="hidden-box" style="display:none">secret</div>
      <div hidden id="hidden-attr">also secret</div>
      <ul id="items"><li class="item">Alpha</li><li class="item">Beta</li><li class="item">Gamma</li></ul>
      <a href="/form?page=2" id="next">Next page</a>
      <script>
        document.getElementById('listener').addEventListener('click', function () {
          document.getElementById('status').textContent = 'listener clicked';
        });
        document.getElementById('prevented').addEventListener('click', function (e) { e.preventDefault(); });
      </script>`));
  }
  if (url.pathname === '/echo' && req.method === 'POST') {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const form = new URLSearchParams(data);
      html(layout('Echo', `<pre id="echo">${JSON.stringify(Object.fromEntries(form))}</pre>`));
    });
    return;
  }
  html(layout('Not Found', '<h1>404</h1>'), 404);
});

async function newDriver(serverUrl: string, configure?: (o: ChromeOptions) => void): Promise<WebDriver> {
  // Exactly the setup Lightpanda documents: a Remote driver with stock Chrome options
  const options = new ChromeOptions();
  configure?.(options);
  return new Builder().forBrowser(Browser.CHROME).setChromeOptions(options).usingServer(serverUrl).build();
}

async function main() {
  console.log('================================================================');
  console.log('🧪 SELENIUM (W3C WEBDRIVER) VERIFICATION ON MEMORA');
  console.log('================================================================\n');

  const sitePort = await new Promise<number>(r => site.listen(0, '127.0.0.1', () => r((site.address() as AddressInfo).port)));
  const BASE = `http://127.0.0.1:${sitePort}`;
  const wd = new WebDriverServer({ port: 0, host: '127.0.0.1' });
  // port 0 → pick a free port: start then read it back
  await wd.start();
  const wdPort = ((wd as any).server.address() as AddressInfo).port;
  const SERVER = `http://127.0.0.1:${wdPort}`;
  console.log(`  WebDriver server: ${SERVER}   test site: ${BASE}\n`);

  const driver = await newDriver(SERVER);
  try {
    console.log('▶ Lightpanda blog scenario (quotes login + JS-rendered content)');
    await test('test_login: submit form, wait for Logout link', async () => {
      await driver.get(`${BASE}/login`);
      await driver.findElement(By.id('username')).sendKeys('panda');
      await driver.findElement(By.id('password')).sendKeys('secret');
      await driver.findElement(By.css('input[type=submit]')).click();
      const logout = await driver.wait(until.elementLocated(By.linkText('Logout')), 5000);
      eq(await logout.getText(), 'Logout', 'logout text');
      eq(await driver.getCurrentUrl(), `${BASE}/`, 'url after login redirect');
    });
    await test('test_js_rendered_quotes: 10 quotes injected by JavaScript', async () => {
      await driver.get(`${BASE}/js/`);
      const quotes = await driver.wait(until.elementsLocated(By.css('.quote')), 5000);
      eq(quotes.length, 10, 'quote count');
      eq(await driver.findElement(By.css('.quote .author')).getText(), 'Albert Einstein', 'first author');
    });

    console.log('▶ Navigation & page info');
    await test('title, url, back/forward/refresh', async () => {
      await driver.get(`${BASE}/`);
      eq(await driver.getTitle(), 'Quotes Home', 'title');
      await driver.findElement(By.partialLinkText('Form play')).click();
      eq(await driver.getTitle(), 'Form Playground', 'title after link click');
      await driver.navigate().back();
      eq(await driver.getTitle(), 'Quotes Home', 'title after back');
      await driver.navigate().forward();
      eq(await driver.getTitle(), 'Form Playground', 'title after forward');
      await driver.navigate().refresh();
      eq(await driver.getTitle(), 'Form Playground', 'title after refresh');
      assert((await driver.getPageSource()).includes('id="prefs"'), 'page source has form');
    });
    await test('window.location redirect from page script', async () => {
      await driver.get(`${BASE}/js-redirect`);
      eq(await driver.findElement(By.id('query')).getText(), 'Results for: from-js', 'redirect target');
    });

    console.log('▶ Locators');
    await test('css, id, name, class, tag, xpath, link text', async () => {
      await driver.get(`${BASE}/form`);
      eq(await driver.findElement(By.id('save')).getText(), 'Save', 'By.id');
      eq(await driver.findElement(By.name('bio')).getTagName(), 'textarea', 'By.name');
      eq((await driver.findElements(By.className('item'))).length, 3, 'By.className');
      eq((await driver.findElements(By.tagName('li'))).length, 3, 'By.tagName');
      eq(await driver.findElement(By.xpath("//li[text()='Beta']")).getText(), 'Beta', 'xpath text()');
      eq(await driver.findElement(By.xpath("//ul[@id='items']/li[last()]")).getText(), 'Gamma', 'xpath last()');
      eq(await driver.findElement(By.xpath("//button[contains(., 'Inl')]")).getAttribute('id'), 'inline', 'xpath contains');
      eq(await driver.findElement(By.linkText('Next page')).getAttribute('id'), 'next', 'By.linkText');
      const list = await driver.findElement(By.id('items'));
      eq((await list.findElements(By.css('li'))).length, 3, 'nested find');
      eq(await list.findElement(By.xpath('./li[2]')).getText(), 'Beta', 'relative xpath from element');
    });
    await test('missing element raises NoSuchElementError', async () => {
      let caught: unknown;
      try { await driver.findElement(By.id('does-not-exist')); } catch (e) { caught = e; }
      assert(caught instanceof wdError.NoSuchElementError, `expected NoSuchElementError, got ${caught}`);
    });
    await test('invalid selector raises InvalidSelectorError', async () => {
      let caught: unknown;
      try { await driver.findElement(By.xpath('//li[@')); } catch (e) { caught = e; }
      assert(caught instanceof wdError.InvalidSelectorError, `expected InvalidSelectorError, got ${caught}`);
    });

    console.log('▶ Element state & interaction');
    await test('isDisplayed / isEnabled / getAttribute / getCssValue', async () => {
      assert(await driver.findElement(By.id('save')).isDisplayed(), 'save visible');
      assert(!(await driver.findElement(By.id('hidden-box')).isDisplayed()), 'display:none hidden');
      assert(!(await driver.findElement(By.id('hidden-attr')).isDisplayed()), 'hidden attr hidden');
      assert(!(await driver.findElement(By.id('disabled-input')).isEnabled()), 'disabled input');
      eq(await driver.findElement(By.id('disabled-input')).getAttribute('disabled'), 'true', 'boolean attribute');
      eq(await driver.findElement(By.id('next')).getAttribute('href'), `${BASE}/form?page=2`, 'href resolved');
      eq(await driver.findElement(By.id('hidden-box')).getCssValue('display'), 'none', 'css value');
      eq(await driver.findElement(By.id('hidden-box')).getText(), '', 'hidden text is empty');
    });
    await test('inline onclick and addEventListener handlers run on click', async () => {
      await driver.findElement(By.id('inline')).click();
      eq(await driver.findElement(By.id('status')).getText(), 'inline clicked', 'inline handler');
      await driver.findElement(By.id('listener')).click();
      eq(await driver.findElement(By.id('status')).getText(), 'listener clicked', 'listener');
      await driver.findElement(By.id('prevented')).click();
      eq(await driver.getTitle(), 'Form Playground', 'preventDefault keeps page');
    });
    await test('clicking hidden element raises ElementNotInteractableError', async () => {
      let caught: unknown;
      try { await driver.findElement(By.id('hidden-box')).click(); } catch (e) { caught = e; }
      assert(caught instanceof wdError.ElementNotInteractableError, `expected ElementNotInteractableError, got ${caught}`);
    });
    await test('checkbox, radio, select, textarea, then POST form', async () => {
      const news = await driver.findElement(By.id('news'));
      assert(!(await news.isSelected()), 'checkbox starts unchecked');
      await news.click();
      assert(await news.isSelected(), 'checkbox checked');
      await driver.findElement(By.id('plan-pro')).click();
      assert(await driver.findElement(By.id('plan-pro')).isSelected(), 'pro selected');
      assert(!(await driver.findElement(By.id('plan-free')).isSelected()), 'free deselected');
      await driver.findElement(By.css('#country option[value="fr"]')).click();
      eq(await driver.findElement(By.id('country')).getAttribute('value'), 'fr', 'select value');
      const bio = await driver.findElement(By.id('bio'));
      await bio.clear();
      await bio.sendKeys('Hello', Key.BACK_SPACE, 'p!');
      eq(await bio.getAttribute('value'), 'Hellp!', 'textarea after backspace');
      await driver.findElement(By.id('save')).click();
      const echo = JSON.parse(await driver.findElement(By.id('echo')).getText());
      eq(JSON.stringify(echo), JSON.stringify({ news: 'yes', plan: 'pro', country: 'fr', bio: 'Hellp!' }), 'submitted form data');
    });
    await test('Enter key submits a GET form', async () => {
      await driver.get(`${BASE}/search`);
      await driver.findElement(By.id('q')).sendKeys('memora browser', Key.ENTER);
      eq(await driver.findElement(By.id('query')).getText(), 'Results for: memora browser', 'search results');
      assert((await driver.getCurrentUrl()).includes('q=memora+browser'), 'query string');
    });
    await test('Actions API: move + click and keyboard typing', async () => {
      await driver.get(`${BASE}/form`);
      await driver.actions().move({ origin: await driver.findElement(By.id('listener')) }).click().perform();
      eq(await driver.findElement(By.id('status')).getText(), 'listener clicked', 'actions click');
      const bio = await driver.findElement(By.id('bio'));
      await bio.clear();
      await bio.click();
      await driver.actions().sendKeys('typed via actions').perform();
      eq(await bio.getAttribute('value'), 'typed via actions', 'actions keyboard');
    });
    await test('stale element after navigation raises StaleElementReferenceError', async () => {
      const save = await driver.findElement(By.id('save'));
      await driver.get(`${BASE}/`);
      let caught: unknown;
      try { await save.click(); } catch (e) { caught = e; }
      assert(caught instanceof wdError.StaleElementReferenceError, `expected StaleElementReferenceError, got ${caught}`);
    });

    console.log('▶ Waits');
    await test('explicit wait for element added by setTimeout', async () => {
      await driver.get(`${BASE}/delayed`);
      const late = await driver.wait(until.elementLocated(By.id('late')), 3000);
      eq(await late.getText(), 'I arrived late', 'late text');
    });
    await test('implicit wait is honoured', async () => {
      await driver.manage().setTimeouts({ implicit: 2000 });
      await driver.get(`${BASE}/delayed`);
      const t0 = Date.now();
      const late = await driver.findElement(By.id('late'));
      eq(await late.getText(), 'I arrived late', 'late text');
      assert(Date.now() - t0 >= 250, 'waited for the element');
      await driver.manage().setTimeouts({ implicit: 0 });
    });

    console.log('▶ JavaScript execution');
    await test('executeScript with element args and element results', async () => {
      await driver.get(`${BASE}/form`);
      eq(await driver.executeScript('return 1 + 2;'), 3, 'arithmetic');
      eq(await driver.executeScript('return document.title;'), 'Form Playground', 'document.title');
      const items = await driver.executeScript<any[]>('return document.querySelectorAll(".item");');
      eq(items.length, 3, 'element array returned');
      eq(await items[1].getText(), 'Beta', 'returned element usable');
      const el = await driver.findElement(By.id('status'));
      await driver.executeScript('arguments[0].textContent = arguments[1];', el, 'set by script');
      eq(await el.getText(), 'set by script', 'element argument');
      eq(JSON.stringify(await driver.executeScript('return {a: [1, "x", null], b: {c: true}};')), '{"a":[1,"x",null],"b":{"c":true}}', 'object result');
    });
    await test('executeAsyncScript', async () => {
      const v = await driver.executeAsyncScript('var done = arguments[arguments.length - 1]; setTimeout(function () { done("async-ok"); }, 50);');
      eq(v, 'async-ok', 'async result');
    });
    await test('script errors raise JavascriptError', async () => {
      let caught: unknown;
      try { await driver.executeScript('throw new Error("boom")'); } catch (e) { caught = e; }
      assert(caught instanceof wdError.JavascriptError, `expected JavascriptError, got ${caught}`);
    });

    console.log('▶ Cookies, windows, misc');
    await test('cookies: add, get, delete', async () => {
      await driver.get(`${BASE}/`);
      await driver.manage().addCookie({ name: 'flavour', value: 'choc' });
      eq((await driver.manage().getCookie('flavour'))?.value, 'choc', 'get cookie');
      await driver.manage().deleteCookie('flavour');
      eq((await driver.manage().getCookies()).some(c => c.name === 'flavour'), false, 'deleted');
    });
    await test('login session cookie visible to Selenium', async () => {
      await driver.get(`${BASE}/login`);
      await driver.findElement(By.id('username')).sendKeys('panda');
      await driver.findElement(By.id('password')).sendKeys('secret', Key.ENTER);
      eq((await driver.manage().getCookie('session'))?.value, 'panda', 'session cookie');
      await driver.findElement(By.linkText('Logout')).click();
      eq((await driver.manage().getCookies()).some(c => c.name === 'session'), false, 'cookie cleared by Max-Age=0');
    });
    await test('new tab, switch, close', async () => {
      const original = await driver.getWindowHandle();
      await driver.switchTo().newWindow('tab');
      await driver.get(`${BASE}/search`);
      eq(await driver.getTitle(), 'Search', 'new tab title');
      eq((await driver.getAllWindowHandles()).length, 2, 'two handles');
      await driver.close();
      await driver.switchTo().window(original);
      eq(await driver.getTitle(), 'Quotes Home', 'back on original tab');
    });
    await test('screenshot returns PNG data', async () => {
      const png = await driver.takeScreenshot();
      assert(Buffer.from(png, 'base64').subarray(1, 4).toString() === 'PNG', 'png header');
    });
  } finally {
    await driver.quit();
  }

  console.log('▶ Sessions');
  await test('parallel sessions are isolated (cookies)', async () => {
    const [a, b] = await Promise.all([newDriver(SERVER), newDriver(SERVER)]);
    try {
      await Promise.all([a.get(`${BASE}/`), b.get(`${BASE}/`)]);
      await a.manage().addCookie({ name: 'who', value: 'A' });
      eq((await b.manage().getCookies()).some(c => c.name === 'who'), false, 'B does not see A cookie');
    } finally {
      await Promise.all([a.quit(), b.quit()]);
    }
    eq(wd.sessionCount, 0, 'sessions released after quit');
  });

  console.log('▶ Proxy');
  await test('W3C proxy capability routes the session through the proxy', async () => {
    const seen: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, socket: import('node:net').Socket, head) => {
      seen.push(req.url || '');
      const [host, port] = (req.url || '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    });
    const proxyPort = await new Promise<number>(r => proxy.listen(0, '127.0.0.1', () => r((proxy.address() as AddressInfo).port)));
    const { manual } = await import('selenium-webdriver/proxy.js');
    const proxied = await newDriver(SERVER, o => { o.setProxy(manual({ http: `127.0.0.1:${proxyPort}`, https: `127.0.0.1:${proxyPort}` })); });
    try {
      await proxied.get(`${BASE}/`);
      eq(await proxied.getTitle(), 'Quotes Home', 'page through proxy');
      assert(seen.some(t => t === `127.0.0.1:${sitePort}`), `proxy saw ${JSON.stringify(seen)}`);
      const before = seen.length;
      await driver_noproxy_check();
      eq(seen.length, before, 'other sessions stay direct');
    } finally {
      await proxied.quit();
      proxy.closeAllConnections();
      proxy.close();
    }
    async function driver_noproxy_check() {
      const direct = await newDriver(SERVER);
      try { await direct.get(`${BASE}/`); } finally { await direct.quit(); }
    }
  });

  await wd.stop();
  site.close();
  console.log(`\n${failed === 0 ? '✅' : '❌'} Selenium checks: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
