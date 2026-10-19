// Minimal-Gerät für den echten Espruino-Interpreter (ES5). Wird vor das Skript gehängt.
// Ablauf: 01.06.2027 09:00 MESZ, Konto 14 mm, Pumpe gelernt 1320 W.
// 10:00 Automatik 14 mm -> 10:20 Brunnen leer -> Schutz -> 11:10 Brunnen wieder voll -> 11:20 Nachlauf
// 18:00 Taster -> Handgabe; 02.06. 10:00 Prüfung. Ausgabe: Zeilen mit "##".
var __W = {
  base: 1811833200,          // 2027-06-01 07:00:00 UTC = 09:00 MESZ
  up: 0, q: [], seq: 0, out: false, tmTok: 0, mode: 'normal', Pn: 1320, onUp: 0,
  storage: {}, writes: 0, vc: {}, cfgWrites: 0,
  cfg: { initial_state: 'restore_last', auto_off: false, auto_off_delay: 60, name: null, power_limit: 2500, current_limit: 12 },
  relay: [], errs: 0, rpcOpen: 0, rpcMax: 0, timers: 0, timersMax: 0, memMax: 0, timer: null,
  jobs: [], led: null, ledWrites: 0
};
__W.storage.s = JSON.stringify({ v: 1, t: __W.base, d: 14, dp: 20969, pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1, fc: 0, rt: 0, rm: 0, lr: '' });
function __at(ms, fn) { __W.q.push({ at: ms, seq: __W.seq++, fn: fn }); }
function __unix() { return __W.base + __W.up / 1000; }
function __setOut(on, src, ta) {
  var was = __W.out;
  __W.out = on; __W.tmTok++; __W.timer = null;
  if (on) {
    var sec = ta ? ta : (__W.cfg.auto_off ? __W.cfg.auto_off_delay : 0);
    if (sec) {
      var tok = __W.tmTok;
      __W.timer = { started: Math.floor(__unix()), dur: sec, type: ta ? 'toggle_after' : 'auto_off' };
      __at(__W.up + sec * 1000, function () { if (tok === __W.tmTok && __W.out) __setOut(false, 'timer', 0); });
    }
    if (!was) __W.onUp = __W.up;
  }
  if (was !== on) __W.relay.push((on ? 'AN ' : 'AUS ') + __hm() + ' ' + src);
}
function __hm() { var t = __unix() + 7200, s = Math.floor(t % 86400); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ' T' + Math.floor(t / 86400); }
function __measure() {
  if (!__W.out) return { P: 0, I: 0 };
  var el = (__W.up - __W.onUp) / 1000, P = __W.Pn;
  if (__W.mode === 'dry') P = __W.Pn * 0.42;
  if (el < 20 && __W.mode === 'normal') P = P * 1.18;
  return { P: P, I: P / (229 * 0.92) };
}
function __ymd(day) {        // Tagesnummer -> YYYY-MM-DD (eigene Rechnung, nur für den Wetterdienst)
  var z = day + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9, y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}
function __wx(url) {
  var past = parseInt(url.split('past_days=')[1], 10) || 0, today = Math.floor((__unix() + 7200) / 86400);
  var dl = { time: [], et0_fao_evapotranspiration: [], precipitation_sum: [], precipitation_probability_max: [], temperature_2m_min: [], temperature_2m_max: [] };
  for (var i = -past; i <= 0; i++) {
    dl.time.push(__ymd(today + i)); dl.et0_fao_evapotranspiration.push(4.0); dl.precipitation_sum.push(0);
    dl.precipitation_probability_max.push(5); dl.temperature_2m_min.push(14); dl.temperature_2m_max.push(24);
  }
  return JSON.stringify({ timezone: 'Europe/Berlin', daily_units: { temperature_2m_min: '\xC2\xB0C' }, daily: dl, current: { interval: 900, temperature_2m: 18 } });
}
function __safe(fn, a, b, c, d) { try { fn(a, b, c, d); } catch (e) { __W.errs++; print('## FEHLER ' + e); } }
var Timer = {
  set: function (ms, rep, cb, ud) {
    __W.timers++; if (__W.timers > __W.timersMax) __W.timersMax = __W.timers;
    var fire = function () { if (rep) __at(__W.up + ms, fire); else __W.timers--; __safe(cb, ud); };
    __at(__W.up + ms, fire); return __W.seq;
  },
  clear: function () { return true; }
};
var Script = { id: 1, storage: {
  getItem: function (k) { return __W.storage.hasOwnProperty(k) ? __W.storage[k] : null; },
  setItem: function (k, v) { if (v.length > 1024) throw new Error('storage > 1024'); __W.storage[k] = v; __W.writes++; }
} };
var Virtual = { getHandle: function (key) {
  if (!__W.vc[key]) return null;
  return {
    getValue: function () { return __W.vc[key].value; },
    setValue: function (v) { __W.vc[key].value = v; },
    getStatus: function () { return __W.vc[key] ? { value: __W.vc[key].value } : undefined; },   // wie die Firmware
    on: function (ev, cb) { __W.vc[key].cb = cb; return 1; },
    off: function (id) { }
  };
} };
var HTTPServer = { registerEndpoint: function (n, cb) { __W.ep = cb; return 'script/1/' + n; } };
var Shelly = {
  getUptimeMs: function () { return __W.up; },
  getDeviceInfo: function () { return { model: 'S3PL-20112EU', gen: 3, ver: '1.7.1', app: 'OutdoorPlugSG3' }; },
  getComponentStatus: function (t, id) {
    if (t === 'sys') return { unixtime: Math.floor(__unix()), uptime: Math.floor(__W.up / 1000) };
    if (t === 'switch') {
      var m = __measure(), st = { id: 0, output: __W.out, apower: m.P, current: m.I, voltage: 229, temperature: { tC: 25 } };
      if (__W.timer) { st.timer_started_at = __W.timer.started; st.timer_duration = __W.timer.dur; }
      return st;
    }
    var c = __W.vc[t + ':' + id]; return c ? { value: c.value } : null;
  },
  getComponentConfig: function (t, id) {
    if (t === 'switch') return JSON.parse(JSON.stringify(__W.cfg));
    if (t === 'plugs_ui') return __W.led ? JSON.parse(JSON.stringify(__W.led)) : null;
    var c = __W.vc[t + ':' + id]; return c ? c.config : null;
  },
  call: function (method, p, cb, ud) {
    var res = null, err = 0, msg = '', lat = 30;
    __W.rpcOpen++; if (__W.rpcOpen > __W.rpcMax) __W.rpcMax = __W.rpcOpen;
    if (method === 'Switch.Set') { __setOut(!!p.on, 'skript', p.on ? p.toggle_after : 0); res = { was_on: true }; }
    else if (method === 'Switch.SetConfig') { for (var k in p.config) __W.cfg[k] = p.config[k]; __W.cfgWrites++; }
    else if (method === 'Virtual.Add') { __W.vc[p.type + ':' + p.id] = { config: p.config, value: p.type === 'group' ? [] : p.config.default_value }; __W.cfgWrites++; res = { id: p.id }; }
    else if (method === 'Group.Set') { __W.vc['group:' + p.id].value = p.value; __W.cfgWrites++; }
    else if (method === 'HTTP.GET') { lat = 400; res = { code: 200, body: p.url.indexOf('geocoding') > 0 ?
      '{"results":[{"name":"Ludwigshafen am Rhein","latitude":49.48121,"longitude":8.44641}]}' :
      __wx(p.url) }; }
    else if (method === 'Sys.SetTime') { }
    else if (method === 'Schedule.List') { res = { jobs: JSON.parse(JSON.stringify(__W.jobs)), rev: __W.jobs.length }; }
    else if (method === 'Schedule.Create') { p.id = __W.jobs.length + 1; __W.jobs.push(p); __W.cfgWrites++; res = { id: p.id }; }
    else if (method === 'Schedule.Update') { for (var q = 0; q < __W.jobs.length; q++) if (__W.jobs[q].id === p.id) { for (var f in p) __W.jobs[q][f] = p[f]; } __W.cfgWrites++; res = {}; }
    else if (method === 'PLUGS_UI.SetConfig') { __W.led = p.config; __W.cfgWrites++; __W.ledWrites++; res = { restart_required: false }; }
    else { err = -114; msg = 'unbekannt ' + method; }
    __at(__W.up + lat, function () { __W.rpcOpen--; if (cb) __safe(cb, res, err, msg, ud); });
  }
};
function __runUntilUp(endMs) {
  for (;;) {
    var bi = -1, i;
    for (i = 0; i < __W.q.length; i++) {
      if (bi < 0 || __W.q[i].at < __W.q[bi].at || (__W.q[i].at === __W.q[bi].at && __W.q[i].seq < __W.q[bi].seq)) bi = i;
    }
    if (bi < 0 || __W.q[bi].at > endMs) { __W.up = endMs; return; }
    var e = __W.q[bi]; __W.q.splice(bi, 1); __W.up = e.at; e.fn();
  }
}
function __memSample() { var m = process.memory(); if (m.usage > __W.memMax) __W.memMax = m.usage; }
// Welt-Ereignisse (Uptime in ms ab 06:00)
__at(80 * 60e3, function () { __W.mode = 'dry'; print('## Brunnen leer ' + __hm()); });
__at(130 * 60e3, function () { __W.mode = 'normal'; print('## Brunnen wieder voll ' + __hm()); });
__at(9 * 3600e3, function () { print('## Taster ' + __hm()); __setOut(!__W.out, 'taster', 0); });
for (var __h = 1; __h <= 26; __h++) __at(__h * 3600e3, __memSample);
