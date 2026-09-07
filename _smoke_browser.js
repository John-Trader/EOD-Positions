// Headless browser smoke test against the local _serve.js (port 8080).
// Loads the page, fails on any console error / uncaught exception, exercises the main UI paths
// with a stubbed fetch/WebSocket so no API key or network is needed.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // Stub network: fake Finnhub REST quotes + a fake WebSocket that emits trades.
  await page.addInitScript(() => {
    localStorage.setItem('finnhub_key', 'test');
    localStorage.setItem('selectedProvider', 'finnhub');
    const quotes = { AAPL: { c: 154.14, h: 154.79, l: 138.09, pc: 150 }, MSFT: { c: 41.46, h: 41.47, l: 39.38, pc: 42 }, BAD: { c: 0, d: null } };
    window.fetch = async (url) => {
      const m = /symbol=([A-Z.\-]+)/.exec(url);
      const q = quotes[m ? m[1] : ''] || { c: 0, d: null };
      return { ok: true, status: 200, json: async () => q };
    };
    class FakeWS {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); this._tick(); }, 20); }
      send() {}
      close() { this.readyState = 3; this.onclose && this.onclose(); }
      _tick() {
        let n = 0;
        this._t = setInterval(() => {
          if (this.readyState !== 1) return clearInterval(this._t);
          n++;
          const p = 154 + (n % 5) * 0.37;
          this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'trade', data: [{ s: 'AAPL', p, v: 100 }] }) });
        }, 60);
      }
    }
    FakeWS.OPEN = 1; window.WebSocket = FakeWS;
    window.__spoken = [];
    window.speechSynthesis = { speak: (u) => window.__spoken.push(u.text), cancel: () => {} };
    window.confirm = () => true; window.alert = () => {};
  });

  await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(500);

  // Fill 3 tickers (one bad) with triggers, calculate, let the stream tick
  await page.fill('.ticker-input[data-idx="0"]', 'AAPL');
  await page.fill('.trigger-input[data-idx="0"]', '154.5');
  await page.fill('.ticker-input[data-idx="1"]', 'MSFT');
  await page.fill('.trigger-input[data-idx="1"]', '40.79');
  await page.fill('.ticker-input[data-idx="2"]', 'BAD');
  await page.click('#calcBtn');
  await page.waitForSelector('#card-AAPL', { timeout: 5000 });
  await page.waitForTimeout(700);

  const cardCount = await page.locator('#resultsContainer [id^="card-"]').count();
  const badErr = await page.locator('#card-BAD').innerText();
  const price = await page.locator('#card-AAPL [data-field="lastPrice"]').innerText();
  const shares = await page.locator('#card-AAPL [data-field="shares"]').innerText();
  const notional = await page.locator('#card-AAPL [data-field="notional"]').innerText();
  const baHidden = await page.locator('#card-AAPL [data-field="bidAskWrap"]').evaluate(el => el.classList.contains('hidden'));
  const rangeHidden = await page.locator('#card-AAPL [data-field="range"]').evaluate(el => el.classList.contains('hidden'));
  const streaming = await page.locator('#calcBtn').innerText();
  const clock = await page.locator('#countdown').innerText();

  // Exit orders modal
  await page.click('#card-AAPL [data-action="open-exit-orders"]');
  await page.waitForTimeout(200);
  const modalVisible = await page.locator('#strategyModalOverlay').isVisible();
  const modalRows = await page.locator('#modalOrdersCardsContainer > div').count();
  await page.keyboard.press('Escape');

  // Table view + focus
  await page.click('#viewToggleBtn');
  await page.waitForTimeout(300);
  const tableRows = await page.locator('#tableWrap > div').count();
  await page.click('#viewToggleBtn');

  // Batch: select + open drawer + close + reopen
  await page.check('#card-AAPL input.trade-check');
  await page.click('text=Export CSV');
  await page.waitForTimeout(200);
  const batchVisible = await page.locator('#batchReviewOverlay').isVisible();
  const previewLines = await page.locator('#batchPreviewBody input').count();
  await page.keyboard.press('Escape');

  // Settings page loads; clear all + undo
  await page.click('button:has-text("CLEAR ALL")');
  await page.waitForTimeout(200);
  const afterClear = await page.locator('.ticker-input[data-idx="0"]').inputValue();
  const toast = await page.locator('#undoToast').isVisible();
  await page.click('#undoToastBtn');
  const afterUndo = await page.locator('.ticker-input[data-idx="0"]').inputValue();

  await page.click('button:has-text("☰")');
  await page.click('#navLinkSettings');
  await page.waitForTimeout(200);
  const settingsVisible = await page.locator('#page-settings').isVisible();
  await page.click('#navLinkTrades');
  await page.waitForTimeout(200);
  const spoken = await page.evaluate(() => window.__spoken);

  await browser.close();

  const report = { cardCount, badErr: badErr.replace(/\s+/g, ' ').trim(), price, shares, notional, baHidden, rangeHidden, streaming, clock, modalVisible, modalRows, tableRows, batchVisible, previewLines, afterClear, toast, afterUndo, settingsVisible, spoken, errors };
  console.log(JSON.stringify(report, null, 1));
  const ok = errors.length === 0 && cardCount === 3 && /Invalid Ticker/.test(badErr) && modalVisible && modalRows >= 1 && tableRows === 2 && batchVisible && previewLines >= 1 && afterClear === '' && toast && afterUndo === 'AAPL' && settingsVisible && baHidden && rangeHidden;
  console.log(ok ? 'BROWSER SMOKE PASSED' : 'BROWSER SMOKE FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('smoke crashed:', e); process.exit(1); });
