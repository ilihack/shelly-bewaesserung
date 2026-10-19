'use strict';
/*
 * Emulator für das Bewässerungsskript: Shelly Outdoor Plug S Gen3 mit IBO-Tiefbrunnenpumpe.
 * Bildet nach, was das Skript vom Gerät sieht: Relais mit Firmware-Timern, Leistungsmessung,
 * Uhr mit NTP, Sys.SetTime, Stromausfall/Neustart, Script.storage, Virtual Components,
 * HTTP.GET gegen einen Wetterdienst, Taster. Läuft auf virtueller Zeit (Ereignisliste).
 * Zusätzlich prüft er die Firmware-Grenzen: höchstens 5 Timer, 5 offene RPCs, 5 Handler je Skript,
 * Script.storage: Schlüssel <= 16 Byte, Wert <= 1024 Byte, <= 12 Einträge.
 */
const vm = require('vm');
const CFG_RPC = ['Switch.SetConfig', 'Virtual.Add', 'Group.Set', 'PLUGS_UI.SetConfig', 'Schedule.Create', 'Schedule.Update'];
// Gerätefassung schreibt Umlaute als UTF-8-Bytes (\xHH); für Prüfungen wieder als Text lesen
function asUtf8(x) {
  if (typeof x !== 'string' || /[^\x00-\xFF]/.test(x) || !/[\x80-\xFF]/.test(x)) return x;
  const t = Buffer.from(x, 'latin1').toString('utf8');
  return t.includes('\uFFFD') ? x : t;
}

const BERLIN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
function berlinParts(ms) {
  const p = {};
  for (const x of BERLIN.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hh: +p.hour % 24, mm: +p.minute, ss: +p.second,
           y: +p.year, m: +p.month, d: +p.day };
}
function berlinDateAddDays(dateStr, k) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + k * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// Unix-ms für eine Ortszeit in Berlin
function berlinToUnixMs(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm) - 3600000;
  for (let i = 0; i < 3; i++) {
    const p = berlinParts(guess);
    const want = Date.UTC(y, m - 1, d, hh, mm), have = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += want - have;
  }
  return guess;
}

class World {
  constructor(opts) {
    this.code = opts.code;
    this.t = opts.start;                // echte Zeit in ms (UTC)
    let seed = (opts.seed === undefined ? 20261018 : opts.seed) >>> 0;   // Rauschen reproduzierbar (mulberry32)
    this.rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let z = seed; z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61); return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
    this.q = [];                        // Ereignisse {at, seq, fn, dev}
    this.seq = 0;
    this.internet = true;
    this.ntp = true;
    this.storage = {};                  // Script.storage (überlebt Neustarts)
    this.storageWrites = [];            // Zeitpunkte der Schreibvorgänge
    this.vc = {};                       // key -> {type,id,config,value}
    this.cfgWrites = 0;                 // Konfigurationsschreibvorgänge (Switch/VC/Group)
    this.cfgCallT = [];                 // Zeitpunkte aller Versuche, Einstellungen zu schreiben (auch abgelehnte)
    this.swCfg = { id: 0, name: null, in_locked: false, initial_state: 'restore_last', auto_on: false,
      auto_on_delay: 60, auto_off: false, auto_off_delay: 60, power_restore_delay_enable: false,
      power_restore_delay: 60, autorecover_voltage_errors: false, power_limit: 2500, voltage_limit: 280,
      undervoltage_limit: 0, current_limit: 12 };
    this.lastOutput = false;
    // LED-Einstellung (PLUGS_UI), Werkszustand laut Shelly-Doku; jede Änderung ist ein Konfig-Schreibvorgang
    this.plugsUi = { leds: { mode: 'power', colors: { 'switch:0': { on: { rgb: [0, 100, 0], brightness: 100 },
      off: { rgb: [100, 0, 0], brightness: 100 } }, power: { brightness: 100 } },
      night_mode: { enable: false, brightness: 10, active_between: ['22:00', '06:00'] } },
      controls: { 'switch:0': { in_mode: 'momentary' } } };
    this.ledWrites = [];
    this.jobs = [];                     // Gerätezeitpläne (Schedule)
    this.pump = { mode: 'normal', Pn: 1320, noise: 25, onSince: 0, weld: false, fillS: 20 };
    this.weather = opts.weather || (() => ({ et0: 4.0, rain: 0, prob: 5, tmin: 14 }));
    this.forecast = null;               // optional: (dateStr) => {rain, prob, tmin} für "heute"
    // Lufttemperatur: ohne Vorgabe Tagesgang aus tmin (kurz nach Sonnenaufgang) und tmax (15:00) des Wetters
    this.ambient = opts.ambient || null;
    // Gerätefühler: Luft + Eigenwärme + Relaiswärme (nähert sich bei AN 8 K, Zeitkonstante 20 min) + Rauschen
    this.selfHeat = opts.selfHeat === undefined ? 14 : opts.selfHeat;
    this.relayHeat = 8; this.rh = 0; this.rhT = opts.start;
    this.logs = [];
    this.relay = [];                    // {t, on, src}
    this.http = [];
    this.errors = [];                   // Emulator-/Grenzverletzungen
    this.crashed = null;
    this.dev = null;
    this.bootCount = 0;
    this.verbose = !!opts.verbose;
    this.noHttpServer = !!opts.noHttpServer;
    this.limits = { timers: 0, rpc: 0, handlers: 0 };
    this.boot(0);
  }

  // ---------- Zeit und Ereignisse ----------
  at(t, fn, dev) { this.q.push({ at: t, seq: this.seq++, fn, dev: dev || null }); }
  after(ms, fn, dev) { this.at(this.t + ms, fn, dev); }
  run(until) {
    for (;;) {
      if (this.q.length === 0) { this.t = until; return; }
      let bi = 0;
      for (let i = 1; i < this.q.length; i++) {
        const a = this.q[i], b = this.q[bi];
        if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) bi = i;
      }
      const e = this.q[bi];
      if (e.at > until) { this.t = until; return; }
      this.q.splice(bi, 1);
      this.t = e.at;
      if (e.dev && e.dev !== this.dev) continue;     // Gerät inzwischen neu gestartet
      e.fn();
    }
  }
  runFor(ms) { this.run(this.t + ms); }
  local() { return berlinParts(this.t); }

  // ---------- Gerät ----------
  boot(delayMs) {
    const w = this;
    const start = () => {
      w.bootCount++;
      const dev = { bootAt: w.t, timers: {}, nTimers: 0, rpcOpen: 0, handlers: 0, output: false,
        timer: null, src: 'init', errors: [], clockBase: null, clockUp: 0, ntpSynced: false, syncTs: null,
        vcHandles: {}, endpoints: {}, ctx: null, scriptRunning: false };
      w.dev = dev;
      // Anfangszustand Relais
      let on = false;
      if (w.swCfg.initial_state === 'on') on = true;
      if (w.swCfg.initial_state === 'restore_last') on = w.lastOutput;
      if (on) w.setOutput(true, 'init', null);
      // Nicht persistente VC-Werte zurücksetzen
      for (const k of Object.keys(w.vc)) {
        const c = w.vc[k];
        if (c.type !== 'group' && c.type !== 'button' && !c.config.persisted) c.value = c.config.default_value;
      }
      // NTP-Versuche
      w.ntpLoop(dev, 15000);
      // Skript startet einige Sekunden nach dem Hochfahren
      w.after(3000, () => w.startScript(dev), dev);
    };
    if (delayMs) this.after(delayMs, start); else start();
  }
  ntpLoop(dev, firstMs) {
    this.after(firstMs, () => {
      if (this.ntp && this.internet && !dev.ntpSynced) {
        dev.ntpSynced = true; dev.syncTs = Math.floor(this.t / 1000);   // last_sync_ts: nur der Zeitserver setzt es
        dev.clockBase = this.t; dev.clockUp = this.uptime(dev);   // Uhr springt auf echte Zeit
      }
      this.ntpLoop(dev, 60000);
    }, dev);
  }
  uptime(dev) { return this.t - (dev || this.dev).bootAt; }
  devUnix(dev) {
    dev = dev || this.dev;
    if (dev.clockBase === null) return null;
    return (dev.clockBase + (this.uptime(dev) - dev.clockUp)) / 1000;
  }
  powerFail(durMs) {
    if (!this.dev) return;
    this.lastOutput = this.dev.output;
    this.logEvt('STROMAUSFALL ' + Math.round(durMs / 60000) + ' min');
    if (this.dev.output) this.relay.push({ t: this.t, on: false, src: 'power' });
    this.dev = null;
    this.boot(durMs);
  }
  logEvt(msg) { this.logs.push({ t: this.t, msg: '## ' + msg }); if (this.verbose) console.log(this.fmt(this.t), '##', msg); }
  fmt(t) { const p = berlinParts(t); return `${p.date} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}:${String(p.ss).padStart(2, '0')}`; }

  // ---------- Relais ----------
  setOutput(on, src, toggleAfter) {
    const dev = this.dev;
    if (!dev) return;
    this.rhUpdate();
    const was = dev.output;
    dev.output = on; dev.src = src;
    if (dev.timer) { dev.timer.cancelled = true; dev.timer = null; }
    if (on) {
      let sec = null, type = null;
      if (toggleAfter) { sec = toggleAfter; type = 'toggle_after'; }
      else if (this.swCfg.auto_off) { sec = this.swCfg.auto_off_delay; type = 'auto_off'; }
      if (sec) {
        const tm = { started: this.devUnix(dev), dur: sec, type, cancelled: false };
        dev.timer = tm;
        this.after(sec * 1000, () => { if (!tm.cancelled && dev.output) this.setOutput(false, 'timer', null); }, dev);
      }
      if (!was) { this.pump.onSince = this.t; dev.errors = []; }
      if (!was && this.pump.mode === 'anlauf') {   // Überstromschutz löst schon beim Anlauf aus, binnen 0,4 s
        this.after(400, () => { if (dev.output) { this.setOutput(false, 'overcurrent', null); dev.errors = ['overcurrent']; } }, dev);
      }
    } else if (was && this.swCfg.auto_on) {          // Firmware "auto_on": nach jedem Aus wieder ein
      this.after(this.swCfg.auto_on_delay * 1000, () => { if (this.dev === dev && !dev.output && this.swCfg.auto_on) this.setOutput(true, 'auto_on', null); }, dev);
    }
    if (was !== on) this.relay.push({ t: this.t, on, src });
    this.lastOutput = on;
  }
  press() { if (this.dev) this.setOutput(!this.dev.output, 'button', null); }

  // ---------- Pumpenmodell ----------
  measure() {
    const dev = this.dev, p = this.pump;
    const conducting = dev.output || p.weld;
    if (!conducting) return { P: 0, I: 0, U: 231 };
    const el = (this.t - p.onSince) / 1000;
    const nz = () => (this.rand() * 2 - 1) * p.noise;
    let P, I, U = 229;
    switch (p.mode) {
      case 'normal': P = p.Pn + nz(); break;
      case 'dry': P = p.Pn * 0.42 + nz(); break;
      case 'airmix': P = (this.rand() < 0.55 ? p.Pn * 0.45 : p.Pn * 0.9) + nz(); break;
      case 'closed': P = p.Pn * 0.62 + nz(); break;
      case 'blocked': P = 3300; I = 26; break;
      case 'noload': P = 0; I = 0; break;
      case 'burst': P = p.Pn * 1.4 + nz(); break;
      default: P = p.Pn;
    }
    if (p.mode !== 'blocked' && p.mode !== 'noload' && el < p.fillS) P = P * 1.18; // Leitung füllt sich
    if (el < 0.5 && p.mode !== 'noload') { I = 24; }                             // Anlaufstrom (kurz)
    if (I === undefined) I = P / (U * 0.92);
    return { P: Math.max(0, P), I, U };
  }
  firmwareProtect() {                   // Firmware-Grenzen (Werkseinstellung 2500 W / 12 A)
    const dev = this.dev; if (!dev || !dev.output) return;
    const m = this.measure();
    const el = (this.t - this.pump.onSince) / 1000;
    if (el < 1) return;                  // Messung mittelt; Anlaufspitze sieht sie nicht
    if (m.I > this.swCfg.current_limit) { this.setOutput(false, 'overcurrent', null); dev.errors = ['overcurrent']; }
    else if (m.P > this.swCfg.power_limit) { this.setOutput(false, 'overpower', null); dev.errors = ['overpower']; }
  }

  // ---------- Skript ----------
  startScript(dev) {
    const w = this;
    const ctx = {
      print: (...a) => { const msg = asUtf8(a.join(' ')); w.logs.push({ t: w.t, msg }); if (w.verbose) console.log(w.fmt(w.t), msg); },
      JSON, Math, Date, parseInt, parseFloat, isNaN, Object, Array, String, Number
    };
    ctx.console = { log: ctx.print };
    const gen = dev.scriptGen || 0;
    const guard = (fn) => function () {
      if (w.dev !== dev || w.crashed || (dev.scriptGen || 0) !== gen) return;
      try { return fn.apply(null, arguments); }
      catch (e) { w.crashed = { t: w.t, err: String(e && e.stack || e) }; w.logEvt('SKRIPT ABGESTÜRZT: ' + e); dev.scriptRunning = false; }
    };
    ctx.Timer = {
      set(ms, rep, cb, ud) {
        if (dev.nTimers >= 5) throw new Error('Timer-Limit 5 überschritten');
        const id = ++w.seq; dev.nTimers++; w.limits.timers = Math.max(w.limits.timers, dev.nTimers);
        const tm = { id, ms, rep, cb, ud, live: true };
        dev.timers[id] = tm;
        const fire = () => {
          if (!tm.live || (dev.scriptGen || 0) !== gen) return;
          if (!tm.rep) { tm.live = false; delete dev.timers[id]; dev.nTimers--; }
          else w.after(ms, fire, dev);
          guard(() => cb(ud))();
          if (tm.rep) w.firmwareProtect();
        };
        w.after(ms, fire, dev);
        return id;
      },
      clear(id) { const tm = dev.timers[id]; if (!tm) return false; tm.live = false; delete dev.timers[id]; dev.nTimers--; return true; }
    };
    ctx.Script = {
      id: 1,
      storage: {
        getItem(k) { return Object.prototype.hasOwnProperty.call(w.storage, k) ? w.storage[k] : null; },
        setItem(k, v) {
          if (typeof v !== 'string') throw new Error('storage: nur Strings');
          if (Buffer.byteLength(k) > 16) throw new Error('storage: Schlüssel > 16 Byte');
          if (Buffer.byteLength(v) > 1024) throw new Error('storage: Wert > 1024 Byte (' + Buffer.byteLength(v) + ')');
          if (!(k in w.storage) && Object.keys(w.storage).length >= 12) throw new Error('storage: > 12 Einträge');
          w.storage[k] = v; w.storageWrites.push(w.t);
        },
        removeItem(k) { delete w.storage[k]; },
        get length() { return Object.keys(w.storage).length; },
        key(i) { return Object.keys(w.storage)[i]; }
      }
    };
    const handle = (key) => {
      if (!w.vc[key]) return null;
      if (w.handleFail > 0) { w.handleFail--; return null; }   // Test: Handle noch nicht da (frisch angelegt)
      if (dev.vcHandles[key]) return dev.vcHandles[key];
      const h = {
        listeners: {},
        getValue() { const c = w.vc[key]; return c ? c.value : undefined; },
        setValue(v) { const c = w.vc[key]; if (!c) throw new Error('VC fehlt'); if (c.type === 'button' || c.type === 'group') throw new Error('setValue nicht erlaubt');
          if (c.type === 'text') { const b = Buffer.byteLength(asUtf8(v), 'utf8'); w.maxText = Math.max(w.maxText || 0, b); if (b > (c.config.max_len || 255)) throw new Error('Text zu lang: ' + b + ' Byte'); }
          c.value = v; },
        getConfig() { const c = w.vc[key]; return c ? JSON.parse(JSON.stringify(c.config)) : undefined; },
        setConfig(cfg) { Object.assign(w.vc[key].config, cfg); w.cfgWrites++; },
        getStatus() { const c = w.vc[key]; return c ? { value: c.value } : undefined; },
        on(ev, cb) { dev.handlers++; w.limits.handlers = Math.max(w.limits.handlers, dev.handlers); if (dev.handlers > 5) throw new Error('Handler-Limit');
          const id = ++w.seq, f = guard(cb); f.id = id; (this.listeners[ev] = this.listeners[ev] || []).push(f); return id; },
        off(id) { for (const ev of Object.keys(this.listeners)) { const n = this.listeners[ev].length;
          this.listeners[ev] = this.listeners[ev].filter(f => f.id !== id); if (this.listeners[ev].length < n) dev.handlers--; } }
      };
      dev.vcHandles[key] = h;
      return h;
    };
    ctx.Virtual = { getHandle: handle };
    if (!w.noHttpServer) ctx.HTTPServer = {   // Diagnose-Seite: http://<IP>/script/1/<name> (w.noHttpServer: alte Firmware)
      registerEndpoint(name, cb, ud) {
        if (typeof name !== 'string' || typeof cb !== 'function') throw new Error('registerEndpoint: Parameter');
        if (Object.keys(dev.endpoints).length >= 5 && !dev.endpoints[name]) throw new Error('registerEndpoint: höchstens 5');
        dev.endpoints[name] = { cb: guard(cb), ud };
        return '/script/1/' + name;
      }
    };
    ctx.Shelly = {
      getUptimeMs: () => w.uptime(dev),
      getDeviceInfo: () => ({ id: 'shellyoutdoorsg3-e4b063f0a1b2', mac: 'E4B063F0A1B2', model: 'S3PL-20112EU', gen: 3,
        fw_id: '20250924-062729/1.7.1-gd336f31', ver: w.fwVer || '1.7.1', app: 'OutdoorPlugSG3', auth_en: false }),
      getComponentStatus(type, id) {
        if (type === 'sys') {
          const u = w.devUnix(dev);
          return { unixtime: u === null ? null : Math.floor(u), last_sync_ts: dev.syncTs, uptime: Math.floor(w.uptime(dev) / 1000) };
        }
        if (type === 'switch' && id === 0) {
          const m = w.measure();
          const st = { id: 0, source: dev.src, output: dev.output, apower: Math.round(m.P * 10) / 10,
            voltage: m.U, current: Math.round(m.I * 1000) / 1000, freq: 50 };
          Object.defineProperty(st, 'temperature', { enumerable: true, get: () => ({ tC: w.devTemp() }) });  // nur bei Bedarf rechnen
          if (dev.timer) { st.timer_started_at = dev.timer.started; st.timer_duration = dev.timer.dur; st.timer_type = dev.timer.type; }
          if (dev.errors.length) st.errors = dev.errors.slice();
          return st;
        }
        if (type === 'group') { const c = w.vc['group:' + id]; return c ? { value: c.value } : null; }
        const c = w.vc[type + ':' + id]; return c ? { value: c.value } : null;
      },
      getComponentConfig(type, id) {
        if (type === 'switch') return JSON.parse(JSON.stringify(w.swCfg));
        if (type === 'plugs_ui') return JSON.parse(JSON.stringify(w.plugsUi));
        const c = w.vc[type + ':' + id]; return c ? Object.assign({ id }, JSON.parse(JSON.stringify(c.config))) : null;
      },
      call(method, params, cb, ud) {
        if (w.throwOnce === method) { w.throwOnce = null; throw new Error('Too many calls in progress'); }   // Test
        if (dev.rpcOpen >= 5) throw new Error('RPC-Limit 5 überschritten (' + method + ')');
        dev.rpcOpen++; w.limits.rpc = Math.max(w.limits.rpc, dev.rpcOpen);
        let res = null, err = 0, msg = '', lat = 30, post = null;
        if (CFG_RPC.indexOf(method) >= 0) w.cfgCallT.push(w.t);   // Einstellungen schreiben (Flash): jeder Versuch zählt
        try {
          switch (method) {
            case 'Switch.Set': {
              if (params.on && w.switchRefuse > 0) { w.switchRefuse--; err = -103; msg = 'overtemperature'; break; }   // Test
              w.setOutput(!!params.on, 'loopback', params.on ? params.toggle_after : null);
              res = { was_on: true }; break;
            }
            case 'Switch.SetConfig': {
              for (const k of Object.keys(params.config)) {
                if (!(k in w.swCfg)) { err = -103; msg = 'unknown key ' + k; }
              }
              if (!err) { Object.assign(w.swCfg, params.config); w.cfgWrites++; res = { restart_required: false }; }
              break;
            }
            case 'Sys.SetTime': {             // wirkt erst, wenn der Aufruf durch ist (wie ein echter RPC);
              post = () => {                  // w.setTimeIgnored: Firmware, die eine gestellte Zeit nicht als unixtime meldet
                if (!dev.ntpSynced && !w.setTimeIgnored) { dev.clockBase = params.unixtime * 1000; dev.clockUp = w.uptime(dev); }
              };
              res = null; break;
            }
            case 'Virtual.Add': {
              const key = params.type + ':' + params.id;
              if (w.vc[key]) { err = -103; msg = 'exists'; break; }
              if (Object.keys(w.vc).length >= 10) { err = -103; msg = 'limit'; break; }
              const cfg = params.config || {};
              w.vc[key] = { type: params.type, id: params.id, config: JSON.parse(JSON.stringify(cfg)),
                value: params.type === 'group' ? [] : cfg.default_value };
              w.cfgWrites++; res = { id: params.id }; break;
            }
            case 'Group.Set': { const c = w.vc['group:' + params.id]; if (!c) { err = -105; msg = 'no group'; break; } c.value = params.value.slice(); w.cfgWrites++; res = null; break; }
            case 'PLUGS_UI.SetConfig': {
              const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = a[k] || {}; merge(a[k], b[k]); } else a[k] = b[k]; } };
              merge(w.plugsUi, JSON.parse(JSON.stringify(params.config)));
              w.cfgWrites++; w.ledWrites.push(w.t); res = { restart_required: false }; break;
            }
            case 'Schedule.List': { res = { jobs: JSON.parse(JSON.stringify(w.jobs)), rev: w.jobs.length }; break; }
            case 'Schedule.Create': {
              if (w.jobs.length >= 20) { err = -103; msg = 'limit'; break; }
              const job = Object.assign({ id: w.jobs.length + 1 }, JSON.parse(JSON.stringify(params)));
              w.jobs.push(job); w.cfgWrites++; res = { id: job.id, rev: w.jobs.length }; break;
            }
            case 'Schedule.Update': {
              const job = w.jobs.find((x) => x.id === params.id);
              if (!job) { err = -105; msg = 'no such job'; break; }
              if (w.scheduleUpdateIgnored) { res = { rev: w.jobs.length }; break; }   // Test: Firmware nimmt es an, ändert nichts
              Object.assign(job, JSON.parse(JSON.stringify(params))); w.cfgWrites++; res = { rev: w.jobs.length }; break;
            }
            case 'HTTP.GET': {
              lat = w.httpLat ? w.httpLat(params.url) : 400;   // Test: Antworten in anderer Reihenfolge
              w.http.push({ t: w.t, url: params.url });
              if (!w.internet || w.httpFail) { err = -1; msg = 'Failed to connect'; lat = (params.timeout || 10) * 1000; break; }
              const code = w.httpCode ? w.httpCode(params.url) : 200;      // Test: der Dienst antwortet mit einem Fehler
              res = { code, message: code === 200 ? 'OK' : 'Service Unavailable', headers: w.httpDate === false ? {} : { date: new Date(w.t + 300).toUTCString() },   // Serverzeit
                body: code !== 200 ? '' : params.url.indexOf('geocoding-api') > 0 ? w.geoBody(params.url) : w.weatherBody(params.url) };
              break;
            }
            default: err = -114; msg = 'Method ' + method + ' not found';
          }
        } catch (e) { err = -1; msg = String(e); }
        w.after(lat, () => { dev.rpcOpen--; if (post) post(); if (cb) guard(cb)(res, err, msg, ud); }, dev);
      },
      emitEvent() {}
    };
    vm.createContext(ctx);
    dev.ctx = ctx; dev.scriptRunning = true;
    try { vm.runInContext(w.code, ctx, { filename: 'bewaesserung.js' }); }
    catch (e) { w.crashed = { t: w.t, err: String(e && e.stack || e) }; w.logEvt('SKRIPT ABGESTÜRZT beim Start: ' + e); }
  }
  restartScript() {                     // Skript neu starten (z. B. Update), Relais und Timer der Firmware bleiben
    const dev = this.dev;
    dev.scriptGen = (dev.scriptGen || 0) + 1;
    dev.timers = {}; dev.nTimers = 0; dev.handlers = 0; dev.vcHandles = {}; dev.endpoints = {}; dev.rpcOpen = 0;
    this.after(1000, () => this.startScript(dev), dev);
  }
  stopScript() {                        // Skript bleibt stehen (Absturz o. ä.), Gerät läuft weiter
    const dev = this.dev;
    dev.scriptGen = (dev.scriptGen || 0) + 1;
    dev.timers = {}; dev.nTimers = 0; dev.handlers = 0; dev.vcHandles = {}; dev.endpoints = {}; dev.rpcOpen = 0; dev.scriptRunning = false;
    this.logEvt('SKRIPT STEHT');
  }
  fireSchedules() {                     // Gerätezeitplan ausführen (nur Script.Start wird nachgebildet)
    for (const j of this.jobs) {
      if (j.enable === false) continue;
      for (const c of j.calls || []) {
        if (String(c.method).toLowerCase() === 'script.start' && this.dev && !this.dev.scriptRunning) {
          this.logEvt('ZEITPLAN startet Skript'); this.restartScript(); this.dev.scriptRunning = true;
        }
      }
    }
  }
  pressVcButton(key) {
    const h = this.dev && this.dev.vcHandles[key];
    if (h && h.listeners.single_push) for (const f of h.listeners.single_push) f({ source: 'ui' });
  }
  setVc(key, v) { if (this.vc[key]) this.vc[key].value = v; }

  // ---------- Temperatur ----------
  wxDay(ds) {
    const x = this.weather(ds) || {};
    const tmin = x.tmin == null ? 10 : x.tmin;
    return { tmin, tmax: x.tmax == null ? tmin + 10 : x.tmax };
  }
  sunriseLocalMin(ds) {                  // Sonnenaufgang Ortszeit in Minuten (NOAA, eigene Rechnung des Emulators)
    this.srCache = this.srCache || {};
    if (this.srCache[ds] !== undefined) return this.srCache[ds];
    const [y, m, d] = ds.split('-').map(Number);
    const n = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000;
    const g = 2 * Math.PI / 365 * n, lat = 49.48 * Math.PI / 180;
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const de = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g);
    const ha = Math.acos(Math.cos(90.833 * Math.PI / 180) / (Math.cos(lat) * Math.cos(de)) - Math.tan(lat) * Math.tan(de)) * 180 / Math.PI;
    const utcMin = 720 - 4 * (8.45 + ha) - eq;
    const off = (berlinToUnixMs(y, m, d, 12, 0) - Date.UTC(y, m - 1, d, 12, 0)) / -60000;
    return (this.srCache[ds] = utcMin + off);
  }
  ambientAt(t) {                         // Tief 15 min nach Sonnenaufgang, Hoch 15:00; tagsüber Sinus, nachts Kosinus
    if (this.ambient) return this.ambient(t);
    const p = berlinParts(t), ds = p.date, mins = p.hh * 60 + p.mm + p.ss / 60, MX = 900;
    const w0 = this.wxDay(ds), sr = this.sunriseLocalMin(ds) + 15;
    if (mins >= sr && mins < MX) return w0.tmin + (w0.tmax - w0.tmin) * Math.sin(Math.PI / 2 * (mins - sr) / (MX - sr));
    if (mins >= MX) {
      const nx = berlinDateAddDays(ds, 1), w1 = this.wxDay(nx), sr1 = this.sunriseLocalMin(nx) + 15;
      const x = (mins - MX) / (1440 - MX + sr1);
      return w1.tmin + (w0.tmax - w1.tmin) * (1 + Math.cos(Math.PI * x)) / 2;
    }
    const pv = this.wxDay(berlinDateAddDays(ds, -1)), x = (1440 - MX + mins) / (1440 - MX + sr);
    return w0.tmin + (pv.tmax - w0.tmin) * (1 + Math.cos(Math.PI * x)) / 2;
  }
  rhUpdate() {                           // Relaiswärme bis jetzt fortschreiben (mit dem bisherigen Schaltzustand)
    const dt = Math.max(0, (this.t - this.rhT) / 1000), target = this.dev && this.dev.output ? this.relayHeat : 0;
    this.rh = target + (this.rh - target) * Math.exp(-dt / 1200); this.rhT = this.t;
  }
  devTemp() {
    this.rhUpdate();
    return Math.round((this.ambientAt(this.t) + this.selfHeat + this.rh + (this.rand() * 0.4 - 0.2)) * 10) / 10;
  }

  eval(code) { return require('vm').runInContext(code, this.dev.ctx); }   // wie Script.Eval
  endpoint(name, query) {               // wie GET http://<IP>/script/1/<name>: Antwort des Skripts
    const ep = this.dev && this.dev.endpoints[name];
    if (!ep) return { code: 404, body: '' };
    const out = { code: 0, body: '', headers: [], sent: false };
    const res = { send() { out.code = res.code || 200; out.body = asUtf8(String(res.body || '')); out.headers = res.headers || []; out.sent = true; return true; } };
    ep.cb({ method: 'GET', query: query || '', headers: [], body: '' }, res, ep.ud);
    return out;
  }

  // ---------- Ortssuche (Open-Meteo-Geocoding): bekannte Orte, sonst leere Antwort wie beim echten Dienst ----------
  geoBody(url) {
    const q = Object.fromEntries(new URL(url).searchParams);
    const orte = this.orte || { 'DE|Ludwigshafen am Rhein': [49.48121, 8.44641], 'DE|München': [48.13743, 11.57549] };
    const k = q.countryCode + '|' + q.name, p = orte[k];
    return JSON.stringify(p ? { results: [{ name: q.name, latitude: p[0], longitude: p[1], country_code: q.countryCode }] } : { generationtime_ms: 0.1 });
  }

  // ---------- Wetterdienst (Open-Meteo-Format) ----------
  weatherBody(url) {
    const q = Object.fromEntries(new URL(url).searchParams);
    const past = +q.past_days || 0;
    const today = berlinParts(this.t).date;
    const daily = { time: [], et0_fao_evapotranspiration: [], precipitation_sum: [], precipitation_probability_max: [], temperature_2m_min: [], temperature_2m_max: [] };
    for (let i = -past; i <= 0; i++) {
      const ds = berlinDateAddDays(today, i);
      let x = this.weather(ds);
      if (i === 0 && this.forecast) x = Object.assign({}, x, this.forecast(ds));
      daily.time.push(ds);
      daily.et0_fao_evapotranspiration.push(x.et0);
      daily.precipitation_sum.push(x.rain);
      daily.precipitation_probability_max.push(x.prob);
      daily.temperature_2m_min.push(x.tmin);
      daily.temperature_2m_max.push(this.wxDay(ds).tmax);
    }
    const o = { latitude: +q.latitude, longitude: +q.longitude, timezone: 'Europe/Berlin',
      daily_units: { time: 'iso8601', et0_fao_evapotranspiration: 'mm', precipitation_sum: 'mm', precipitation_probability_max: '%', temperature_2m_min: '°C', temperature_2m_max: '°C' },
      daily };
    if (/temperature_2m/.test(q.current || '')) {   // aktuelle Lufttemperatur (Open-Meteo: 15-min-Modellwerte)
      const p = berlinParts(this.t);
      o.current = { time: p.date + 'T' + String(p.hh).padStart(2, '0') + ':' + String(p.mm - p.mm % 15).padStart(2, '0'), interval: 900,
        temperature_2m: this.currentTemp ? this.currentTemp(this.t) : Math.round(this.ambientAt(this.t) * 10) / 10 };
    }
    return JSON.stringify(o);
  }

  // ---------- Auswertung ----------
  script() { return this.dev && this.dev.ctx; }
  state() { const s = this.storage.s; return s ? JSON.parse(s) : null; }
  vcText() { return this.vc['text:200'] ? asUtf8(this.vc['text:200'].value) : null; }
  runs() {                               // Ein-Aus-Paare aus dem Relaisprotokoll
    const out = []; let cur = null;
    for (const r of this.relay) {
      if (r.on && !cur) cur = { on: r.t, src: r.src };
      else if (!r.on && cur) { cur.off = r.t; cur.min = (r.t - cur.on) / 60000; cur.offSrc = r.src; out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }
}

module.exports = { asUtf8, World, berlinParts, berlinToUnixMs, berlinDateAddDays };
