'use strict';
/*
 * Nachgebauter Shelly mit echter HTTP-Schnittstelle für die Aufspieltests.
 * POST /rpc beantwortet die RPCs, die tools/deploy.js braucht; Script.Start lässt den hochgeladenen
 * Code im Emulator wirklich laufen. GET / liefert eine leere Seite (gleiche Herkunft für den Browserweg).
 * Die Emulator-Zeit läuft mit der echten Zeit mit.
 */
const http = require('http');
const { World, berlinToUnixMs, asUtf8 } = require('./shelly-emu');

function startMock(done) {
  const w = new World({ code: '/* leer */', start: berlinToUnixMs(2026, 10, 19, 15, 0) });
  w.runFor(5000);
  const dev = w.dev;
  const st = { scripts: [], matter: true, putCount: 0, ver: '1.7.1' };
  function stopScript() {
    dev.scriptGen = (dev.scriptGen || 0) + 1; dev.timers = {}; dev.nTimers = 0; dev.handlers = 0; dev.vcHandles = {}; dev.rpcOpen = 0;
  }
  const handlers = {
    'Shelly.GetDeviceInfo': () => ({ id: 'shellyoutdoorsg3-test', model: 'S3PL-20112EU', gen: 3, app: 'OutdoorPlugSG3', ver: st.ver, auth_en: false }),
    'Shelly.Update': () => { st.ver = '2.0.3'; st.updates = (st.updates || 0) + 1; return null; },
    'Matter.GetConfig': () => ({ enable: st.matter }),
    'Matter.SetConfig': (p) => { st.matter = p.config.enable; return { restart_required: false }; },
    'Script.List': () => ({ scripts: st.scripts.map(s => ({ id: s.id, name: s.name, enable: s.enable, running: s.running })) }),
    'Script.Create': (p) => { const s = { id: st.scripts.length + 1, name: p.name, code: '', enable: false, running: false }; st.scripts.push(s); return { id: s.id }; },
    'Script.PutCode': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
      if (s.running) throw new Error('running');
      s.code = p.append ? s.code + p.code : p.code; st.putCount++;
      return { len: s.code.length };
    },
    'Script.SetConfig': (p) => { Object.assign(st.scripts.find(x => x.id === p.id), p.config); return { restart_required: false }; },
    'Script.Start': (p) => {
      const s = st.scripts.find(x => x.id === p.id);
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
    'Switch.GetConfig': () => w.swCfg,
    'Shelly.GetComponents': () => ({ components: Object.keys(w.vc).map(k => ({ key: k, config: w.vc[k].config })), total: Object.keys(w.vc).length }),
    'Text.GetStatus': (p) => ({ value: asUtf8(w.vc['text:' + p.id].value) }),
    'Sys.GetStatus': () => ({ unixtime: Math.floor(w.devUnix()), last_sync_ts: w.dev.syncTs }),
    'HTTP.GET': (p) => ({ code: 200, body: w.weatherBody(p.url) })
  };
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Shelly (Nachbau)</title><p>Shelly-Nachbau</p>');
      return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const f = JSON.parse(body);
      let out;
      try { out = { id: f.id, result: handlers[f.method](f.params || {}) }; }
      catch (e) { out = { id: f.id, error: { code: -1, message: String(e.message || e) } }; }
      if (body.length > 8000) out = { id: f.id, error: { code: 413, message: 'zu groß' } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  const tick = setInterval(() => w.runFor(100), 100);
  srv.listen(0, '127.0.0.1', () => {
    done({
      port: srv.address().port, world: w, state: st,
      close: () => { clearInterval(tick); srv.close(); }
    });
  });
}

module.exports = { startMock };
