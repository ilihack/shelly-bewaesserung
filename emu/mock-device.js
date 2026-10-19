'use strict';
/*
 * Nachgebauter Shelly mit echter HTTP-Schnittstelle für die Aufspieltests.
 * POST /rpc beantwortet die RPCs, die tools/deploy.js braucht; Script.Start lässt den hochgeladenen
 * Code im Emulator wirklich laufen. GET / liefert eine leere Seite (gleiche Herkunft für den Browserweg).
 * Die Emulator-Zeit läuft mit der echten Zeit mit.
 * Optionen: pass = Gerätepasswort (Digest SHA-256 wie Firmware 2.x, Shelly-Doku General/Authentication;
 *           Shelly.SetAuth setzt es zur Laufzeit neu),
 *           https = http leitet auf https um (selbst signiert, wie ab Firmware 2.0 ab Werk),
 *           cronMs = so oft feuern die Zeitpläne (statt alle 5 min), apOffen = offener Access Point,
 *           updateFehler = das Firmware-Update scheitert, ohneWlan = nur der eigene Access Point, kein Heim-WLAN.
 * state.putFehler = so oft bricht das Hochladen beim 3. Stück ab (im Test zur Laufzeit gesetzt).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { World, berlinToUnixMs, asUtf8 } = require('./shelly-emu');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function startMock(done, opt) {
  opt = opt || {};
  const w = new World({ code: '/* leer */', start: berlinToUnixMs(2026, 10, 19, 15, 0) });
  w.runFor(5000);
  const dev = w.dev;
  const REALM = 'shellyoutdoorsg3-test', NEU = '2.1.0';
  const st = { scripts: [], matter: true, putCount: 0, ver: '1.7.1', ap: opt.apOffen !== false, nonces: {}, authFehler: 0, cron: 0,
    ha1: opt.pass ? sha('admin:' + REALM + ':' + opt.pass) : null };
  function stopScript() {
    dev.scriptGen = (dev.scriptGen || 0) + 1; dev.timers = {}; dev.nTimers = 0; dev.handlers = 0; dev.vcHandles = {}; dev.rpcOpen = 0;
  }
  const handlers = {
    'Shelly.GetDeviceInfo': () => ({ id: REALM, model: 'S3PL-20112EU', gen: 3, app: 'OutdoorPlugSG3', ver: st.ver, auth_en: !!st.ha1, auth_domain: REALM }),
    'Shelly.SetAuth': (p) => {                 // Shelly-Doku: user immer admin, realm = Geräte-ID, ha1 = SHA256(user:realm:pass)
      if (p.user !== 'admin' || p.realm !== REALM || !/^[0-9a-f]{64}$/.test(p.ha1 || '')) throw new Error('bad auth params');
      st.ha1 = p.ha1; st.setAuth = (st.setAuth || 0) + 1; return null;
    },
    'Shelly.CheckForUpdate': () => (st.ver === NEU ? {} : { stable: { version: NEU, build_id: 'test' } }),
    'Shelly.Update': () => {
      if (opt.updateFehler) throw new Error('download failed');
      st.updates = (st.updates || 0) + 1; setTimeout(() => { st.ver = NEU; }, 2000); return null;
    },
    'Matter.GetConfig': () => ({ enable: st.matter }),
    'Matter.SetConfig': (p) => { st.matter = p.config.enable; return { restart_required: false }; },
    'Script.List': () => ({ scripts: st.scripts.map(s => ({ id: s.id, name: s.name, enable: s.enable, running: s.running })) }),
    'Script.Create': (p) => { const s = { id: st.scripts.length + 1, name: p.name, code: '', enable: false, running: false }; st.scripts.push(s); return { id: s.id }; },
    'Script.PutCode': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
      if (s.running) throw new Error('running');
      if (st.putFehler > 0 && p.append && s.code.length >= 2048) { st.putFehler--; throw new Error('connection reset'); }   // Test: Abbruch beim 3. Stück
      s.code = p.append ? s.code + p.code : p.code; st.putCount++;
      return { len: s.code.length };
    },
    'Script.SetConfig': (p) => { Object.assign(st.scripts.find(x => x.id === p.id), p.config); return { restart_required: false }; },
    'Script.Start': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
      if (s.running) return { was_running: true };
      stopScript(); w.code = s.code; w.crashed = null; w.startScript(dev); s.running = true;
      return { was_running: false };
    },
    'Script.Stop': (p) => { const s = st.scripts.find(x => x.id === p.id); stopScript(); s.running = false; return { was_running: true }; },
    'Script.Eval': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
      if (!s.running || !dev.ctx) throw new Error('script not running');
      st.evals = (st.evals || 0) + 1;
      return { result: String(require('vm').runInContext(p.code, dev.ctx)) };
    },
    'Script.GetStatus': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
      const r = { id: s.id, running: s.running && !w.crashed, mem_used: 12000, mem_peak: 14000, mem_free: 60000 };
      if (w.crashed) r.errors = ['crashed'];
      return r;
    },
    'Schedule.List': () => ({ jobs: JSON.parse(JSON.stringify(w.jobs)), rev: w.jobs.length }),
    'Schedule.Update': (p) => { const j = w.jobs.find(x => x.id === p.id); Object.assign(j, p); return { rev: w.jobs.length }; },
    'Switch.GetConfig': () => w.swCfg,
    'Shelly.GetComponents': () => ({ components: Object.keys(w.vc).map(k => ({ key: k, config: w.vc[k].config })), total: Object.keys(w.vc).length }),
    'Text.GetStatus': (p) => ({ value: asUtf8(w.vc['text:' + p.id].value) }),
    'Sys.GetStatus': () => ({ unixtime: Math.floor(w.devUnix()), last_sync_ts: w.dev.syncTs }),
    'WiFi.GetConfig': () => ({ ap: { ssid: REALM, is_open: true, enable: st.ap }, sta: { ssid: 'Garten', enable: true } }),
    'WiFi.SetConfig': (p) => { if (p.config.ap) st.ap = p.config.ap.enable; return { restart_required: false }; },
    'WiFi.GetStatus': () => (opt.ohneWlan ? { sta_ip: null, status: 'disconnected', ap_client_count: 1 } : { sta_ip: '192.168.178.57', status: 'got ip' }),
    'BLE.GetConfig': () => ({ enable: true, rpc: { enable: false } }),
    'HTTP.GET': (p) => ({ code: 200, body: p.url.indexOf('geojs.io') > 0 ? w.ipBody() : w.weatherBody(p.url) })
  };
  function authOk(f) {                       // Firmware 2.x: ha2 = SHA256("POST:/rpc"), nc je nonce streng steigend
    const a = f.auth, n = a && st.nonces[a.nonce];
    if (!a || n === undefined || a.realm !== REALM || a.username !== 'admin' || a.algorithm !== 'SHA-256') return false;
    const nc = parseInt(a.nc, 16);
    if (!(nc > n)) return false;
    const ha2 = sha('POST:/rpc');
    if (a.response !== sha(st.ha1 + ':' + a.nonce + ':' + a.nc + ':' + a.cnonce + ':auth:' + ha2)) return false;
    st.nonces[a.nonce] = nc;
    return true;
  }
  function handle(req, res) {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Shelly (Nachbau)</title><p>Shelly-Nachbau</p>');
      return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const f = JSON.parse(body);
      if (st.ha1 && f.method !== 'Shelly.GetDeviceInfo' && !authOk(f)) {
        if (f.auth) st.authFehler++;
        const nonce = crypto.randomBytes(24).toString('base64');
        st.nonces[nonce] = 0;
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Digest qop="auth", realm="' + REALM + '", nonce="' + nonce + '", algorithm=SHA-256');
        res.end();
        return;
      }
      let out;
      try { out = { id: f.id, result: handlers[f.method](f.params || {}) }; }
      catch (e) { out = { id: f.id, error: { code: -1, message: String(e.message || e) } }; }
      if (body.length > 9000) out = { id: f.id, error: { code: 413, message: 'zu groß' } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  }
  // Zeitpläne: der Wächter feuert im Test alle cronMs statt alle 5 min
  const cron = setInterval(() => {
    for (const j of w.jobs) {
      if (j.enable === false) continue;
      for (const c of j.calls || []) {
        const s = c.params && st.scripts.find(x => x.id === c.params.id);
        if (String(c.method).toLowerCase() === 'script.start' && s && !s.running) { st.cron++; handlers['Script.Start']({ id: s.id }); }
      }
    }
  }, opt.cronMs || 2000);
  const tick = setInterval(() => w.runFor(100), 100);
  const servers = [];
  const fertig = (port, tlsPort) => done({
    port, tlsPort, world: w, state: st,
    close: () => { clearInterval(tick); clearInterval(cron); servers.forEach((x) => x.close()); }
  });
  if (!opt.https) {
    const srv = http.createServer(handle); servers.push(srv);
    srv.listen(0, '127.0.0.1', () => fertig(srv.address().port));
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-tls-'));
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=' + REALM + ' -keyout ' + dir + '/k.pem -out ' + dir + '/c.pem 2>/dev/null');
  const tls = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, handle); servers.push(tls);
  tls.listen(0, '127.0.0.1', () => {
    const tlsPort = tls.address().port;
    const red = http.createServer((req, res) => { res.statusCode = 308; res.setHeader('Location', 'https://127.0.0.1:' + tlsPort + req.url); res.end(); });
    servers.push(red);
    red.listen(0, '127.0.0.1', () => fertig(red.address().port, tlsPort));
  });
}

module.exports = { startMock };
