'use strict';
/*
 * Prüft den Browserweg: build/deploy-browser.js wird in einem echten Chromium auf der Seite des
 * nachgebauten Shelly ausgeführt, so wie beim echten Aufspielen auf http(s)://<ip>/ (mit Firmware-Update und Wächtertest).
 * Aufruf: node emu/browser-deploy-test.js  (braucht Playwright: npm install --no-save playwright && npx playwright install chromium;
 * global installiert: NODE_PATH=$(npm root -g) node emu/browser-deploy-test.js)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startMock } = require('./mock-device');

startMock(async (m) => {
  let browser;
  try {
    const snippet = fs.readFileSync(path.join(__dirname, '..', 'build', 'deploy-browser.js'), 'utf8');
    const code = fs.readFileSync(path.join(__dirname, '..', 'build', 'bewaesserung.min.js'), 'utf8');
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', (msg) => console.log('  [Konsole] ' + msg.text()));
    await page.goto('http://127.0.0.1:' + m.port + '/');
    console.log('  ' + await page.evaluate(snippet));
    await page.waitForFunction(() => window.__bw && window.__bw.fertig, null, { timeout: 180000, polling: 1000 });
    const bw = await page.evaluate(() => window.__bw);
    const r = bw.ergebnis || {};
    const ok = !bw.fehler && r.ok && !m.state.matter && m.state.putCount === Math.ceil(code.length / 1024) &&
      (r.bedienfeld || []).length === 7 && /Bereit|Heute/.test(r.status || '') &&
      m.state.evals === 3 && /^Bewässerung/.test(r.diagnose || '') && m.state.updates === 1 && m.state.ver === '2.1.0' && m.state.ap === false && r.waechter === true &&
      m.world.logs.some((l) => /Selbsttest Wetter: ok/.test(l.msg));
    console.log(ok ? '\nBROWSERWEG: bestanden' : '\nBROWSERWEG: FEHLER ' + JSON.stringify(bw));
    process.exitCode = ok ? 0 : 1;
  } catch (e) { console.log('ABBRUCH ' + e.stack); process.exitCode = 1; }
  if (browser) await browser.close();
  m.close();
});
