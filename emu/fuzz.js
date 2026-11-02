'use strict';
/*
 * Fuzzer: das Skript bekommt an jeder Schnittstelle zufällige und feindliche Eingaben, Welt für Welt (1 bis 4 Tage), und
 * nach jeder Welt werden die Regeln geprüft, die immer gelten müssen. Je Seed gleiches Ergebnis.
 * Aufruf: node emu/fuzz.js [skript] [welten] [seed]         (Standard: src/bewaesserung.js 200 20261102)
 *   FUZZ_WELT=n     nur Welt n, mit Plan, Eingriffen und allen Meldungen des Skripts (Befund nachstellen)
 *   FUZZ_OHNE=a,b   diese Kanäle ruhig lassen (Befund eingrenzen); FUZZ_JOBS=n Prozesse (Standard: Kerne, höchstens 4)
 *   FUZZ_ALLE=1 jeden Verstoß einzeln, FUZZ_EINGRIFFE=1 alle Eingriffsarten mit Anzahl, FUZZ_MELDUNGEN=1 alle Meldungen (normiert)
 *   Abdeckung: NODE_V8_COVERAGE=<ordner> node emu/fuzz.js, danach node tools/abdeckung.js <ordner>
 * Kanäle (umhüllt über den Haken w.fuzz des Emulators; je Welt Stufe 0 ruhig bis 3 feindlich):
 *   wx, geo  HTTP.GET Wetter / Ortssuche: Fehlercodes, -1, keine Antwort, Ausnahme, späte und doppelte Antworten, Code nicht 200,
 *            kein JSON, leer, abgeschnitten, riesig, body_b64; JSON ohne Schlüssel, null, Texte statt Zahlen, negativ, riesig,
 *            gebrochen, unendlich, falsche Längen, falsche und verschobene Daten, ohne current; Ortssuche ohne Treffer/lat/lon
 *   rpc      jeder andere Shelly.call: Fehler mit und ohne Wirkung, Rückruf kommt nie, Ausnahme, verspätet, doppelt, Unsinn,
 *            belegter RPC-Platz; Switch.Set ohne Wirkung oder ohne Timer; Schedule.List mit kaputten jobs/calls/params
 *   sw       getComponentStatus("switch", 0): apower/current null, NaN, negativ, riesig, Text; Temperatur fehlt/null/Unsinn;
 *            Timer-Felder; errors; Status null; output gelogen (unmöglich, selten)
 *   sys      getComponentStatus("sys"): unixtime null/0/vor 2026/ferne Zukunft/ms/versetzt/springt; last_sync_ts; null
 *   cfg      getComponentConfig switch/plugs_ui/Bedienfeld/Gruppe, getDeviceInfo; grp Gruppenstatus
 *   vc       Virtual.getHandle null/wirft, getValue falscher Typ/außerhalb, getStatus undefined/wirft/fehlt, setValue/on wirft;
 *            Bedienfeld in der App gelöscht, Werte geändert, Knopf „neu einlernen“
 *   store    Script.storage: s und f fehlen, abgeschnitten, falscher Typ, falsche Feldtypen, riesige/negative Zahlen, lange Texte,
 *            fremde Felder; getItem/setItem werfen, Schreiben geht verloren; Speicher kaputt vor einem Neustart
 *   ev       Taster (auch Anlern-Geste nach dem Einstecken, Drücke im Anlernen, Salven), App, Stromausfälle (auch Flackern),
 *            Skript-Neustart und -Stopp (der Wächter startet neu), Diagnose-Seite abrufen, Unsinn im Status-Abo
 *   clock    Zeitserver/Internet/Wetterdienst weg und zurück, Uhr springt (fremdes Stellen, Zeitserver korrigiert)
 *   pump     Trockenlauf, Hahn zu, blockiert, Luft, ohne Last, Überstrom beim Anlauf, Überdruck, Relais klebt; Pumpe je Welt anders
 * Zeiträume: Saison, Zeitumstellung, Saisongrenzen Feb/Mär und Nov/Dez, Winter, Jahreswechsel, ferne Jahre, 2100, vor 2026.
 * Regeln (pruefen(), je Verstoß Welt, Seed, Zeit und beteiligte Eingriffe; „unmöglich“ = Eingabe, die die Firmware nie liefert):
 *   kein Absturz, Firmware-Grenzen (Timer, RPC, Handler); Lauf höchstens 120 min ab eigenem Start oder Übernahme, höchstens
 *   130 min ab (letztem) Einschalten, wenn die Notabschaltung eingestellt war; nach einer Schutzabschaltung binnen 10 s aus,
 *   oder bei verlorenen Aus-Befehlen alle 5 s nachgeschickt; Speicher je Eintrag <= 1024 Byte; Schreibbremse (1 je Minute,
 *   je 24-h-Fenster der Bremse 72, gleitend 120); LED <= 12 Wechsel in 24 h je Skriptlauf (außer Rot, Anlernen); Einstellungen
 *   <= 30 je 24-h-Fenster der Bremse (gleitend 60), Relais-Sicherung höchstens stündlich; Statustext Text und <= 255 Byte;
 *   Diagnose-Seite antwortet 200 oder 500 und ändert S nicht; Automatik bei richtiger Uhr nur 10:00–12:30, nicht bei
 *   Automatik aus, nicht Dez–Feb; Felder in R und S bleiben kurz; Zustand gültig (R.run.pf/ps/ref, S-Zahlen endlich, Konto 0..25 mm); Script.Eval("selfTest()") wirft nicht.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const { World, berlinParts, berlinToUnixMs } = require('./shelly-emu');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'bewaesserung.js'));
const N = Math.max(1, +(process.argv[3] || 200));
const SEED = (+(process.argv[4] || 20261102)) >>> 0;
const CODE = fs.readFileSync(FILE, 'utf8');
const NUR = process.env.FUZZ_WELT ? +process.env.FUZZ_WELT : 0;
const OHNE = new Set((process.env.FUZZ_OHNE || '').split(',').map((x) => x.trim()).filter(Boolean));
const H = 3600e3, M = 60e3, D = 86400e3, T_MIN = 1767225600;
const KANAELE = ['wx', 'geo', 'rpc', 'sw', 'sys', 'cfg', 'grp', 'vc', 'store', 'ev', 'clock', 'pump'];
const WD_SPEC = '0 */5 * * * *', UP_SPEC = '0 23 3 * * *';

// ============================== Zufall (je Kanal ein eigener Strom: Abschalten eines Kanals ändert die anderen nicht) ======
function mulberry(a) {
  a >>>= 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash32() {
  let h = 0x811c9dc5;
  for (let k = 0; k < arguments.length; k++) {
    const s = String(arguments[k]);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x2c; h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
class Rnd {
  constructor(seed) { this.f = mulberry(seed); }
  u() { return this.f(); }
  i(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
  p(x) { return this.f() < x; }
  pick(a) { return a[Math.floor(this.f() * a.length)]; }
  w(o) { let s = 0; for (const k in o) s += o[k]; let x = this.f() * s; for (const k in o) { x -= o[k]; if (x < 0) return k; } return Object.keys(o)[0]; }
  lg(a, b) { return Math.exp(Math.log(a) + this.f() * (Math.log(b) - Math.log(a))); }
  n(rate) { let n = 0, p = this.f(); const L = Math.exp(-rate); while (p > L && n < 500) { n++; p *= this.f(); } return n; }   // Poisson
}

// ============================== kleine Helfer ==============================
const r1 = (x) => Math.round(x * 10) / 10;
const dayNo = (ms) => { const p = berlinParts(ms); return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / D); };
const fmt = (ms) => { const p = berlinParts(ms); return p.date + ' ' + String(p.hh).padStart(2, '0') + ':' + String(p.mm).padStart(2, '0') + ':' + String(p.ss).padStart(2, '0'); };
const norm = (m) => String(m).replace(/^\[BW\] /, '').replace(/\d+([.,]\d+)?/g, '#').slice(0, 170);
function espLen(v) {                      // Länge, wie der Emulator sie für Script.storage zählt (Espruino: \u00XX je Byte)
  let n = v.length;
  for (const c of v) if (c.charCodeAt(0) > 127) n += 6 * Buffer.byteLength(c) - 1;
  return n;
}
function utf8Bytes(v) {                    // wie der Emulator Text misst (Gerätefassung: Bytes als Zeichen)
  if (typeof v !== 'string') return -1;
  let x = v;
  if (!/[^\x00-\xFF]/.test(x) && /[\x80-\xFF]/.test(x)) { const t = Buffer.from(x, 'latin1').toString('utf8'); if (!t.includes('�')) x = t; }
  return Buffer.byteLength(x, 'utf8');
}
function lastSunday(y, m) { const l = new Date(Date.UTC(y, m, 0)); return l.getUTCDate() - l.getUTCDay(); }
const UNSINN = [null, undefined, NaN, '1320', '', -50, -1e9, 1e9, Infinity, -Infinity, 0, 1e-7, 12345.678, true, {}, [], [1]];
const MSGS = ['Failed to connect', 'Deadline exceeded', 'Too many calls in progress', 'Invalid argument', 'Not found',
  'Resource exhausted', 'overtemperature', '', undefined, 42, 'x'.repeat(300), 'Fehler: ä€ \u0000 "quote"', null];
const CODES = [-1, -104, -103, -105, -108, -109, -114, 408, 500, 1, 'Fehler', -0.5];

// ============================== Wetter und Lufttemperatur der Welt ==============================
function makeWeather(ws) {
  const cache = {};
  const klima = new Rnd(hash32(ws, 'klima')).w({ trocken: 35, nass: 20, frost: 15, kalt: 10, heiss: 15, kipp: 5 });
  const ET = [0.6, 0.9, 1.6, 2.6, 3.5, 4.5, 4.4, 3.8, 2.4, 1.1, 0.5, 0.5], TB = [-2, -1, 2, 5, 9, 12, 14, 13, 10, 6, 2, 0];
  return (ds) => {
    let x = cache[ds];
    if (x) return x;
    const r = new Rnd(hash32(ws, 'wx', ds)), m = +ds.slice(5, 7);
    let tmin = TB[m - 1] + r.u() * 8, rain = 0, et0 = ET[m - 1] * (0.4 + r.u() * 1.4);
    if (klima === 'frost' && r.p(0.6)) tmin = -7 + r.u() * 11;
    if (klima === 'kalt') tmin -= 5;
    if (klima === 'heiss') { tmin += 5; et0 *= 1.6; }
    if (klima === 'kipp' && r.p(0.6)) tmin = 3 + r.u() * 3;   // um die Frostschwelle
    if ((klima === 'nass' && r.p(0.6)) || r.p(0.2)) rain = r.u() * (r.p(0.15) ? 40 : 18);
    const prob = rain > 0 ? (r.p(0.75) ? r.i(55, 100) : r.i(0, 60)) : (r.p(0.8) ? r.i(0, 40) : r.i(40, 100));   // Prognose passt meist
    x = cache[ds] = { et0: r1(et0), rain: r1(rain), prob, tmin: r1(tmin), tmax: r1(tmin + 3 + r.u() * 15) };
    return x;
  };
}
function makeAmbient(weather) {            // Tagesgang wie im Emulator (Tief nach Sonnenaufgang, Hoch 15:00), je Minute gerechnet
  let lastK = NaN, lastV = 0;
  const offC = new Map(), ds = (ms) => new Date(ms).toISOString().slice(0, 10);
  const off = (t) => { const k = Math.floor(t / D); let o = offC.get(k); if (o === undefined) { const p = berlinParts(k * D + 12 * H); o = (p.hh - 12 + 24) % 24; offC.set(k, o); } return o; };
  return (t) => {
    const k = Math.floor(t / M);
    if (k === lastK) return lastV;
    lastK = k;
    const o = off(t) * H, lt = t + o, day = Math.floor(lt / D), mins = (lt - day * D) / M;
    const doy = day - Math.floor(Date.UTC(new Date(day * D).getUTCFullYear(), 0, 1) / D);
    const sr = 330 + 110 * Math.cos(2 * Math.PI * (doy + 10) / 365) + o / M + 15, MX = 900, w0 = weather(ds(day * D));
    if (mins >= sr && mins < MX) lastV = w0.tmin + (w0.tmax - w0.tmin) * Math.sin(Math.PI / 2 * (mins - sr) / (MX - sr));
    else if (mins >= MX) { const w1 = weather(ds((day + 1) * D)), x = (mins - MX) / (1440 - MX + sr); lastV = w1.tmin + (w0.tmax - w1.tmin) * (1 + Math.cos(Math.PI * x)) / 2; }
    else { const pv = weather(ds((day - 1) * D)), x = (1440 - MX + mins) / (1440 - MX + sr); lastV = w0.tmin + (pv.tmax - w0.tmin) * (1 + Math.cos(Math.PI * x)) / 2; }
    return lastV;
  };
}

// ============================== Anfangszustand: Speicher, Bedienfeld, Zeitpläne, Einstellungen ==============================
const S_ZAHL = ['t', 'd', 'dp', 'pi', 'ev', 'pn', 'pc', 'kt', 'pu', 'fd', 'fc', 'rt', 'rm', 'rq', 'xa', 'xd', 'ob', 'oa', 'df', 'rd', 'rx',
  'rc', 'rk', 'rf', 'tu', 'ce', 'cs', 'fu', 'fo', 's0', 'sa', 'sh', 'sm', 'sf', 'io', 'id', 'os', 'wu', 'wn', 'wb', 'la', 'lo'];
function sGueltig(r, start, lvClock) {     // plausibler gespeicherter Zustand, mit Randfällen
  const now = Math.floor(start / 1000), day = dayNo(start);
  const s = { v: 1, t: now - r.i(0, 6 * 3600), tu: r.i(0, 2e6), d: r1(r.p(0.7) ? 10 + r.u() * 15 : r.u() * 10), dp: day - r.pick([1, 1, 1, 1, 2, 3, 0, 15]),
    pi: r.p(0.7) ? 0 : r1(r.u() * 15), ev: r.pick([-1, day - 1, day - 1, day, day - 2]), pn: r.p(0.5) ? 0 : r.i(400, 1900), pc: 0, kt: 0,
    pu: r.p(0.85) ? 0 : day + r.i(-2, 14), fd: r.pick([-1, day, day - 1]), fc: r.i(0, 3), rt: 0, rm: 0, rq: 0, lr: '', xa: -1, xe: [], xw: [],
    xd: 0, ob: -99, oa: -99, df: 0, rd: -1, rx: 0, rc: -1, rk: 0, rf: 0, ce: 0, cs: 0, fu: 0, ft: '', fo: 0, s0: day - r.i(0, 200),
    sa: r.i(0, 50), sh: r.i(0, 20), sm: r1(r.u() * 300), sf: r.i(0, 5), io: 0, id: 0, os: 0, wu: 0, wn: 0, wb: 0,
    la: 49.48, lo: 8.45, pz: 'DELudwigshafen am Rhein' };
  if (s.pn && r.p(0.6)) { s.pc = r.p(0.7) ? Math.round(s.pn * (0.4 + r.u() * 0.5)) : 0; s.kt = r.p(0.9) ? now - r.i(0, 1e7) : 1; }
  if (r.p(0.15)) { s.rt = now + r.i(-3600, 7200); s.rm = r1(2 + r.u() * 10); s.fd = day; s.rq = r.p(0.5) ? r.i(300, 1500) : 0; }
  if (r.p(0.15)) { s.rc = day; s.rk = r.pick([1, 2, 3]); s.rf = r1(r.u() * 6 - 2); s.ev = day; }
  if (r.p(0.1)) { s.rd = day - r.i(0, 1); s.rx = r1(r.u() * 10); }
  if (r.p(lvClock ? 0.3 : 0.08)) { s.ce = 1; s.cs = s.t; s.df = r.p(0.3) ? 1 : 0; }
  if (r.p(lvClock ? 0.25 : 0.03)) s.t = now + r.i(600, 5 * 3600);          // Zeitanker vor der echten Zeit
  if (r.p(0.1)) s.t = now - r.i(1, 40) * 86400;
  if (r.p(0.1)) s.t = 0;
  if (r.p(0.15)) { s.os = r.p(0.5) ? 1 : now - r.i(60, 3 * 86400); }
  if (r.p(0.15)) { s.io = now - r.i(3600, 9 * 86400); s.id = r.i(1, 5000); }
  if (r.p(0.2)) { s.fo = 1; s.fu = r.p(0.8) ? now - r.i(0, 3 * 86400) : 1; s.ft = r.pick(['Trockenlauf oder Hahn zu (512 W < 990 W)', 'Firmware-Schutz: overcurrent', 'Einschalten abgelehnt: overtemperature']); }
  if (r.p(0.2)) { const k = r.i(1, 14); s.xa = day - k - 1; s.xd = r1(r.u() * 20); for (let j = 0; j < k; j++) { s.xe.push(r1(r.u() * 4)); s.xw.push(r.p(0.8) ? 0 : r1(r.u() * 12)); } s.dp = day - 1; }
  if (r.p(0.3)) { s.ob = r1(r.u() * 20); s.oa = r1(r.u() * 15); }
  if (r.p(0.15)) { delete s.la; delete s.lo; delete s.pz; } else if (r.p(0.05)) s.pz = 'DEMünchen';
  if (r.p(0.3)) { s.wu = r.i(0, 2e6); s.wn = r.i(0, 80); s.wb = r.i(0, 2e6); }
  if (r.p(0.6)) s.lr = r.pick(['01.06. 10:00 Automatik 12,9 mm', '31.05. 18:20 Hand 6,0 mm – abgebrochen', '02.06. 11:05 Nachlauf 3,1 mm']);
  if (r.p(0.12)) for (const k of ['fo', 'wu', 'wn', 'wb', 'os', 'io', 'id', 's0', 'sa', 'sh', 'sm', 'sf', 'ob', 'oa', 'rd', 'rx', 'rc', 'rk', 'rf', 'ce', 'cs', 'xa', 'xe', 'xw', 'xd', 'kt', 'pc', 'tu'])
    if (r.p(0.6)) delete s[k];             // ältere Fassung des Skripts: neuere Felder fehlen (fo fehlt bei offener Störung)
  return s;
}
function sFeindlich(r, s) {                // kaputter Speicherinhalt; null = Eintrag fehlt
  const k = r.w({ feld: 40, ganz: 10, version: 4, text: 8, abgeschnitten: 10, muell: 3, doppelt: 3, fremd: 8, felder: 10, fehlt: 4 });
  const ziel = () => r.pick(Object.keys(s));
  if (k === 'fehlt') return null;
  if (k === 'ganz') return r.pick(['[]', '[1,2,3]', '5', '"text"', 'null', 'true', '{}', '""', '-1', '1e400']);
  if (k === 'version') { if (r.p(0.5)) delete s.v; else s.v = r.pick([2, 0, '1', null, true]); }
  const n = r.i(1, 5);
  for (let j = 0; j < n && (k === 'feld' || k === 'felder' || j === 0); j++) {
    const f = ziel(), m = r.w({ typ: 40, zahl: 35, weg: 15, lang: 10 });
    if (m === 'typ') s[f] = r.pick(['x', '', '12', [], [1, 2], {}, { a: 1 }, true, false, null, { length: 3 }]);
    else if (m === 'zahl') s[f] = r.pick([-1, -1e9, 1e9, 1e308, 0.5, 1e-9, 9007199254740993, -0.0001, 'UNENDLICH', 'MINUSUNENDLICH']);
    else if (m === 'weg') delete s[f];
    else s[f] = 'y'.repeat(r.i(50, 500));
  }
  if (k === 'text') s[r.pick(['lr', 'ft', 'pz'])] = r.pick(['é', 'Ã¤', 'z']).repeat(r.i(100, 600));
  if (k === 'fremd') { const m = r.i(1, 6); for (let j = 0; j < m; j++) s['alt' + j] = r.pick([1, 'abc', [1, 2, 3], { x: 1 }, 'q'.repeat(r.i(10, 300))]); }
  if (r.p(0.15)) { s.xe = r.pick(['abc', { length: 2 }, [null, 'x'], new Array(r.i(15, 200)).fill(1)]); s.xw = r.p(0.5) ? s.xe : []; if (r.p(0.7)) s.xa = (s.dp || 0) - 2; }
  if (r.p(0.08)) { s.fo = 1; s.fu = s.t || 1; s.ft = 'Trockenlauf ' + 'z'.repeat(r.i(180, 400)); }   // langer Störungstext von heute
  let txt = JSON.stringify(s).replace('"UNENDLICH"', '1e400').replace('"MINUSUNENDLICH"', '-1e400');
  if (k === 'abgeschnitten') txt = txt.slice(0, r.i(1, Math.max(1, txt.length - 1)));
  if (k === 'muell') { let b = ''; const m = r.i(1, 300); for (let j = 0; j < m; j++) b += String.fromCharCode(r.i(0, 255)); txt = b; }
  if (k === 'doppelt') txt = JSON.stringify(txt);
  return txt;
}
function fGueltig(r, start) {
  const a = [], n = r.i(0, 5), now = Math.floor(start / 1000);
  for (let j = 0; j < n; j++) a.push(String(now - r.i(0, 1e6)) + r.pick([' ', '~']) + r.pick(['unterlast:512 W < 990 W', 'fw:overcurrent', 'ab:overtemperature', 'rk:400 W', 'ka:Hahn nicht zugedreh']));
  return JSON.stringify(a);
}
function fFeindlich(r) {
  return r.pick(['[1,2,3]', '[null]', '"abc"', '{"length":2}', '{}', '5', '[', '[{"a":1}]', JSON.stringify(new Array(r.i(6, 60)).fill('1767225600 x:y')),
    JSON.stringify(['0000000000 ' + 'z'.repeat(r.i(100, 900))]), '[""]', '["1"]', '["abc"]', 'null']);
}
function vcAnfang(r, lv) {                // Bedienfeld, wie das Skript es anlegt, mit Abweichungen
  const vc = {}, add = (type, id, config, value) => { vc[type + ':' + id] = { type, id, config, value }; };
  const art = lv >= 2 ? r.w({ keins: 30, ganz: 35, teil: 15, schraeg: 20 }) : r.w({ keins: 45, ganz: 50, teil: 5 });
  if (art === 'keins') return vc;
  add('text', 200, { name: 'Status', default_value: '', persisted: false, max_len: 255 }, '');
  add('number', 200, { name: 'Wasserdefizit', default_value: 0, persisted: false, min: 0, max: 25 }, 0);
  add('boolean', 200, { name: 'Automatik', default_value: true, persisted: true }, r.p(0.92));
  add('number', 201, { name: 'Pause', default_value: 0, persisted: false, min: 0, max: 14 }, 0);
  add('number', 202, { name: 'Regenrate', default_value: 8.6, persisted: true, min: 1, max: 40 }, r.p(0.7) ? 8.6 : r1(1 + r.u() * 39));
  add('button', 200, { name: 'Pumpe neu einlernen' }, undefined);
  add('group', 200, { name: 'Bewässerung' }, ['text:200', 'number:200', 'boolean:200', 'number:201', 'number:202', 'button:200']);
  if (art === 'teil') { const ks = Object.keys(vc); for (let j = r.i(1, 3); j > 0; j--) delete vc[r.pick(ks)]; }
  if (art === 'schraeg') {
    if (vc['boolean:200'] && r.p(0.5)) vc['boolean:200'].value = r.pick(['true', 1, 0, null, 'false', undefined]);
    if (vc['number:202'] && r.p(0.5)) vc['number:202'].value = r.pick(['8.6', -5, 0, 1000, NaN, null, 0.5, 40.0001]);
    if (vc['group:200'] && r.p(0.5)) vc['group:200'].value = r.pick([null, 'x', [], ['text:200'], ['button:200', 'number:202', 'number:201', 'boolean:200', 'number:200', 'text:200'], ['text:200', 'number:200', 'boolean:200', 'number:201', 'number:202', 'button:200', 'number:203']]);
    if (r.p(0.3)) for (let j = 0; Object.keys(vc).length < 10; j++) add('number', 210 + j, { name: 'fremd', default_value: 0, persisted: true }, 0);   // Grenze 10
  }
  return vc;
}
function jobsAnfang(r, lv) {
  const wd = (o) => Object.assign({ id: 1, enable: true, timespec: WD_SPEC, calls: [{ method: 'Script.Start', params: { id: 1 } }] }, o || {});
  const up = { id: 2, enable: true, timespec: UP_SPEC, calls: [{ method: 'Shelly.Update', params: { stage: 'stable' } }] };
  const art = r.w(lv >= 2 ? { keine: 35, richtig: 30, schraeg: 35 } : { keine: 50, richtig: 45, schraeg: 5 });
  if (art === 'keine') return [];
  if (art === 'richtig') return r.p(0.7) ? [wd(), up] : [wd()];
  const v = r.i(0, 4);
  if (v === 0) return [wd({ enable: false }), up];
  if (v === 1) return [wd({ timespec: '0 */10 * * * *' })];
  if (v === 2) return [wd({ calls: [{ method: 'Script.Start', params: { id: 2 } }] })];
  if (v === 3) { const a = []; for (let j = 1; j <= 20; j++) a.push({ id: j, enable: true, timespec: '0 0 ' + (j % 24) + ' * * *', calls: [{ method: 'Switch.Toggle', params: { id: 0 } }] }); return a; }
  return [wd({ id: 7, calls: [{ method: 'script.start', params: { id: 1 } }, { method: 'shelly.update', params: {} }] })];
}

// ============================== Plan einer Welt ==============================
const RATE = {                             // Ereignisse je Tag nach Stufe 0..3
  press: [0.5, 3, 8, 30], salve: [0, 0.3, 1, 4], app: [0.2, 1, 4, 15], pf: [0.1, 0.6, 2, 6], flackern: [0, 0.2, 0.6, 2],
  restart: [0.1, 0.6, 2, 8], stop: [0, 0.2, 0.6, 2], vcset: [0.5, 1.5, 4, 12], vcbtn: [0, 0.2, 0.6, 2], vcdel: [0, 0.2, 0.8, 3],
  kaputt: [0, 0.1, 0.5, 1.5], ntp: [0, 1, 3, 8], net: [0, 1, 3, 8], httpfail: [0, 1, 2, 6], uhr: [0, 0.5, 2, 6],
  mode: [0.3, 1.5, 4, 12], weld: [0, 0, 0.2, 0.8], info: [3, 4, 8, 20],
  sw: [0, 1.5, 5, 16], sys: [0, 0.8, 3, 10], cfg: [0, 0.8, 3, 10], grp: [0, 0.5, 2, 6], vc: [0, 0.8, 3, 10], store: [0, 0.3, 1.5, 5], rpc: [0, 0.5, 2, 6]
};
function plan(i) {
  const ws = hash32(SEED, 'welt', i), R = (n) => new Rnd(hash32(ws, n)), g = R('plan');
  const prof = g.w({ ruhig: 25, gemischt: 50, fokus: 15, sturm: 10 }), lv = {};
  for (const c of KANAELE) {
    if (prof === 'ruhig') lv[c] = g.p(0.7) ? 0 : 1;
    else if (prof === 'gemischt') lv[c] = +g.w({ 0: 30, 1: 35, 2: 25, 3: 10 });
    else if (prof === 'sturm') lv[c] = g.p(0.5) ? 2 : 3;
    else lv[c] = g.p(0.75) ? 0 : 1;
  }
  if (prof === 'fokus') { lv[g.pick(KANAELE)] = 3; if (g.p(0.5)) lv[g.pick(KANAELE)] = g.p(0.5) ? 2 : 3; }
  for (const c of OHNE) if (c in lv) lv[c] = 0;
  // Zeitraum
  const kat = g.w({ saison: 44, dst: 12, grenze: 14, winter: 6, neujahr: 4, fern: 6, j2100: 2, vor2026: 2 });
  let y = g.i(2027, 2029), mo = g.i(3, 11), d = g.i(1, 28);
  if (kat === 'dst') { y = g.i(2027, 2030); mo = g.p(0.5) ? 3 : 10; d = lastSunday(y, mo) - g.i(0, 1); }
  else if (kat === 'grenze') { if (g.p(0.5)) { mo = 2; d = g.i(26, 28); } else { mo = 11; d = g.i(28, 30); } }
  else if (kat === 'winter') { mo = g.pick([12, 1, 2]); }
  else if (kat === 'neujahr') { mo = 12; d = g.i(30, 31); }
  else if (kat === 'fern') { y = g.i(2031, 2045); }
  else if (kat === 'j2100') { y = 2100; mo = 2; d = g.i(26, 28); }
  else if (kat === 'vor2026') { y = 2025; mo = 12; d = g.i(30, 31); }
  const tod = g.w({ gleich: 50, morgen: 15, mittag: 10, nacht: 15, kurzvor: 5, kurzvorEnde: 5 });
  let min = g.i(0, 1439);
  if (tod === 'morgen') min = g.i(570, 620); else if (tod === 'mittag') min = g.i(730, 765); else if (tod === 'kurzvorEnde') min = g.i(744, 749);
  else if (tod === 'nacht') min = (g.i(1410, 1470)) % 1440; else if (tod === 'kurzvor') min = g.i(597, 600);
  const start = berlinToUnixMs(y, mo, d, Math.floor(min / 60), min % 60) + g.i(0, 59) * 1000;
  const tage = +g.w({ 1: 40, 2: 30, 3: 18, 4: 12 }), ende = start + tage * D;
  const weather = makeWeather(ws);
  const netz = lv.clock ? g.w({ online: 55, offline: 25, wackelig: 20 }) : g.w({ online: 75, offline: 25 });
  // Gerät vor dem ersten Start
  const rs = R('store0'), rv = R('vc0'), rc = R('cfg0'), rp = R('pump0');
  let s = null, f = null, sObj = null;
  const sArt = rs.w(lv.store >= 2 ? { frisch: 15, gueltig: 30, feindlich: 55 } : lv.store === 1 ? { frisch: 20, gueltig: 65, feindlich: 15 } : { frisch: 20, gueltig: 80 });
  if (sArt !== 'frisch') {
    sObj = sGueltig(rs, start, lv.clock);
    s = sArt === 'feindlich' ? sFeindlich(rs, sObj) : JSON.stringify(sObj);
    f = sArt === 'feindlich' && rs.p(0.5) ? fFeindlich(rs) : (rs.p(0.6) ? fGueltig(rs, start) : null);
  }
  const fremdeEintraege = lv.store >= 2 && rs.p(0.1) ? rs.i(1, 11) : 0;
  const swCfg = {}, swArt = rc.w(lv.cfg >= 2 ? { werk: 35, gesetzt: 35, schraeg: 30 } : { werk: 50, gesetzt: 47, schraeg: 3 });
  if (swArt === 'gesetzt') Object.assign(swCfg, { initial_state: 'off', auto_off: true, auto_off_delay: 7800, name: 'Brunnenpumpe' });
  if (swArt === 'schraeg') Object.assign(swCfg, rc.pick([{ auto_on: true, auto_on_delay: rc.i(1, 120) }, { auto_off: true, auto_off_delay: rc.i(5, 600) },
    { initial_state: 'on' }, { initial_state: 'restore_last' }, { autorecover_voltage_errors: true }, { power_limit: rc.i(300, 2500) }, { current_limit: rc.i(1, 12) }]));
  const plugsArt = rc.w(lv.cfg >= 2 ? { werk: 50, gesetzt: 25, schraeg: 25 } : { werk: 60, gesetzt: 40 });
  let plugsUi = null;
  if (plugsArt !== 'werk') plugsUi = { leds: { mode: plugsArt === 'gesetzt' ? 'switch' : rc.pick(['off', 'power', 'switch']), colors: { 'switch:0': {
    on: { rgb: [0, 0, 100], brightness: plugsArt === 'gesetzt' ? 100 : rc.pick([100, 50, '100']) },
    off: { rgb: rc.pick([[0, 100, 0], [100, 70, 0], [100, 0, 0], [100, 100, 100], 'rot']), brightness: 100 } }, power: { brightness: 100 } },
    night_mode: { enable: false, brightness: 10, active_between: ['22:00', '06:00'] } }, controls: { 'switch:0': { in_mode: 'momentary' } } };
  const pump = lv.pump ? { Pn: rp.pick([450, 700, 1000, 1320, 1320, 1600, 1900, 2300]), noise: rp.pick([5, 25, 25, 60, 120]),
    closedRel: r1(0.45 + rp.u() * 0.5), fillS: rp.i(0, 60) } : {};
  const r0 = R('ev0');
  const P = { i, ws, prof, lv, kat, start, ende, tage, weather, ambient: makeAmbient(weather), netz, emuSeed: hash32(ws, 'emu'),
    s, f, sArt, sObj, fremdeEintraege, vc: vcAnfang(rv, lv.vc), jobs: jobsAnfang(rc, lv.cfg), swCfg, swArt, plugsUi, pump,
    selfHeat: lv.pump ? rp.i(4, 22) : 14, noHttp: lv.cfg >= 2 && rc.p(0.08), relaisAnBoot: lv.ev >= 1 && r0.p(0.1),
    kalP: sArt === 'frisch' && netz === 'offline' ? 0.5 : [0.04, 0.15, 0.35, 0.6][lv.ev], boot0: r0.i(200, 5000), ev: [],
    prognose: netz !== 'offline' && R('prog').p(0.35) ? R('prog').i(1, 1e9) : 0 };   // Regenprognose ändert sich im Tagesverlauf
  // Ereignisse
  const add = (ch, t, e) => { if (t >= start && t < ende) { e.t = Math.floor(t); e.ch = ch; P.ev.push(e); } };
  const when = (r) => start + r.u() * (ende - start);
  const count = (r, key, ch) => r.n(RATE[key][lv[ch]] * tage);
  { const r = R('ev');
    for (let n = count(r, 'press', 'ev'); n > 0; n--) { const t = r.p(0.3) ? zehnUhrNahe(r, start, ende) : when(r); add('ev', t, { k: 'press' }); }
    for (let n = count(r, 'salve', 'ev'); n > 0; n--) { const t = when(r), m = r.i(2, 7); for (let j = 0; j < m; j++) add('ev', t + j * r.i(150, 2500), { k: 'press' }); }
    for (let n = count(r, 'app', 'ev'); n > 0; n--) add('ev', when(r), { k: 'app', on: r.pick([true, true, false, 'toggle']), src: r.pick(['WS_in', 'http', 'cloud', 'schedule']), ta: r.p(0.5) ? null : r.pick([5, 60, 600, 3000, 7199, 7800, 9000, 1e5]) });
    for (let n = count(r, 'pf', 'ev'); n > 0; n--) add('ev', when(r), { k: 'pf', dur: Math.floor(r.lg(1000, 10 * H)), an: r.p(0.1) });
    for (let n = count(r, 'flackern', 'ev'); n > 0; n--) add('ev', when(r), { k: 'flackern', m: r.i(2, 5) });
    for (let n = count(r, 'restart', 'ev'); n > 0; n--) { const t = when(r); add('ev', t, { k: 'restart' }); if (r.p(0.2)) add('ev', t + r.i(1500, 20000), { k: 'restart' }); }
    for (let n = count(r, 'stop', 'ev'); n > 0; n--) add('ev', when(r), { k: 'stop' });
    for (let n = count(r, 'vcset', 'ev'); n > 0; n--) {
      const key = r.pick(['boolean:200', 'boolean:200', 'number:201', 'number:202']);
      let v = key === 'boolean:200' ? r.p(0.65) : key === 'number:201' ? (r.p(0.5) ? 0 : r.p(0.8) ? r.i(1, 3) : r.i(4, 14)) : r1(1 + r.u() * 39);
      if (lv.vc >= 2 && r.p(0.3)) v = r.pick(UNSINN.concat(['true', 'false', 2.5, 100, -3, 0]));
      add('ev', when(r), { k: 'vcset', key, v });
    }
    for (let n = count(r, 'vcbtn', 'ev'); n > 0; n--) add('ev', when(r), { k: 'vcbtn' });
    // rund um die Tagesprüfung: Handgabe kurz davor beendet (Pause 2 min), viele Starts in der Stunde davor
    if (lv.ev >= 1 && r.p(0.4)) { const t = zehnUhrNahe(r, start, ende) - r.i(30, 170) * 1000; add('ev', t, { k: 'press' }); add('ev', t + r.i(5, 60) * 1000, { k: 'press' }); }
    if (lv.ev >= 2 && r.p(0.25)) { const t = zehnUhrNahe(r, start, ende) - r.i(15, 50) * M; for (let j = 0; j < 22; j++) add('ev', t + j * r.i(40, 90) * 1000, { k: 'press' }); }
  }
  { const r = R('extra');
    if (lv.pump >= 2 && r.p(0.25)) add('pump', zehnUhrNahe(r, start, ende) - r.i(1, 15) * M, { k: 'weld', dur: r.i(20, 90) * M });
    if (lv.vc >= 3 && r.p(0.5)) { let t = when(r); const bis = t + r.i(10, 20) * H; while (t < bis) { add('vc', t, { k: 'vcdel', keys: ['*'] }); t += r.i(15, 45) * M; } }
    if (lv.clock >= 2 && r.p(0.35)) { let t = when(r), on = false; const bis = t + r.i(8, 14) * H; while (t < bis) { add('clock', t, { k: 'net', on }); on = !on; t += r.i(35, 50) * M; } add('clock', bis, { k: 'net', on: true }); }
    if (lv.ev >= 2 && r.p(0.15)) add('ev', when(r), { k: 'printWirft', re: r.pick(['Pumpe auf Voreinstellung', 'Speicher schreibt nicht', 'Tagesprüfung', 'Pumpe an', 'Bedienfeld']) });
    if (lv.ev >= 2 && r.p(0.15)) add('ev', when(r), { k: 'infoSendWirft' });
    if (lv.sw >= 1 && netz === 'offline' && r.p(0.35)) add('sw', zehnUhrNahe(r, start, ende) - r.i(10, 90) * M, { k: 'temp', v: 0, tv: r.pick(['weg', { tC: null }]), tim: {}, errs: [], dur: r.i(2, 8) * H, imp: false });
    if (lv.rpc >= 1 && r.p(0.25)) add('rpc', zehnUhrNahe(r, start, ende) - r.i(0, 20) * M, { k: 'aus', m: 'Switch.Set', f: 'err', msg: r.pick(['overtemperature', 'Too many calls in progress']), dur: r.i(30, 160) * M });
  }
  { const r = R('info');
    for (let n = r.n(RATE.info[lv.ev] * tage); n > 0; n--) add('ev', when(r), { k: 'info' });
  }
  { const r = R('eval');                    // Selbsttest per Script.Eval (Aufspielwerkzeug), meist kurz nach dem Start
    if (r.p([0.15, 0.3, 0.5, 0.7][lv.ev])) add('ev', r.p(0.5) ? start + r.i(20, 600) * 1000 : when(r), { k: 'eval', nach: r.i(1, 120) * 1000 });
  }
  { const r = R('vcev');
    for (let n = count(r, 'vcdel', 'vc'); n > 0; n--) add('vc', when(r), { k: 'vcdel', keys: r.p(0.3) ? ['*'] : [r.pick(['text:200', 'number:200', 'boolean:200', 'number:201', 'number:202', 'button:200', 'group:200'])] });
  }
  { const r = R('storeev');
    for (let n = count(r, 'kaputt', 'store'); n > 0; n--) { const so = sGueltig(r, start, lv.clock); add('store', when(r), { k: 'kaputt', s: r.p(0.8) ? sFeindlich(r, so) : JSON.stringify(so), f: r.p(0.4) ? fFeindlich(r) : undefined, wie: r.pick(['restart', 'pf']) }); }
  }
  { const r = R('clock');
    if (netz === 'offline') { P.net0 = false; P.ntp0 = false; if (r.p(0.3)) add('clock', when(r), { k: 'net', on: true, ntp: true }); }
    else { P.net0 = true; P.ntp0 = !(lv.clock && r.p(0.25)); if (!P.ntp0) add('clock', when(r), { k: 'ntp', on: true }); }
    if (netz !== 'offline') {
      for (let n = count(r, 'ntp', 'clock'); n > 0; n--) { const t = when(r); add('clock', t, { k: 'ntp', on: false }); add('clock', t + r.lg(M, 20 * H), { k: 'ntp', on: true }); }
      for (let n = count(r, 'net', 'clock'); n > 0; n--) { const t = when(r); add('clock', t, { k: 'net', on: false }); add('clock', t + r.lg(M, 20 * H), { k: 'net', on: true }); }
      for (let n = count(r, 'httpfail', 'clock'); n > 0; n--) { const t = when(r); add('clock', t, { k: 'httpfail', on: true }); add('clock', t + r.lg(M, 6 * H), { k: 'httpfail', on: false }); }
    }
    for (let n = count(r, 'uhr', 'clock'); n > 0; n--) add('clock', when(r), { k: 'uhr', mode: r.pick(['sync', 'falsch', 'falschNtp', 'falschNtp']),
      off: Math.floor(r.pick([1, -1]) * r.lg(10e3, 40 * D)) });
  }
  { const r = R('pump');
    for (let n = count(r, 'mode', 'pump'); n > 0; n--) add('pump', when(r), { k: 'mode', m: r.pick(['dry', 'closed', 'blocked', 'airmix', 'noload', 'anlauf', 'burst']), dur: Math.floor(r.lg(5e3, 8 * H)) });
    for (let n = count(r, 'weld', 'pump'); n > 0; n--) add('pump', when(r), { k: 'weld', dur: Math.floor(r.lg(10e3, 2 * H)) });
  }
  for (const ch of ['sw', 'sys', 'cfg', 'grp', 'vc', 'store', 'rpc']) {
    const r = R('ep:' + ch);
    for (let n = count(r, ch, ch); n > 0; n--) { const e = episode(ch, r, lv[ch]); if (e) add(ch, when(r), e); }
  }
  P.ev.sort((a, b) => a.t - b.t);
  return P;
}
function zehnUhrNahe(r, start, ende) {    // Taster rund um die Tagesprüfung
  const d0 = start + r.u() * (ende - start), p = berlinParts(d0);
  const t = berlinToUnixMs(p.y, p.m, p.d, 9, 55) + r.i(0, 40) * M + r.i(0, 59) * 1000;
  return t < start || t >= ende ? d0 : t;
}
function episode(ch, r, lvl) {            // feindliche Phase einer Schnittstelle: Art, Werte, Dauer
  const dur = (a, b) => Math.floor(r.lg(a, b));
  if (ch === 'sw') {
    const k = r.w({ apower: 20, current: 10, beide: 8, temp: 18, timer: 12, errors: 10, mix: 10, null: lvl >= 2 ? 4 : 0, output: lvl >= 3 ? 3 : 0 });
    const v = r.p(0.35) ? 'flimmern' : r.pick(UNSINN);
    const tv = r.pick(['weg', null, {}, { tC: null }, { tC: 'x' }, { tC: NaN }, { tC: 1e6 }, { tC: -300 }, { tC: 85 }, { tC: -40 }, { tF: 70 }, 'springt']);
    const tim = { dur: r.pick(['weg', 0, -5, 0.5, 1, 7799, 7800, 1e9, '300', null, r.i(1, 20000)]), at: r.pick(['weg', 0, T_MIN - 1, 'zukunft', 'vergangen', 'x', null, 'jetzt']) };
    const ev = r.pick([['overtemp'], ['overpower', 'overvoltage'], 'overcurrent', [null], [], [42], ['e'.repeat(300)], {}]);
    return { k, v, tv, tim, errs: ev, dur: k === 'null' || k === 'output' ? dur(900, 3500) : dur(1000, 30 * M), imp: k === 'null' || k === 'output' };
  }
  if (ch === 'sys') {
    const k = r.w({ ut: 30, offset: 20, wackeln: 12, sync: 18, null: 10, ms: 4 });
    return { k, v: r.pick([null, 0, 1e9, T_MIN - 1, T_MIN, T_MIN + 1, 4102444800, 1e12, NaN, '1767225600', -1, 'jetzt+0.5']),
      off: Math.floor(r.pick([1, -1]) * r.lg(30, 30 * 86400)), sv: r.pick([null, 0, 'x', 'jetzt', 'zufall', 1e12, -5]),
      dur: dur(1000, 2 * H), imp: k === 'ms' || k === 'wackeln' };
  }
  if (ch === 'cfg') {
    const k = r.w({ switch: 25, plugs: 25, vcnull: 15, vcfake: 10, allenull: 10, devinfo: 15 });
    return { k, v: k === 'switch' ? r.pick([null, undefined, {}, { auto_off: 'true', auto_off_delay: '7800', initial_state: 1, name: 42, auto_on: 'yes' }, { initial_state: 'off', auto_off: true, auto_off_delay: 7800 }])
      : r.pick([null, {}, { leds: null }, { leds: { mode: 'switch', colors: null } }, { leds: { mode: 'switch', colors: { 'switch:0': 'x' } } },
        { leds: { mode: 'switch', colors: { 'switch:0': { off: { rgb: 'abc', brightness: '100' }, on: null } } } }, { leds: { mode: 'switch', colors: { 'switch:0': { off: { rgb: [100, 0, 0], brightness: 100 }, on: { rgb: [0, 0, 100], brightness: 100 } } } } }]),
      dev: r.pick([null, {}, 'wirft', { ver: 5 }]), dur: dur(1000, 2 * H) };
  }
  if (ch === 'grp') return { k: 'wert', v: r.pick([null, { value: null }, { value: 'abc' }, { value: 5 }, { value: [] }, { value: ['text:200', 'text:200', 'text:200', 'text:200', 'text:200', 'text:200'] }, {}, { value: { length: 6 } }]), dur: dur(1000, 2 * H) };
  if (ch === 'vc') {
    const k = r.w({ null: 15, nullTeil: 10, wert: 30, statusUndef: 12, statusWirft: 6, setWirft: 12, onWirft: 5, handleWirft: 5, keinStatus: 5 });
    const key = r.pick(['au', 'ra', 'pa', 'bk', 'st', 're']);
    return { k, key, v: r.pick(UNSINN.concat(['false', 'true', 0, 1, 15, 2.5, 41, 0.99])), dur: dur(1000, H), imp: k === 'wert' && (key === 'pa' || key === 'au') };
  }
  if (ch === 'store') return { k: r.w({ setWirft: 45, setWeg: 15, getWirft: 25, getMuell: 15 }), muell: r.pick(['', '{', '[]', 'null', '{"v":1,"d":"x"}', '\u0000ÿ']), dur: dur(10e3, 6 * H) };
  if (ch === 'rpc') return { k: 'aus', m: r.pick(['*', 'Switch.Set', 'Switch.Set', 'Sys.SetTime', 'Schedule.List', 'PLUGS_UI.SetConfig', 'Virtual.Add', 'HTTP.GET']),
    f: r.pick(['err', 'throw', 'lost', 'okNoEff', 'late', 'errEff']), msg: r.pick(MSGS), dur: dur(2000, 30 * M) };   // ein Grund je Phase
  return null;
}

// ============================== Welt laufen lassen ==============================
class Plan {                               // eigene Ereignisse: immer nur das nächste steht in der Liste des Emulators (schnell)
  constructor(w, onErr) { this.w = w; this.h = []; this.seq = 0; this.gen = 0; this.at = Infinity; this.onErr = onErr; }
  add(t, fn) {
    const h = this.h, e = { t, s: this.seq++, fn }; h.push(e);
    let j = h.length - 1;
    while (j > 0) { const p = (j - 1) >> 1; if (this.lt(h[p], h[j])) break; [h[p], h[j]] = [h[j], h[p]]; j = p; }
    if (t < this.at) this.arm(t);
  }
  lt(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) { h[0] = last; let j = 0; for (;;) { const a = 2 * j + 1, b = a + 1; let m = j;
      if (a < h.length && this.lt(h[a], h[m])) m = a; if (b < h.length && this.lt(h[b], h[m])) m = b;
      if (m === j) break; [h[m], h[j]] = [h[j], h[m]]; j = m; } }
    return top;
  }
  arm(t) { const g = ++this.gen; this.at = t; this.w.at(Math.max(t, this.w.t), () => this.fire(g)); }
  fire(g) {
    if (g !== this.gen) return;
    this.at = Infinity;
    while (this.h.length && this.h[0].t <= this.w.t) { const e = this.pop(); try { e.fn(); } catch (err) { this.onErr(err); } }
    if (this.h.length && this.h[0].t < this.at) this.arm(this.h[0].t);
  }
}

const TRIP_RE = /Schutz: |Zu viele Starts|Anlernen abgebrochen|Angelernt: /;
const EFF = new Set(['ok', 'late', 'dup', 'errEff', 'garbage', 'lostEff', 'noTimer', 'mut']);   // Schicksale, bei denen der Befehl wirkt
const KEEP_RE = /Pumpe an|Pumpe aus|Schutz: |Zu viele Starts|Anlernen|Angelernt|Fehler|gestartet|Uhr|Bedienfeld|Speicher|Diagnose|Tagesprüfung|Echte Uhrzeit|Einschalten|Relais/;
const LED_ROT = '100,0,0';

function laufen(P, laut) {
  const rec = { log: [], msgs: new Map(), sw: [], led: [], cfgc: [], swcfg: [], store: [], info: [], starts: [], onCfg: [], lies: [],
    inj: {}, text: { max: 0, nonStr: 0, bsp: '' }, mem: {}, au: [], intern: [], epSab: {}, overs: [], zustand: [], evalErr: [] };
  const F = { sw: null, sys: null, cfg: null, grp: null, vc: null, store: null, rpc: null };
  const lv = P.lv, streams = {};
  const rc = (n) => streams[n] || (streams[n] = new Rnd(hash32(P.ws, 'call', n)));
  const inj = (k) => { rec.inj[k] = (rec.inj[k] || 0) + 1; if (laut) console.log(fmt(w.t), '  >> ' + k); };
  const intern = (e) => { rec.intern.push(String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); if (laut) console.log('INTERN', e); };

  const w = new World({ code: CODE, start: P.start, weather: P.weather, ambient: P.ambient, seed: P.emuSeed, noHttpServer: P.noHttp });
  if (P.s !== null) w.storage.s = P.s;
  if (P.f !== null) w.storage.f = P.f;
  for (let j = 0; j < P.fremdeEintraege; j++) w.storage['alt' + j] = '1';
  Object.assign(w.swCfg, P.swCfg);
  if (P.plugsUi) w.plugsUi = JSON.parse(JSON.stringify(P.plugsUi));
  w.vc = P.vc; w.jobs = P.jobs;
  Object.assign(w.pump, P.pump); w.selfHeat = P.selfHeat;
  w.internet = P.net0; w.ntp = P.ntp0;
  if (P.prognose) w.forecast = (ds) => {   // Prognose für heute, alle 2 h neu (Regen kommt, wird abgesagt, Wahrscheinlichkeit wandert)
    const r = new Rnd(hash32(P.prognose, ds, Math.floor(berlinParts(w.t).hh / 2))), x = P.weather(ds);
    return r.p(0.5) ? { rain: x.rain, prob: x.prob } : { rain: r1(r.p(0.5) ? r.u() * 25 : 0), prob: r.i(0, 100) };
  };
  const pl = new Plan(w, intern);
  rec.au.push({ t: P.start, v: w.vc['boolean:200'] ? w.vc['boolean:200'].value : undefined });
  const auNote = () => rec.au.push({ t: w.t, v: w.vc['boolean:200'] ? w.vc['boolean:200'].value : undefined });
  const oSet = World.prototype.setOutput;
  w.setOutput = function (on, src, ta) {      // Relais: Einstellung der Notabschaltung beim Einschalten mitschreiben
    if (on && w.dev && !w.dev.output) rec.onCfg.push({ t: w.t, ao: w.swCfg.auto_off === true && w.swCfg.auto_off_delay <= 7800, ta: ta || 0, src });
    if (on && w.dev && w.dev.output && src !== 'loopback') rec.lies.push({ t0: w.t, t1: w.t, ch: 'fremd', k: 'ein-im-lauf(' + src + ')' });   // ersetzt den Timer
    return oSet.call(w, on, src, ta);
  };
  let stH = null;                             // Status-Abo des Skripts (für Unsinn-Ereignisse)
  w.fuzz = (ctx, dev, guard) => { try { install(ctx, dev, guard); } catch (e) { intern(e); } };

  function install(ctx, dev, guard) {
    const run = w.bootCount + '.' + (dev.scriptGen || 0), t0 = w.t, rs = rc('start');
    rec.starts.push({ t: w.t, run, boot: w.bootCount });
    const sh = ctx.Shelly, oCall = sh.call, oGCS = sh.getComponentStatus, oGCC = sh.getComponentConfig, oAdd = sh.addStatusHandler,
      oRem = sh.removeStatusHandler, oInfo = sh.getDeviceInfo, oSt = ctx.Script.storage, oHandle = ctx.Virtual.getHandle, oPrint = ctx.print;
    // Meldungen mit der Uhr des Skripts (R.u) und dem Stand des Bedienfelds
    ctx.print = function () {
      const msg = Array.prototype.join.call(arguments, ' ');
      try {
        const R = ctx.R, n = norm(msg);
        rec.msgs.set(n, (rec.msgs.get(n) || 0) + 1);
        if (KEEP_RE.test(msg)) rec.log.push({ t: w.t, msg, u: R ? R.u : null, h: !!(R && R.h), run });
        if (laut) console.log(fmt(w.t), msg);
        if (lv.ev >= 1 && /Pumpe an \((auto|retry)\)/.test(msg) && rc('autoaus').p(0.2)) {   // im Automatiklauf: Automatik aus oder Pause
          const r = rc('autoaus'), key = r.p(0.6) ? 'boolean:200' : 'number:201', t1 = w.t + r.i(60, 900) * 1000;
          pl.add(t1, () => { if (w.vc[key]) { inj('ev.imAutomatiklauf.' + key); w.vc[key].value = key === 'boolean:200' ? false : r.i(1, 3); auNote(); } });
          pl.add(t1 + r.i(1, 3) * H, () => { if (w.vc[key]) { w.vc[key].value = key === 'boolean:200' ? true : 0; auNote(); } });
        }
      } catch (e) { intern(e); }
      return oPrint.apply(null, arguments);
    };
    ctx.console = { log: ctx.print };
    const fake = (method, lat, deliver) => {   // Aufruf, der den Emulator nicht erreicht: belegt einen RPC-Platz wie echt
      if (dev.rpcOpen >= 5) throw new Error('RPC-Limit 5 überschritten (' + method + ')');
      dev.rpcOpen++; w.limits.rpc = Math.max(w.limits.rpc, dev.rpcOpen);
      const gen = dev.scriptGen || 0;
      w.after(lat, () => { if ((dev.scriptGen || 0) === gen) dev.rpcOpen--; if (deliver) deliver(); }, dev);
    };
    sh.call = function (method, params, cb, ud) {
      let f = OK, x = null;
      try { f = fate(method, params); x = note(method, params, f); begleit(method, params); } catch (e) { intern(e); f = OK; }
      const fn = typeof cb === 'function', g = fn ? guard(cb) : null;
      if (!fn && f.k !== 'throw' && f.k !== 'lost' && f.k !== 'leak' && f.k !== 'err' && f.k !== 'okNoEff' && f.k !== 'noTimer') f = OK;
      let p = params, c = cb;
      switch (f.k) {
        case 'throw': if (x) x.thrown = 1; throw new Error(f.msg + ' [fz]');
        case 'err': return fake(method, f.lat, g && (() => g(f.res, f.err, f.msg, ud)));
        case 'okNoEff': return fake(method, f.lat, g && (() => g({ was_on: false }, 0, '', ud)));
        case 'lost': case 'leak': return fake(method, f.hold, null);
        case 'errEff': c = function (res, err, msg, u2) { return cb(f.res, f.err, f.msg, u2); }; break;
        case 'lostEff': c = undefined; break;
        case 'late': c = function (res, err, msg, u2) { w.after(f.delay, () => g(res, err, msg, u2), dev); }; break;
        case 'dup': c = function (res, err, msg, u2) { w.after(f.delay, () => g(res, err, msg, u2), dev); return cb(res, err, msg, u2); }; break;
        case 'garbage': c = function () { return cb(f.res, f.err, f.msg, ud); }; break;
        case 'mut': c = function (res, err, msg, u2) { const y = mutate(method, params, res, err, msg, f); return cb(y[0], y[1], y[2], u2); }; break;
        case 'noTimer': p = Object.assign({}, params); delete p.toggle_after; break;
      }
      let r;
      try { r = oCall(method, p, c, ud); } catch (e) { if (x) x.thrown = 1; throw e; }   // Grenze des Emulators (RPC-Limit)
      if (method === 'Virtual.Add' && params && params.type === 'boolean') auNote();
      return r;
    };
    function begleit(method, params) {        // Ereignisse genau im Fenster eines Wetterabrufs: Taster gedrückt, Zeitserver stellt
      if (method !== 'HTTP.GET' || String(params && params.url).indexOf('past_days') < 0) return;
      const r = rc('begleit');
      if (lv.ev >= 1 && r.p(0.12)) pl.add(w.t + r.i(50, 350), () => { if (w.dev === dev) { inj('ev.taster.imWetterabruf'); w.press(); } });
      if (lv.clock >= 1 && ctx.R && ctx.R.est && r.p(0.3)) pl.add(w.t + r.i(50, 350), () => {
        if (w.dev !== dev) return;
        inj('clock.ntp.imWetterabruf'); w.ntp = true; dev.ntpSynced = true; dev.syncTs = Math.floor(w.t / 1000); dev.clockBase = w.t; dev.clockUp = w.uptime(dev);
        rec.lies.push({ t0: w.t, t1: w.t, ch: 'zeit', k: 'Zeitserver im Wetterabruf' });
      });
    }
    function note(method, params, f) {        // was die Regeln brauchen
      const k = f.k;
      let x = null;
      if (k !== 'ok') inj((method === 'HTTP.GET' ? (String(params && params.url).indexOf('geocoding') >= 0 ? 'geo' : 'wx') : 'rpc') + '.' + method + '.' + k);
      if (method === 'Switch.Set') rec.sw.push(x = { t: w.t, on: !!(params && params.on), ta: (params && params.toggle_after) || 0, k, run });
      else if (method === 'PLUGS_UI.SetConfig') {
        let off = '', lx = 0;
        try { off = String(params.config.leds.colors['switch:0'].off.rgb); lx = ctx.R && ctx.R.lx ? 1 : 0; } catch (e) { /* Unsinn */ }
        rec.led.push(x = { t: w.t, rot: off === LED_ROT, lx, k, run });
      } else if (method === 'Switch.SetConfig') rec.swcfg.push(x = { t: w.t, k, run });
      else if (method === 'Virtual.Add' || method === 'Group.Set' || method === 'Schedule.Create' || method === 'Schedule.Update') rec.cfgc.push(x = { t: w.t, k, run, m: method, c24: ctx.R ? ctx.R.c24 : null });
      return x;
    }
    sh.getComponentStatus = function (type, id) {
      const st = oGCS(type, id);
      try {
        if (type === 'switch') laufZustand(ctx, run);   // einmal je Takt: Zustand des Laufs nach dem letzten Takt
        if (type === 'switch' && F.sw) return mutSw(st, F.sw);
        if (type === 'sys' && F.sys) return mutSys(st, F.sys);
        if (type === 'group' && F.grp) return F.grp.v;
      } catch (e) { intern(e); }
      return st;
    };
    sh.getComponentConfig = function (type, id) {
      const c = oGCC(type, id), e = F.cfg;
      if (!e) return c;
      if (e.k === 'switch' && type === 'switch') return e.v;
      if (e.k === 'plugs' && type === 'plugs_ui') return e.v;
      if (e.k === 'allenull') return null;
      if (type !== 'switch' && type !== 'plugs_ui') {
        if (e.k === 'vcnull') return null;
        if (e.k === 'vcfake') return c || { id, name: 'fremd' };
      }
      return c;
    };
    sh.getDeviceInfo = function () {
      const e = F.cfg;
      if (e && e.k === 'devinfo') { if (e.dev === 'wirft') throw new Error('getDeviceInfo [fz]'); return e.dev; }
      return oInfo();
    };
    const addWirft = lv.ev >= 2 && rs.p(0.08), remWirft = lv.ev >= 2 && rs.p(0.08);
    sh.addStatusHandler = function (cb, ud) {
      if (addWirft) { inj('ev.addStatusHandler.wirft'); throw new Error('Handler-Limit [fz]'); }
      const id = oAdd(cb, ud);
      stH = { dev, gen: dev.scriptGen || 0, g: guard(cb), ud, id };
      return id;
    };
    sh.removeStatusHandler = function (id) { if (remWirft) { inj('ev.removeStatusHandler.wirft'); throw new Error('removeStatusHandler [fz]'); } return oRem(id); };
    if (ctx.HTTPServer && lv.cfg >= 1 && rs.p([0, 0.02, 0.08, 0.2][lv.cfg])) {
      rec.epSab[run] = 1; inj('cfg.registerEndpoint.wirft');
      ctx.HTTPServer = { registerEndpoint() { throw new Error('registerEndpoint [fz]'); } };
    }
    if (!ctx.HTTPServer) rec.epSab[run] = 1;
    // Speicher: beim Start lesen (getItem wirft, Unsinn), Schreiben (wirft, geht verloren)
    const getBeimStart = lv.store >= 1 && rs.p([0, 0.05, 0.15, 0.35][lv.store]) ? rs.pick(['wirft', 'muell', 'nurF']) : '';
    const muell = rs.pick(['', '{', '[]', 'null', '{"v":1,"d":"x","xe":"ab","xw":"cd"}', '5']);
    ctx.Script.storage = {
      getItem(k) {
        const e = F.store, früh = w.t - t0 < 3000;
        if ((e && e.k === 'getWirft') || (früh && (getBeimStart === 'wirft' || (getBeimStart === 'nurF' && k === 'f')))) { inj('store.getItem.wirft'); throw new Error('storage: Lesefehler [fz]'); }
        if ((e && e.k === 'getMuell') || (früh && getBeimStart === 'muell')) { inj('store.getItem.muell'); return e && e.k === 'getMuell' ? e.muell : muell; }
        return oSt.getItem(k);
      },
      setItem(k, v) {
        const e = F.store, n = typeof v === 'string' ? espLen(v) : -1;
        const x = { t: w.t, k, n, run, boot: w.bootCount, up: w.uptime(dev), f: 'ok', w24: ctx.R ? ctx.R.w24 : null };
        rec.store.push(x);
        if (n > 1024) rec.overs.push({ t: w.t, k, n, gross: grossFelder(v) });
        if (e && e.k === 'setWirft') { x.f = 'wirft'; inj('store.setItem.wirft'); throw new Error('storage: Schreibfehler [fz]'); }
        if (e && e.k === 'setWeg') { x.f = 'weg'; inj('store.setItem.weg'); return undefined; }
        try { return oSt.setItem(k, v); } catch (err) { x.f = 'emu'; throw err; }
      },
      removeItem(k) { return oSt.removeItem(k); },
      get length() { return oSt.length; },
      key(j) { return oSt.key(j); }
    };
    // Bedienfeld
    const ohneStatus = lv.vc >= 2 && rs.p(0.05);
    ctx.Virtual = { getHandle(key) {
      const e = F.vc;
      if (e && e.k === 'handleWirft') { inj('vc.getHandle.wirft'); throw new Error('getHandle [fz]'); }
      if (e && (e.k === 'null' || (e.k === 'nullTeil' && key.indexOf(kurz2key(e.key)) === 0))) { inj('vc.getHandle.null'); return null; }
      const h = oHandle(key);
      return h ? hülle(h, key, ohneStatus || (e && e.k === 'keinStatus')) : h;
    } };
    function hülle(h, key, ohneSt) {
      const kz = key2kurz(key), o = {
        getValue() { const e = F.vc; if (e && e.k === 'wert' && e.key === kz) { inj('vc.getValue.' + kz); return e.v; } return h.getValue(); },
        setValue(v) {
          const e = F.vc;
          if (kz === 'st') { const b = utf8Bytes(v); if (b < 0) { rec.text.nonStr++; rec.text.bsp = String(typeof v); } else if (b > rec.text.max) { rec.text.max = b; rec.text.bsp = String(v).slice(0, 300); } }
          if (e && e.k === 'setWirft' && (e.key === kz || e.key === 're')) { inj('vc.setValue.wirft'); throw new Error('setValue [fz]'); }
          return h.setValue(v);
        },
        getConfig() { return h.getConfig(); },
        setConfig(c) { return h.setConfig(c); },
        on(ev, cb) { const e = F.vc; if (e && e.k === 'onWirft') { inj('vc.on.wirft'); throw new Error('on [fz]'); } return h.on(ev, cb); },
        off(id) {                             // Firmware: Handle einer in der App gelöschten Komponente wirft
          const e = F.vc;
          if ((e && e.k === 'onWirft') || !w.vc[key]) { inj('vc.off.wirft'); throw new Error('off [fz]'); }
          return h.off(id);
        }
      };
      if (!ohneSt) o.getStatus = function () {
        const e = F.vc;
        if (e && e.k === 'statusUndef' && (e.key === kz || e.key === 're')) { inj('vc.getStatus.undefined'); return undefined; }
        if (e && e.k === 'statusWirft' && (e.key === kz || e.key === 're')) { inj('vc.getStatus.wirft'); throw new Error('getStatus [fz]'); }
        return h.getStatus();
      };
      return o;
    }
  }
  // Zustand muss gültig bleiben: Laufwerte (Glättung pf, gepumpte Zeit ps, Bezug ref) endliche Zahlen, sonst prüft monitor()
  // nicht mehr (NaN-Vergleiche sind immer falsch); S und die Temperaturtage endlich, Konto 0..25 mm
  const zSeen = new Set();
  function zustand(f, v, extra) {
    const k = f + '|' + (extra || '');
    if (zSeen.has(k)) return;
    zSeen.add(k); rec.zustand.push({ t: w.t, f, v: typeof v === 'string' ? 'Text(' + v.length + ') ' + v.slice(0, 30) : String(v) });
  }
  function laufZustand(ctx, run) {
    const R = ctx.R, rr = R && R.run;
    if (!rr || typeof rr !== 'object') return;
    const id = run + '@' + rr.t0;
    if (!(typeof rr.pf === 'number' && isFinite(rr.pf))) zustand('R.run.pf', rr.pf, id);
    if (!(typeof rr.ps === 'number' && isFinite(rr.ps))) zustand('R.run.ps', rr.ps, id);
    if (rr.ref !== undefined && !(typeof rr.ref === 'number' && isFinite(rr.ref))) zustand('R.run.ref', rr.ref, id);
  }
  function zustandS() {
    const ctx = w.dev && w.dev.ctx;
    if (!ctx || w.crashed) return;
    let R, S;
    try { R = ctx.R; S = ctx.S; } catch (e) { return; }
    if (!S || typeof S !== 'object') return;
    for (const k of Object.keys(S)) if (typeof S[k] === 'number' && !isFinite(S[k])) zustand('S.' + k, S[k]);
    if (!(typeof S.d === 'number' && S.d >= 0 && S.d <= 25)) zustand('S.d', S.d);
    if (!(typeof S.pi === 'number' && S.pi >= 0 && isFinite(S.pi))) zustand('S.pi', S.pi);
    for (const x of [R && R.td, R && R.ty]) if (x && typeof x === 'object' && !(isFinite(x.mn) && isFinite(x.mx))) zustand('R.td', x.mn + '/' + x.mx);
    if (R && R.sw && R.sw.tC !== null && !(typeof R.sw.tC === 'number' && isFinite(R.sw.tC))) zustand('R.sw.tC', R.sw.tC);
  }
  const K2 = { st: 'text:200', bk: 'number:200', au: 'boolean:200', pa: 'number:201', ra: 'number:202', re: 'button:200' };
  const kurz2key = (k) => K2[k] || k, key2kurz = (key) => { for (const k in K2) if (K2[k] === key) return k; return key; };
  function grossFelder(v) {
    try { const o = JSON.parse(v); if (!o || typeof o !== 'object') return ''; return Object.keys(o).map((k) => [k, JSON.stringify(o[k]).length]).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0] + ':' + x[1]).join(' '); }
    catch (e) { return 'kein JSON'; }
  }
  // ---------- Schicksal eines Aufrufs ----------
  const OK = { k: 'ok' };
  const BAD = [0, 0.03, 0.12, 0.35], MUT = [0, 0.05, 0.2, 0.5];
  const FATE = {
    'Switch.Set': { err: 25, errEff: 8, lost: 10, lostEff: 8, throw: 14, late: 10, okNoEff: 10, noTimer: 8, garbage: 5, leak: 2 },
    'Sys.SetTime': { err: 25, errEff: 15, lost: 10, lostEff: 10, throw: 15, late: 15, garbage: 8, leak: 2 },
    'Schedule.List': { err: 20, lost: 10, throw: 15, late: 10, mut: 40, dup: 3, leak: 2 },
    'HTTP.GET': { err: 30, lost: 10, throw: 8, late: 12, garbage: 5, dup: 3, mut: 30, leak: 2 },
    andere: { err: 25, errEff: 15, lost: 10, lostEff: 10, throw: 15, late: 15, dup: 4, garbage: 4, leak: 2 }
  };
  function fate(method, params) {
    let ch = 'rpc';
    if (method === 'HTTP.GET') ch = String(params && params.url).indexOf('geocoding') >= 0 ? 'geo' : 'wx';
    const e = F.rpc;
    if (e && (e.m === '*' || e.m === method)) { const f = mk(e.f, method, params, rc('ep:' + method)); if (e.msg !== undefined) f.msg = e.msg; return f; }
    const L = lv[ch];
    if (!L) return OK;
    const r = rc(method);
    if (ch === 'wx' && r.p(0.08)) return { k: 'mut', luecke: true };   // Open-Meteo liefert einzelne Werte als null (fehlende Daten)
    if (!r.p(BAD[L] * (method === 'Sys.SetTime' ? 2.5 : 1))) return method === 'HTTP.GET' && r.p(MUT[L]) ? { k: 'mut' } : OK;
    let k = r.w(FATE[method] || FATE.andere);
    if (k === 'noTimer' && !(params && params.on && params.toggle_after)) k = 'err';
    return mk(k, method, params, r);
  }
  function mk(k, method, params, r) {
    const to = ((params && params.timeout) || 10) * 1000, http = method === 'HTTP.GET';
    const f = { k, err: r.pick(CODES), msg: r.pick(MSGS), res: null, lat: http ? r.i(50, to) : r.i(5, 3000) };
    if (k === 'err' && !f.err) f.err = -1;
    if (k === 'lost') f.hold = http ? to + r.i(0, 5000) : r.i(1000, 60e3);
    if (k === 'leak') f.hold = r.i(10 * M, 60 * M);
    if (k === 'late' || k === 'dup') f.delay = http ? Math.floor(r.lg(1000, 30 * M)) : Math.floor(r.lg(500, 10 * M));
    if (k === 'garbage') { const x = r.pick([[undefined, 0, undefined], [null, 0, ''], ['x', 0, 'ok'], [5, 0, 5], [{}, 0, null], [null, 'Fehler', 'x'], [null, NaN, 'nan'], [[], 0, []]]); f.res = x[0]; f.err = x[1]; f.msg = x[2]; }
    if (k === 'throw') f.msg = r.pick(['Too many calls in progress', 'Invalid argument', 'Out of memory', 'RPC fehlt']);
    if (k === 'mut' && method === 'Schedule.List') f.k = 'mut';
    return f;
  }
  // ---------- Antworten verdrehen (HTTP.GET, Schedule.List) ----------
  function mutate(method, params, res, err, msg, f) {
    try {
      if (method === 'Schedule.List') { inj('rpc.Schedule.List.antwort'); return [rc('mut:sched').pick(SCHED_MUT(res)), err, msg]; }
      if (err || !res || typeof res !== 'object') return [res, err, msg];
      const url = String(params && params.url), art = url.indexOf('geocoding') >= 0 ? 'geo' : (url.indexOf('past_days') >= 0 ? 'wx' : 'probe');
      const r = rc('mut:' + art), out = Object.assign({}, res), stufe = f && f.luecke ? 'luecke' : r.w({ transport: 22, text: 23, json: 55 });
      if (stufe === 'luecke') {                // ein einzelner Tageswert null, oder current fehlt
        const o = JSON.parse(String(out.body)), dl = o && o.daily, k = r.pick(['et0_fao_evapotranspiration', 'precipitation_sum', 'precipitation_sum', 'temperature_2m_min', 'precipitation_probability_max', 'current']);
        if (k === 'current') delete o.current; else if (dl && Array.isArray(dl[k]) && dl[k].length) dl[k][r.i(0, dl[k].length - 1)] = null;
        inj('wx.luecke.' + k); out.body = JSON.stringify(o); return [out, err, msg];
      }
      if (stufe === 'transport') {
        const m = r.pick(['code', 'codeText', 'codeWeg', 'bodyWeg', 'bodyNull', 'bodyZahl', 'bodyObj', 'resNull', 'resTyp', 'b64', 'headersWeg']);
        inj(art + '.transport.' + m);
        if (m === 'code') { out.code = r.pick([500, 503, 404, 429, 301, 204, 400]); out.message = 'Fehler'; if (r.p(0.5)) out.body = '{"error":true,"reason":"Fehler"}'; }
        if (m === 'codeText') out.code = '200';
        if (m === 'codeWeg') delete out.code;
        if (m === 'bodyWeg') delete out.body;
        if (m === 'bodyNull') out.body = null;
        if (m === 'bodyZahl') out.body = 42;
        if (m === 'bodyObj') out.body = { daily: {} };
        if (m === 'resNull') return [r.p(0.5) ? null : undefined, 0, ''];
        if (m === 'resTyp') return [r.pick(['x', 5, true, []]), 0, 'OK'];
        if (m === 'b64') { out.body_b64 = Buffer.from(String(out.body)).toString('base64'); delete out.body; }
        if (m === 'headersWeg') delete out.headers;
        return [out, err, msg];
      }
      let body = String(out.body);
      if (stufe === 'text') {
        const m = r.pick(['leer', 'html', 'abgeschnitten', 'abgeschnitten', 'riesig', 'muell', 'bom', 'doppelt', 'null', 'zahl']);
        inj(art + '.text.' + m);
        if (m === 'leer') body = '';
        if (m === 'html') body = '<html><body><h1>502 Bad Gateway</h1></body></html>';
        if (m === 'abgeschnitten') body = body.slice(0, r.i(0, Math.max(0, body.length - 1)));
        if (m === 'riesig') body = body.replace('{', '{"pad":"' + 'x'.repeat(r.i(20000, 120000)) + '",');
        if (m === 'muell') { let b = ''; for (let j = r.i(1, 500); j > 0; j--) b += String.fromCharCode(r.i(0, 255)); body = b; }
        if (m === 'bom') body = '﻿' + body;
        if (m === 'doppelt') body = JSON.stringify(body);
        if (m === 'null') body = 'null';
        if (m === 'zahl') body = '42';
        out.body = body; return [out, err, msg];
      }
      let o;
      try { o = JSON.parse(body); } catch (e) { return [out, err, msg]; }
      const n = r.i(1, 3), was = [];
      for (let j = 0; j < n; j++) was.push(art === 'geo' ? mutGeo(o, r) : mutWx(o, r));
      inj(art + '.json.' + was.join('+'));
      let txt = JSON.stringify(o);
      if (txt === undefined) txt = 'undefined';
      out.body = txt.replace('"UNENDLICH"', '1e400').replace('"MINUSUNENDLICH"', '-1e400').replace('"NAN"', 'NaN');
      return [out, err, msg];
    } catch (e) { intern(e); return [res, err, msg]; }
  }
  const DATA = ['et0_fao_evapotranspiration', 'precipitation_sum', 'precipitation_probability_max', 'temperature_2m_min', 'temperature_2m_max'];
  function mutWx(o, r) {
    if (!o || typeof o !== 'object') return 'x';
    const dl = o.daily && typeof o.daily === 'object' ? o.daily : null;
    const m = r.w({ dailyWeg: 3, dailyNull: 2, dailyTyp: 2, timeWeg: 3, timeTyp: 3, timeKurz: 5, timeLang: 5, timeDatum: 8, timeVerschoben: 6,
      keyWeg: 8, keyNull: 6, keyNulls: 6, keyTexte: 6, keyNegativ: 6, keyRiesig: 6, keyGebrochen: 4, keyLaenge: 6, keyTyp: 4, keyGemischt: 6,
      keyUnendlich: 3, currentWeg: 8, currentNull: 3, currentTemp: 6, fehlerObjekt: 2, extra: 2 });
    const k = r.p(0.5) ? r.pick(['et0_fao_evapotranspiration', 'precipitation_sum']) : r.pick(DATA);   // die verbuchten Werte öfter
    const tag = (s, d) => { const t = Date.parse(s + 'T12:00:00Z'); return isNaN(t) ? s : new Date(t + d * D).toISOString().slice(0, 10); };
    switch (m) {
      case 'dailyWeg': delete o.daily; break;
      case 'dailyNull': o.daily = null; break;
      case 'dailyTyp': o.daily = r.pick(['x', 5, [], true]); break;
      case 'currentWeg': delete o.current; break;
      case 'currentNull': o.current = null; break;
      case 'currentTemp': if (o.current && typeof o.current === 'object') o.current.temperature_2m = r.pick([null, '20', 1e6, -1e6, -80, 60, [], {}, 'UNENDLICH']); break;
      case 'fehlerObjekt': for (const x of Object.keys(o)) delete o[x]; o.error = true; o.reason = 'Cannot initialize WeatherVariable'; break;
      case 'extra': o.zusatz = new Array(r.i(10, 3000)).fill(1.5); break;
      default:
        if (!dl) return m + '(ohne daily)';
        if (m === 'timeWeg') delete dl.time;
        else if (m === 'timeTyp') dl.time = r.pick(['2027-06-01', 5, null, {}]);
        else if (Array.isArray(dl.time) && m === 'timeKurz') dl.time.splice(r.i(0, Math.max(0, dl.time.length - 1)), 1);
        else if (Array.isArray(dl.time) && m === 'timeLang') dl.time.push(tag(String(dl.time[dl.time.length - 1]), 1));
        else if (Array.isArray(dl.time) && m === 'timeDatum') dl.time[r.p(0.7) ? dl.time.length - 1 : r.i(0, dl.time.length - 1)] = r.pick([tag(String(dl.time[dl.time.length - 1]), -1), tag(String(dl.time[dl.time.length - 1]), 1), '1999-01-01', '', null, 'Unsinn', '2027-6-1', 5]);
        else if (Array.isArray(dl.time) && m === 'timeVerschoben') { const d = r.pick([-1, 1, -2]); dl.time = dl.time.map((s) => tag(String(s), d)); }
        else if (m === 'keyWeg') delete dl[k];
        else if (m === 'keyNull') dl[k] = null;
        else if (m === 'keyTyp') dl[k] = r.pick(['x', 5, {}, true]);
        else if (Array.isArray(dl[k])) {
          if (m === 'keyNulls') dl[k] = dl[k].map(() => null);
          else if (m === 'keyTexte') dl[k] = dl[k].map(String);
          else if (m === 'keyNegativ') dl[k] = dl[k].map((v) => -Math.abs(+v || 1) - r.u() * 10);
          else if (m === 'keyRiesig') dl[k] = dl[k].map(() => r.pick([1e6, 1e308, 9e15, 2e9]));
          else if (m === 'keyGebrochen') dl[k] = dl[k].map((v) => (+v || 0) + r.u() * 1e-7 + 0.123456789);
          else if (m === 'keyLaenge') dl[k] = r.p(0.5) ? dl[k].slice(0, r.i(0, Math.max(0, dl[k].length - 1))) : dl[k].concat([1, 2, 3]);
          else if (m === 'keyGemischt') dl[k] = dl[k].map(() => r.pick([null, '3', 'NaN', [1], {}, true, -0, 4.5]));
          else if (m === 'keyUnendlich') dl[k][dl[k].length - 1] = r.pick(['UNENDLICH', 'MINUSUNENDLICH']);
        }
    }
    return m;
  }
  function mutGeo(o, r) {
    if (!o || typeof o !== 'object') return 'x';
    const m = r.pick(['resultsWeg', 'resultsLeer', 'resultsNull', 'resultsTyp', 'ersterNull', 'ersterLeer', 'latWeg', 'latText', 'latNull',
      'latRiesig', 'latNegativ', 'latUnendlich', 'lonWeg', 'lonText', 'lonNull', 'lonRiesig', 'zweiter', 'treffer']);
    const g = Array.isArray(o.results) && o.results[0] && typeof o.results[0] === 'object' ? o.results[0] : null;
    if (m === 'treffer') o.results = [{ name: 'Ludwigshafen am Rhein', latitude: 49.48121, longitude: 8.44641, country_code: 'DE' }];
    else if (m === 'resultsWeg') delete o.results;
    else if (m === 'resultsLeer') o.results = [];
    else if (m === 'resultsNull') o.results = null;
    else if (m === 'resultsTyp') o.results = r.pick(['x', 5, {}, true]);
    else if (m === 'ersterNull') o.results = [null];
    else if (m === 'ersterLeer') o.results = [{}];
    else if (m === 'zweiter') o.results = (Array.isArray(o.results) ? o.results : []).concat([{ name: 'X', latitude: 1, longitude: 2 }]);
    else if (g) {
      const f = m.indexOf('lat') === 0 ? 'latitude' : 'longitude';
      if (/Weg$/.test(m)) delete g[f];
      else if (/Text$/.test(m)) g[f] = String(g[f]);
      else if (/Null$/.test(m)) g[f] = null;
      else if (/Riesig$/.test(m)) g[f] = r.pick([1e308, 1e6, 500]);
      else if (/Negativ$/.test(m)) g[f] = -r.pick([91, 181, 1e6]);
      else if (/Unendlich$/.test(m)) g[f] = 'UNENDLICH';
    }
    return m;
  }
  const SCHED_MUT = (res) => {
    const real = res && Array.isArray(res.jobs) ? res.jobs : [];
    return [null, undefined, {}, { jobs: null }, { jobs: 'x' }, { jobs: 5 }, { jobs: { length: 2 } }, { jobs: [null] }, { jobs: [{}] },
      { jobs: [{ id: 1, calls: 'x' }] }, { jobs: [{ id: 1, calls: [null] }] }, { jobs: [{ id: 1, calls: 5 }] },
      { jobs: [{ id: 1, enable: true, timespec: WD_SPEC, calls: [{ method: 'Script.Start' }] }] },
      { jobs: [{ id: 1, enable: true, timespec: WD_SPEC, calls: [{ method: 'script.start', params: { id: '1' } }] }] },
      { jobs: [{ id: 1, enable: true, timespec: WD_SPEC, calls: [{ method: 5, params: {} }] }] },
      { jobs: [{ enable: true, timespec: WD_SPEC, calls: [{ method: 'Script.Start', params: { id: 1 } }] }] },
      { jobs: real.concat(real, real) }, { jobs: real.slice().reverse() }];
  };
  // ---------- Status verdrehen ----------
  function wert(v, r) { return v === 'flimmern' ? r.pick(UNSINN) : v; }
  function mutSw(st, e) {
    const r = rc('sw');
    if (e.k === 'null') { inj('sw.status.null'); return r.p(0.5) ? null : undefined; }
    if (!st) return st;
    const o = { id: st.id, source: st.source, output: st.output, apower: st.apower, voltage: st.voltage, current: st.current, freq: st.freq };
    if ('timer_started_at' in st) { o.timer_started_at = st.timer_started_at; o.timer_duration = st.timer_duration; o.timer_type = st.timer_type; }
    if (st.errors) o.errors = st.errors;
    let temp = 'echt', k = e.k;
    if (k === 'mix') k = r.pick(['apower', 'current', 'temp', 'timer', 'errors']);
    if (k === 'apower' || k === 'beide') o.apower = wert(e.v, r);
    if (k === 'current' || k === 'beide') o.current = wert(e.v, r);
    if (k === 'temp') temp = e.tv === 'springt' ? { tC: r1(-40 + r.u() * 160) } : e.tv;
    if (k === 'timer') {
      const now = Math.floor(w.t / 1000);
      if (e.tim.dur === 'weg') { delete o.timer_duration; delete o.timer_started_at; delete o.timer_type; }
      else {
        o.timer_duration = e.tim.dur; o.timer_type = 'toggle_after';
        const a = e.tim.at;
        o.timer_started_at = a === 'weg' ? undefined : a === 'zukunft' ? now + 1e6 : a === 'vergangen' ? now - 1e6 : a === 'jetzt' ? now : a;
      }
    }
    if (k === 'errors') o.errors = e.errs;
    if (k === 'output') { o.output = !st.output; inj('sw.output.gelogen'); }
    if (temp === 'echt') Object.defineProperty(o, 'temperature', { enumerable: true, get: () => st.temperature });
    else if (temp !== 'weg') o.temperature = temp;
    return o;
  }
  function mutSys(st, e) {
    const r = rc('sys');
    if (e.k === 'null') return r.p(0.5) ? null : undefined;
    if (!st) return st;
    const o = { unixtime: st.unixtime, last_sync_ts: st.last_sync_ts, uptime: st.uptime }, now = Math.floor(w.t / 1000);
    if (e.k === 'ut') o.unixtime = e.v === 'jetzt+0.5' ? (st.unixtime === null ? null : st.unixtime + 0.5) : e.v;
    else if (e.k === 'offset') o.unixtime = st.unixtime === null ? null : st.unixtime + e.off;
    else if (e.k === 'wackeln') o.unixtime = st.unixtime === null ? null : st.unixtime + (r.p(0.5) ? e.off : 0);
    else if (e.k === 'ms') o.unixtime = st.unixtime === null ? null : st.unixtime * 1000;
    else if (e.k === 'sync') o.last_sync_ts = e.sv === 'jetzt' ? now : e.sv === 'zufall' ? r.i(0, 2e9) : e.sv;
    return o;
  }

  // ---------- Ereignisse ----------
  // Neustart nur, wenn das Skript auf diesem Gerätestart schon lief und kein Neustart unterwegs ist: der Emulator bricht den
  // Start beim Hochfahren nicht ab, zwei Starts gäben zwei Instanzen mit gleicher Generation (am Gerät unmöglich)
  let neuBis = 0;
  function neustart() {
    const dev = w.dev;
    if (!dev || !dev.ctx || w.t < neuBis) return false;
    neuBis = w.t + 1500; w.restartScript(); return true;
  }
  function waechter() {                     // Gerätezeitplan „Script.Start alle 5 min“, wie der Emulator ihn ausführt
    const dev = w.dev;
    if (!dev || !dev.ctx || dev.scriptRunning || w.t < neuBis) return;
    w.fireSchedules();
    if (dev.scriptGen !== undefined && dev.scriptRunning) neuBis = w.t + 1500;
  }
  function ereignis(e) {
    const dev = w.dev;
    switch (e.k) {
      case 'press': if (dev) { inj('ev.taster'); w.press(); } break;
      case 'app': if (dev) { const on = e.on === 'toggle' ? !dev.output : e.on; inj('ev.app'); w.setOutput(on, e.src, on ? e.ta : null); } break;
      case 'pf': if (dev) { inj('ev.stromausfall'); w.powerFail(e.dur); if (e.an) w.lastOutput = true; nachBoot(w.t + e.dur); } break;
      case 'flackern': if (dev) { inj('ev.flackern'); flackern(e.m); } break;
      case 'restart': if (neustart()) inj('ev.neustart'); break;
      case 'stop': if (dev && dev.scriptRunning) { inj('ev.stopp'); w.stopScript(); } break;
      case 'vcset': if (w.vc[e.key]) { inj('ev.bedienfeld.' + e.key); w.vc[e.key].value = e.v; if (e.key === 'boolean:200') auNote(); } break;
      case 'vcbtn': inj('ev.knopf'); w.pressVcButton('button:200'); break;
      case 'vcdel': inj('vc.geloescht'); for (const k of (e.keys[0] === '*' ? Object.keys(w.vc) : e.keys)) delete w.vc[k]; auNote(); break;
      case 'kaputt': inj('store.kaputt');
        if (e.s === null) delete w.storage.s; else w.storage.s = e.s;
        if (e.f !== undefined) w.storage.f = e.f;
        if (dev) { if (e.wie === 'pf') { w.powerFail(2000); nachBoot(w.t + 2000); } else neustart(); }
        break;
      case 'info': infoPruefen(); break;
      case 'eval': evalSelbsttest(); pl.add(w.t + e.nach, evalSelbsttest); break;
      case 'printWirft': inj('ev.printWirft(unmöglich)'); w.throwPrint = new RegExp(e.re); rec.lies.push({ t0: w.t, t1: w.t + D, ch: 'print', k: 'wirft', imp: true }); break;
      case 'infoSendWirft': {                 // Verbindung bricht beim Senden der Diagnose-Seite ab
        const ep = dev && dev.endpoints && dev.endpoints.info;
        if (ep && dev.scriptRunning && !w.crashed) { inj('ev.diagnose.sendWirft'); ep.cb({ method: 'GET', query: '', headers: [], body: '' }, { send() { throw new Error('Verbindung weg [fz]'); } }, ep.ud); }
        break;
      }
      case 'net': inj('clock.internet.' + (e.on ? 'an' : 'aus')); w.internet = e.on; if (e.ntp) w.ntp = true; if (e.on) rec.lies.push({ t0: w.t, t1: w.t, ch: 'zeit', k: 'Internet zurück' }); break;
      case 'ntp': inj('clock.ntp.' + (e.on ? 'an' : 'aus')); w.ntp = e.on; if (e.on) rec.lies.push({ t0: w.t, t1: w.t, ch: 'zeit', k: 'Zeitserver zurück' }); break;
      case 'httpfail': inj('clock.wetterdienst.' + (e.on ? 'weg' : 'da')); w.httpFail = e.on; break;
      case 'uhr': if (dev) {
        inj('clock.uhr.' + e.mode);
        if (e.mode === 'sync') { dev.ntpSynced = true; dev.syncTs = Math.floor(w.t / 1000); dev.clockBase = w.t; dev.clockUp = w.uptime(dev); }
        else { dev.clockBase = w.t + e.off; dev.clockUp = w.uptime(dev); if (e.mode === 'falschNtp') dev.ntpSynced = false; }
        rec.lies.push({ t0: w.t, t1: w.t + (e.mode === 'falsch' ? 40 * D : 2 * M), ch: 'uhr', k: e.mode });
      } break;
      case 'mode': inj('pump.' + e.m); w.pump.mode = e.m; pl.add(w.t + e.dur, () => { if (w.pump.mode === e.m) w.pump.mode = 'normal'; }); break;
      case 'weld': inj('pump.klebt'); w.pump.weld = true; rec.lies.push({ t0: w.t, t1: w.t + e.dur, ch: 'weld', k: 'weld' }); pl.add(w.t + e.dur, () => { w.pump.weld = false; }); break;
      default:
        if (e.ch && F.hasOwnProperty(e.ch) && e.dur) {   // feindliche Phase einer Schnittstelle
          F[e.ch] = e; inj(e.ch + '.phase.' + e.k);
          rec.lies.push({ t0: w.t, t1: w.t + e.dur, ch: e.ch, k: e.k, imp: !!e.imp });
          if (e.ch === 'cfg' && e.k === 'devinfo') pl.add(w.t + Math.floor(e.dur / 2), infoPruefen);   // Diagnose-Seite in der Phase
          pl.add(w.t + e.dur, () => { if (F[e.ch] === e) F[e.ch] = null; });
        }
    }
  }
  function flackern(m) {                    // mehrere kurze Ausfälle hintereinander, jeweils kurz nach dem Hochfahren
    const r = rc('flackern'), d = r.i(200, 3000);
    w.powerFail(d);
    let t = w.t + d;
    for (let j = 1; j < m; j++) { const at = t + r.i(300, 20000), dd = r.i(200, 3000); pl.add(at, () => { if (w.dev) w.powerFail(dd); }); t = at + dd; }
    nachBoot(t);
  }
  function nachBoot(tb) {                   // nach dem Hochfahren: Anlern-Geste, Hahn zu, Drücke im Anlernen, Unsinn im Status-Abo
    const r = rc('boot');
    if (r.p(P.kalP)) {
      const n = +r.w({ 5: 70, 4: 8, 6: 10, 7: 4, 3: 4, 10: 4 }), art = r.w({ normal: 70, frueh: 10, spaet: 15, vorSkript: 5 });
      const s0 = art === 'normal' ? r.i(5, 40) : art === 'frueh' ? r.i(0, 4) : art === 'spaet' ? r.i(45, 62) : r.u() * 2.5;
      const gap = r.p(0.8) ? 0.4 + r.u() * 1.8 : 2 + r.u() * 2;
      for (let j = 0; j < n; j++) pl.add(tb + (s0 + j * gap) * 1000, () => { if (w.dev) { inj('ev.geste'); w.press(); } });
      const t5 = tb + (s0 + (n - 1) * gap) * 1000, zu = r.w({ richtig: 45, sofort: 8, nie: 20, frueh: 8, spaet: 8, wackelt: 4, taster: 6, strom: 4 });
      const mode = (at, m, dur) => { pl.add(at, () => { inj('pump.anlernen.' + m); w.pump.mode = m; }); pl.add(at + dur, () => { if (w.pump.mode === m) w.pump.mode = 'normal'; }); };
      if (zu === 'richtig') mode(t5 + r.i(64, 170) * 1000, 'closed', r.i(25, 60) * 1000);
      if (zu === 'sofort') mode(t5 + r.i(61, 64) * 1000, 'closed', r.i(25, 60) * 1000);   // fertig vor der Annahme der Uhrzeit (2 min)
      if (zu === 'frueh') mode(t5 + r.i(15, 55) * 1000, 'closed', r.i(10, 60) * 1000);
      if (zu === 'spaet') mode(t5 + r.i(185, 320) * 1000, 'closed', r.i(10, 60) * 1000);
      if (zu === 'wackelt') mode(t5 + r.i(35, 60) * 1000, 'airmix', r.i(10, 60) * 1000);
      if (zu === 'taster') pl.add(t5 + r.i(3, 220) * 1000, () => { if (w.dev) { inj('ev.taster.imAnlernen'); w.press(); } });
      if (zu === 'strom') pl.add(t5 + r.i(5, 220) * 1000, () => { if (w.dev) { inj('ev.stromausfall.imAnlernen'); const dd = r.i(500, 60000); w.powerFail(dd); nachBoot(w.t + dd); } });
    }
    if (lv.ev >= 2 && r.p(0.3)) {
      for (let j = r.i(1, 6); j > 0; j--) pl.add(tb + r.i(3500, 60000), () => {
        const h = stH;
        if (!h || h.dev !== w.dev || (h.dev.scriptGen || 0) !== h.gen || !h.dev.stHandlers[h.id]) return;
        const out = !!(w.dev && w.dev.output);
        const ev = rc('junk').pick([null, undefined, {}, { component: 'switch:0' }, { component: 'switch:0', delta: null }, { component: 'switch:0', delta: { output: 'true' } },
          { component: 'switch:1', delta: { output: !out } }, { component: 'switch:0', delta: { output: !out, source: 'loopback' } },
          { component: 'switch:0', delta: { apower: 5 } }, { component: 'switch:0', delta: { output: !out, source: 'button' } }]);
        inj('ev.statusabo.unsinn'); h.g(ev, h.ud);
      });
    }
  }
  function infoPruefen() {
    const dev = w.dev;
    if (!dev || !dev.ctx || w.crashed) return;
    const st = rec.starts[rec.starts.length - 1], run = w.bootCount + '.' + (dev.scriptGen || 0);
    const ep = dev.endpoints.info;
    if (!ep) {
      if (dev.scriptRunning && st && st.run === run && w.t - st.t > 5000 && !rec.epSab[run]) {
        const fs0 = rec.log.some((l) => l.run === run && /Fehler Start/.test(l.msg));
        rec.info.push({ t: w.t, code: 404, body: 'Endpunkt fehlt' + (fs0 ? ' (nach „Fehler Start“: init() abgebrochen)' : '') });
      }
      return;
    }
    const sv = (() => { try { return JSON.stringify(dev.ctx.S); } catch (e) { return null; } })();
    let out;
    try { out = w.endpoint('info'); } catch (e) { rec.info.push({ t: w.t, code: 'wirft', body: String(e) }); return; }
    const sn = (() => { try { return JSON.stringify(dev.ctx.S); } catch (e) { return null; } })();
    rec.info.push({ t: w.t, code: out.code, sent: out.sent, body: out.code === 200 ? '' : String(out.body).slice(0, 240), sG: sv !== sn && !w.crashed, len: String(out.body).length });
  }
  function speicherProxy() {
    const ctx = w.dev && w.dev.ctx;
    if (!ctx || w.crashed) return;
    let R, S;
    try { R = ctx.R; S = ctx.S; } catch (e) { return; }
    if (!R || !S || typeof R !== 'object' || typeof S !== 'object') return;
    walk(R, 'R', 0); walk(S, 'S', 0); zustandS();
  }
  function evalSelbsttest() {               // Script.Eval wie das Aufspielwerkzeug: selfTest() startet den Abruf, ein zweiter Aufruf liest
    const dev = w.dev;
    if (!dev || !dev.ctx || !dev.scriptRunning || w.crashed) return;
    inj('ev.eval.selfTest');
    try { const x = w.eval('selfTest()'); if (typeof x !== 'string') rec.evalErr.push({ t: w.t, e: 'kein Text: ' + typeof x }); }
    catch (e) { rec.evalErr.push({ t: w.t, e: String(e).slice(0, 120) }); }
  }
  function walk(o, p, d) {
    if (o === null || typeof o !== 'object' || d > 4) return;
    if (Array.isArray(o)) {
      if (!(rec.mem[p + '[]'] >= o.length)) rec.mem[p + '[]'] = o.length;
      for (let j = 0; j < Math.min(o.length, 40); j++) {
        if (typeof o[j] === 'string') { if (!(rec.mem[p + '[]#'] >= o[j].length)) rec.mem[p + '[]#'] = o[j].length; }
        else walk(o[j], p + '[]', d + 1);
      }
      return;
    }
    for (const k of Object.keys(o)) {
      if (p === 'R' && k === 'h') continue;
      const v = o[k], q = p + '.' + k;
      if (typeof v === 'string') { if (!(rec.mem[q + '#'] >= v.length)) rec.mem[q + '#'] = v.length; }
      else if (v && typeof v === 'object') walk(v, q, d + 1);
    }
  }

  // ---------- Ablauf ----------
  for (const e of P.ev) pl.add(e.t, () => ereignis(e));
  for (let t = P.start + 10 * M; t < P.ende; t += 10 * M) pl.add(t, speicherProxy);
  for (let t = P.start + 5 * M; t < P.ende; t += 5 * M) pl.add(t, waechter);   // Wächter
  w.powerFail(P.boot0);                     // Gerät wird eingesteckt
  if (P.relaisAnBoot) { w.lastOutput = true; inj('ev.relaisAnBeimStart'); }
  nachBoot(P.start + P.boot0);
  const t0 = Date.now();
  w.run(P.ende);
  infoPruefen(); speicherProxy();
  const ergebnis = pruefen(P, w, rec);
  ergebnis.ms = Date.now() - t0;
  return ergebnis;
}

// ============================== Regeln ==============================
function pruefen(P, w, rec) {
  const V = [], tags = [];
  const verstoss = (regel, t, text, extra) => V.push({ regel, t, zeit: fmt(t), text, tags: extra || '' });
  const lies = (t0, t1, chs) => rec.lies.filter((l) => l.t1 >= t0 && l.t0 <= t1 && chs.indexOf(l.ch) >= 0).map((l) => l.ch + '.' + l.k + (l.imp ? '(unmöglich)' : ''));
  const ende = P.ende;
  // 1. kein Absturz, keine Grenzverletzung des Emulators
  if (w.crashed) verstoss('absturz', w.crashed.t, w.crashed.err.split('\n').slice(0, 3).join(' | '), lies(w.crashed.t - D, w.crashed.t, ['print']).join(','));
  if (w.limits.timers > 5 || w.limits.rpc > 5 || w.limits.handlers > 5) verstoss('firmware-grenzen', ende, JSON.stringify(w.limits));
  for (const e of rec.intern) verstoss('fuzzer-intern', ende, e);
  // 2. Laufzeit: 120 min ab eigenem Start/Übernahme, 130 min ab Ein, wenn die Notabschaltung eingestellt war
  const pumpeAn = rec.log.filter((l) => /Pumpe an \(/.test(l.msg));
  const stats = { laeufe: 0, max120: 0, max130: 0, auto: 0, autoGeprueft: 0, trips: 0 };
  const wirkt = (c) => EFF.has(c.k) && !c.thrown;   // Befehl hat das Relais erreicht
  for (const r of w.runs()) {
    stats.laeufe++;
    const off = r.off === undefined ? ende : r.off;
    const seen = pumpeAn.find((l) => l.t >= r.on && l.t <= off);
    const ref = r.src === 'loopback' ? r.on : seen ? seen.t : null;
    const lost = rec.sw.filter((c) => c.t >= r.on && c.t <= off && c.on && c.ta && (!wirkt(c) || c.k === 'noTimer')).length;
    const offLost = rec.sw.filter((c) => c.t >= r.on && c.t <= off && !c.on && !wirkt(c)).length;
    const li = lies(r.on, off, ['sw', 'sys', 'uhr', 'rpc', 'fremd']);
    if (ref !== null) {
      const m = (off - ref) / M, lim = 120.5 + (lost ? 61.5 / 60 : 0) + offLost * 5.5 / 60;
      stats.max120 = Math.max(stats.max120, m);
      if (m > lim) verstoss('laufzeit-120', ref, m.toFixed(1) + ' min ab ' + (r.src === 'loopback' ? 'eigenem Start' : 'Übernahme') + ' (Ein ' + fmt(r.on) + ' ' + r.src + ', Aus ' + (r.off === undefined ? 'nie' : fmt(off) + ' ' + r.offSrc) + ')', li.join(','));
    }
    const oc = rec.onCfg.filter((c) => Math.abs(c.t - r.on) <= 5).pop();
    // Notabschaltung der Firmware zählt ab dem letzten Einschalten: ein fremdes „Ein“ im Lauf startet sie neu (Firmware)
    const reArm = rec.lies.filter((l) => l.ch === 'fremd' && l.t0 >= r.on && l.t0 <= off).map((l) => l.t0).pop();
    const m130 = (off - (reArm || r.on)) / M;
    if (oc && oc.ao) stats.max130 = Math.max(stats.max130, m130);
    if (oc && oc.ao && m130 > 130.5) verstoss('laufzeit-130', r.on, m130.toFixed(1) + ' min ab Ein trotz Notabschaltung (Ein ' + r.src + ', Aus ' + (r.off === undefined ? 'nie' : r.offSrc) + ')', li.join(','));
  }
  // 3. nach einer Schutzabschaltung binnen 10 s aus (oder, wenn Aus-Befehle verloren gingen: sobald einer durchkommt)
  const relayAt = (t) => { let on = false; for (const x of w.relay) { if (x.t > t) break; on = x.on; } return on; };
  for (const l of rec.log) {
    if (!TRIP_RE.test(l.msg) || !relayAt(l.t)) continue;
    stats.trips++;
    const offEv = w.relay.find((x) => x.t >= l.t && !x.on), tOff = offEv ? offEv.t : ende;
    if (tOff - l.t <= 10e3) continue;
    const cmds = rec.sw.filter((c) => !c.on && c.t >= l.t - 10 && c.t <= tOff);
    const bad = cmds.filter((c) => !wirkt(c));
    let gapOk = cmds.length > 0;
    for (let j = 1; j < cmds.length; j++) if (cmds[j].t - cmds[j - 1].t > 6.5e3) gapOk = false;
    const last = cmds[cmds.length - 1];
    // Aus-Befehle gingen verloren (absichtlich): in Ordnung, wenn das Skript alle 5 s nachschickt, bis eines wirkt oder das Relais
    // anders ausgeht (Timer, Stromausfall)
    const retryOk = bad.length && gapOk && last && cmds[0].t - l.t <= 1500 && (tOff - last.t <= 1500 || (bad.length === cmds.length && tOff - last.t <= 6.5e3));
    if (!retryOk) verstoss('aus-nach-schutz', l.t, ((tOff - l.t) / 1000).toFixed(1) + ' s bis Aus nach „' + norm(l.msg).slice(0, 60) + '“; Aus-Befehle ' + cmds.length + ', verloren ' + bad.length, lies(l.t - 60e3, tOff, ['sw', 'sys', 'uhr', 'rpc', 'store']).join(','));
  }
  // 4. Speicher: je Eintrag <= 1024 Byte (Versuch), Schreibbremse
  for (const o of rec.overs.slice(0, 3)) verstoss('speicher-1024', o.t, o.k + ' ' + o.n + ' Byte; größte Felder ' + o.gross, P.sArt === 'feindlich' || rec.inj['store.kaputt'] ? 'Speicher-Eingabe feindlich' : '');
  for (const k of Object.keys(w.maxStore)) if (w.maxStore[k] > 1024 && !rec.overs.length) verstoss('speicher-1024', ende, k + ' ' + w.maxStore[k]);
  // Schreibbremse an den Schreibvorgängen, die den Flash wirklich erreichten: höchstens 1 je Minute (außer Ende des Anlernens
  // und erstem nach einem Skriptstart), je 24-h-Fenster der Bremse (R.w24) höchstens 48 + 24; gleitend wird der Höchstwert
  // berichtet (Fensterwechsel: bis 48 + 48 + 24 möglich)
  const sw24 = { max: 0 }, writes = rec.store.filter((x) => x.k === 's' && x.f === 'ok');
  const forced = (t) => rec.log.some((l) => l.t <= t && l.t >= t - 1500 && /Angelernt: |Anlernen abgebrochen/.test(l.msg));
  for (let j = 1; j < writes.length; j++) {
    const a = writes[j - 1], b = writes[j];
    if (a.boot !== b.boot) continue;
    const neu = rec.starts.some((s) => s.t > a.t && s.t <= b.t);
    if (b.t - a.t < 59.5e3 && !neu && !forced(b.t)) verstoss('schreibbremse-minute', b.t, ((b.t - a.t) / 1000).toFixed(1) + ' s nach dem letzten Schreiben');
  }
  const fenster = {};
  for (const x of writes) { const k = x.boot + '/' + Math.floor(x.w24 || 0); (fenster[k] = fenster[k] || []).push(x); }
  for (const a of Object.values(fenster)) {
    const f = a.filter((x) => forced(x.t)).length;
    if (a.length > 72 + f) verstoss('schreibbremse-24h', a[72 + f].t, a.length + ' Schreibvorgänge in einem 24-h-Fenster der Bremse (' + f + ' Anlernen)', P.sArt === 'feindlich' || rec.inj['store.kaputt'] ? 'Speicher-Eingabe feindlich' : '');
  }
  for (let j = 0; j < writes.length; j++) {
    let n = 0, f = 0;
    for (let k = j; k < writes.length && writes[k].t < writes[j].t + D; k++) { if (writes[k].boot !== writes[j].boot) break; n++; if (forced(writes[k].t)) f++; }
    if (n > sw24.max) { sw24.max = n; sw24.t = writes[j].t; }
    if (n > 120 + f) { verstoss('schreibbremse-gleitend', writes[j].t, n + ' Schreibvorgänge in 24 h gleitend'); break; }
  }
  // Zustand gültig (endliche Zahlen, Konto 0..25 mm)
  for (const z of rec.zustand) {
    const ausS = /^S\./.test(z.f) && (P.sArt === 'feindlich' || rec.inj['store.kaputt']);
    verstoss('zustand', z.t, z.f + ' = ' + z.v, ausS ? 'Speicher-Eingabe feindlich' : lies(z.t - 10 * M, z.t, ['sw', 'sys', 'wx', 'uhr']).join(','));
  }
  for (const x of rec.evalErr) verstoss('eval-selbsttest', x.t, 'Script.Eval("selfTest()"): ' + x.e);
  // 5. LED höchstens 12 Wechsel in 24 h je Skriptlauf (außer Rot und Anlernen), Einstellungen höchstens 30 in 24 h je Skriptlauf
  const ledMax = { n: 0 }, cfgMax = { n: 0 };
  const byRun = (a) => { const m = {}; for (const x of a) (m[x.run] = m[x.run] || []).push(x); return m; };
  for (const [run, a] of Object.entries(byRun(rec.led.filter((x) => x.k !== 'throw')))) {
    for (let j = 0; j < a.length; j++) {
      const n = a.filter((x) => x.t < a[j].t && x.t > a[j].t - D).length;
      ledMax.n = Math.max(ledMax.n, n + 1);
      if (!a[j].rot && !a[j].lx && n >= 12) { verstoss('led-deckel', a[j].t, (n + 1) + '. LED-Wechsel in 24 h (Lauf ' + run + ')'); break; }
    }
  }
  for (const [run, a] of Object.entries(byRun(rec.cfgc.filter((x) => x.k !== 'throw')))) {
    const fen = {};                         // wie die Schreibbremse des Speichers: je 24-h-Fenster der Bremse (R.c24) 30,
    for (const x of a) { const k = Math.floor(x.c24 || 0); (fen[k] = fen[k] || []).push(x); }   // gleitend also bis 60
    for (const b of Object.values(fen)) if (b.length > 30) { verstoss('einstellungen-deckel', b[30].t, b.length + ' Einstellungs-Schreibvorgänge in einem 24-h-Fenster der Bremse (Lauf ' + run + ')'); break; }
    for (let j = 0; j < a.length; j++) {
      const n = a.filter((x) => x.t <= a[j].t && x.t > a[j].t - D).length;
      cfgMax.n = Math.max(cfgMax.n, n);
      if (n > 60) { verstoss('einstellungen-deckel', a[j].t, n + ' Einstellungs-Schreibvorgänge in 24 h gleitend (Lauf ' + run + ')'); break; }
    }
  }
  for (const [run, a] of Object.entries(byRun(rec.swcfg.filter((x) => x.k !== 'throw')))) {
    for (let j = 1; j < a.length; j++) if (a[j].t - a[j - 1].t < 3590e3) { verstoss('relais-einstellung-stuendlich', a[j].t, 'Switch.SetConfig nach ' + ((a[j].t - a[j - 1].t) / 1000).toFixed(0) + ' s (Lauf ' + run + ')'); break; }
  }
  // 6. Statustext: Text, höchstens 255 Byte; Diagnose-Seite: 200 oder 500, nie werfen, ändert S nicht
  if (rec.text.nonStr) verstoss('statustext-typ', ende, rec.text.nonStr + '× kein Text: ' + rec.text.bsp);
  if (rec.text.max > 255) verstoss('statustext-255', ende, rec.text.max + ' Byte: ' + rec.text.bsp.slice(0, 120));
  const info500 = [];
  for (const x of rec.info) {
    if (x.code === 200 && x.sent && !x.sG) continue;
    if (x.code === 500 && x.sent && !x.sG) { info500.push({ t: x.t, body: x.body }); continue; }
    verstoss('diagnose-seite', x.t, 'Code ' + x.code + (x.sG ? ', ändert S' : '') + (x.sent === false ? ', nicht gesendet' : '') + ': ' + x.body);
  }
  // 7. Automatik bei richtiger Uhr: nur 10:00 bis 12:30, nie bei Automatik aus, nie im Winter
  const auAt = (t) => { let v = { t: P.start, v: undefined }; for (const a of rec.au) { if (a.t > t) break; v = a; } return v; };
  for (const l of rec.log) {
    const m = /Pumpe an \((auto|retry)\)/.exec(l.msg);
    if (!m) continue;
    stats.auto++;
    // richtige Uhr: das Skript sah im Takt höchstens 2 min Abweichung, und der Status log nicht über die Uhr (sys)
    const ok = typeof l.u === 'number' && l.u > 0 && Math.abs(l.u - l.t / 1000) <= 120, li = lies(l.t - 30 * M, l.t, ['sys']);
    if (!ok || li.length) continue;
    stats.autoGeprueft++;
    const p = berlinParts(l.t), mn = p.hh * 60 + p.mm;
    const d0 = dayNo(P.start), so = P.sObj || {}, heute = dayNo(l.t) === d0 && P.sArt === 'gueltig' && (so.rc === d0 || (so.rt && so.fd === d0));
    const ursache = [heute ? 'gespeicherter Zustand von heute (rc/rt)' : ''].concat(lies(l.t - 6 * H, l.t, ['uhr', 'zeit'])).filter(Boolean).join(',');
    if (mn < 598 || mn >= 752) verstoss('automatik-zeit', l.t, 'Automatik (' + m[1] + ') um ' + p.hh + ':' + String(p.mm).padStart(2, '0'), ursache);
    if (p.m === 12 || p.m <= 2) verstoss('automatik-winter', l.t, 'Automatik (' + m[1] + ') am ' + p.date + ' ' + p.hh + ':' + String(p.mm).padStart(2, '0'), ursache);
    const a = auAt(l.t);
    if (a.v === false && l.t - a.t >= 15e3) verstoss('automatik-aus', l.t, 'Automatik (' + m[1] + ') obwohl Schalter seit ' + ((l.t - a.t) / 60000).toFixed(1) + ' min aus' + (l.h ? '' : ', Bedienfeld nicht verbunden'), lies(l.t - 2 * M, l.t, ['vc', 'cfg']).join(','));
  }
  // 8. Speicher-Stellvertreter: keine wachsenden Felder in R und S
  // R.starts zählt auch abgelehnte Starts der letzten Stunde (jeder Druck einer): Grenze großzügig, Wachstum je Takt fällt auf
  const GR = { 'R.lg[]': 6, 'R.fl[]': 5, 'R.kts[]': 5, 'R.starts[]': 40, 'R.ledN[]': 40, 'S.xe[]': 15, 'S.xw[]': 15, 'R.lg[]#': 91 };
  for (const [k, v] of Object.entries(rec.mem)) {
    const lim = GR[k] !== undefined ? GR[k] : (/\[\]$/.test(k) ? 20 : 400);
    if (v > lim) verstoss('speicher-proxy', ende, k + ' = ' + v + ' (Grenze ' + lim + ')', P.sArt === 'feindlich' || rec.inj['store.kaputt'] ? 'Speicher-Eingabe feindlich' : '');
  }
  // gefangene Fehler: jede Meldung „Fehler …“
  const fehler = {};
  for (const l of rec.log) if (/^\[BW\] Fehler/.test(l.msg)) { const n = norm(l.msg); if (!fehler[n]) fehler[n] = { n: 0, t: l.t, roh: l.msg.slice(0, 300) }; fehler[n].n++; }
  return { i: P.i, ws: P.ws, prof: P.prof, lv: P.lv, kat: P.kat, start: fmt(P.start), tage: P.tage, netz: P.netz, sArt: P.sArt, V, fehler, info500,
    msgs: Object.fromEntries(rec.msgs), inj: rec.inj, stats, text: rec.text.max, sw24: sw24.max, led: ledMax.n, cfg: cfgMax.n,
    store: Math.max(0, ...Object.values(w.maxStore)), mem: rec.mem, laeufe: stats.laeufe, crashed: !!w.crashed };
}

// ============================== Hauptprogramm ==============================
function zeigePlan(P) {
  console.log('Welt ' + P.i + ' Seed ' + P.ws + ' (Haupt-Seed ' + SEED + '): ' + fmt(P.start) + ', ' + P.tage + ' Tage, ' + P.kat + ', Profil ' + P.prof + ', Netz ' + P.netz);
  console.log('  Stufen: ' + KANAELE.map((c) => c + '=' + P.lv[c]).join(' ') + '; Speicher ' + P.sArt + ', Relais ' + P.swArt + ', Bedienfeld ' + Object.keys(P.vc).length + ' Teile, Zeitpläne ' + P.jobs.length);
  if (P.s) console.log('  s = ' + String(P.s).slice(0, 400));
  if (P.f) console.log('  f = ' + String(P.f).slice(0, 200));
  for (const e of P.ev) console.log('  ' + fmt(e.t) + ' ' + e.ch + ' ' + JSON.stringify(e, (k, v) => (k === 't' || k === 'ch' ? undefined : (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v))));
}
if (process.env.FUZZ_ARBEITER) {
  process.on('message', (m) => {
    if (m.stop) { process.exit(0); return; }
    let r;
    try { r = laufen(plan(m.i), false); } catch (e) { r = { i: m.i, V: [{ regel: 'fuzzer-intern', t: 0, zeit: '', text: String(e && e.stack || e).slice(0, 500), tags: '' }], fehler: {}, msgs: {}, inj: {}, stats: {}, mem: {}, info500: [] }; }
    process.send({ i: m.i, r });
  });
} else if (NUR) {
  const P = plan(NUR);
  zeigePlan(P);
  const r = laufen(P, true);
  console.log('\nErgebnis Welt ' + NUR + ': ' + (r.V.length ? r.V.length + ' Verstöße' : 'keine Verstöße') + ' (' + (r.ms / 1000).toFixed(1) + ' s)');
  for (const v of r.V) console.log('  ' + v.zeit + ' ' + v.regel + ': ' + v.text + (v.tags ? ' [' + v.tags + ']' : ''));
  for (const [k, f] of Object.entries(r.fehler)) console.log('  Fehler ×' + f.n + ': ' + f.roh);
  for (const x of r.info500) console.log('  Diagnose 500 ' + fmt(x.t) + ': ' + x.body);
  process.exit(r.V.length ? 1 : 0);
} else {
  const JOBS = Math.max(1, Math.min(+process.env.FUZZ_JOBS || os.cpus().length, 4)), JE = 25;
  const t0 = Date.now(), res = new Array(N + 1);
  let next = 1, live = 0, fertig = 0;
  console.log('Fuzzer: ' + N + ' Welten, Seed ' + SEED + ', ' + path.basename(FILE) + ', ' + JOBS + ' Prozesse');
  const spawn = () => {
    const c = fork(__filename, process.argv.slice(2), { env: Object.assign({}, process.env, { FUZZ_ARBEITER: '1' }) });
    let n = 0, cur = 0;
    live++;
    const give = () => { if (next <= N && n < JE) { cur = next++; n++; c.send({ i: cur }); } else { cur = 0; c.send({ stop: true }); } };
    c.on('message', (m) => {
      res[m.i] = m.r; fertig++;
      if (m.r.V && m.r.V.length) console.log('  Welt ' + m.i + ' (' + (m.r.start || '') + ', ' + (m.r.tage || '?') + ' T, ' + (m.r.prof || '') + '): ' + m.r.V.length + ' Verstöße: ' + [...new Set(m.r.V.map((v) => v.regel))].join(', '));
      else if (fertig % 20 === 0) console.log('  … ' + fertig + ' Welten (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
      give();
    });
    c.on('exit', (code) => {
      live--;
      if (cur && !res[cur]) res[cur] = { i: cur, V: [{ regel: 'fuzzer-intern', t: 0, zeit: '', text: 'Arbeitsprozess beendet (' + code + ')', tags: '' }], fehler: {}, msgs: {}, inj: {}, stats: {}, mem: {}, info500: [] };
      if (next <= N) spawn(); else if (!live) zusammenfassen(res.slice(1), (Date.now() - t0) / 1000);
    });
    give();
  };
  for (let j = 0; j < Math.min(JOBS, N); j++) spawn();
}

function zusammenfassen(res, sek) {
  const alle = [], fehler = {}, msgs = {}, inj = {}, info500 = {}, mem = {}, regeln = {}, hw = {};
  let tage = 0, laeufe = 0, auto = 0, autoG = 0, trips = 0;
  const hoch = (k, v, i) => { if (v > (hw[k] ? hw[k].v : -1)) hw[k] = { v, i }; };
  for (const r of res) {
    tage += r.tage || 0; laeufe += (r.stats && r.stats.laeufe) || 0; auto += (r.stats && r.stats.auto) || 0; autoG += (r.stats && r.stats.autoGeprueft) || 0;
    trips += (r.stats && r.stats.trips) || 0; hoch('text', r.text || 0, r.i); hoch('sw24', r.sw24 || 0, r.i); hoch('led', r.led || 0, r.i);
    hoch('cfg', r.cfg || 0, r.i); hoch('store', r.store || 0, r.i);
    hoch('max120', (r.stats && r.stats.max120) || 0, r.i); hoch('max130', (r.stats && r.stats.max130) || 0, r.i);
    for (const v of r.V || []) { alle.push(Object.assign({ welt: r.i, ws: r.ws }, v)); regeln[v.regel] = (regeln[v.regel] || 0) + 1; }
    for (const [k, f] of Object.entries(r.fehler || {})) { const x = fehler[k] || (fehler[k] = { n: 0, welten: 0, welt: r.i, ws: r.ws, t: f.t, roh: f.roh }); x.n += f.n; x.welten++; }
    for (const [k, n] of Object.entries(r.msgs || {})) msgs[k] = (msgs[k] || 0) + n;
    for (const [k, n] of Object.entries(r.inj || {})) inj[k] = (inj[k] || 0) + n;
    for (const x of r.info500 || []) { const k = norm(x.body); if (!info500[k]) info500[k] = { n: 0, welt: r.i, ws: r.ws, t: x.t, body: x.body }; info500[k].n++; }
    for (const [k, v] of Object.entries(r.mem || {})) mem[k] = Math.max(mem[k] || 0, v);
  }
  const kanal = {};
  for (const [k, n] of Object.entries(inj)) { const c = k.split('.')[0]; kanal[c] = (kanal[c] || 0) + n; }
  console.log('\n==== Fuzzer: ' + res.length + ' Welten, Haupt-Seed ' + SEED + ', ' + tage + ' simulierte Tage, ' + (sek / 60).toFixed(1) + ' min [' + path.basename(FILE) + ']');
  console.log('Eingriffe je Kanal: ' + Object.keys(kanal).sort().map((c) => c + ' ' + kanal[c]).join(' · ') + '; verschiedene Arten: ' + Object.keys(inj).length);
  if (process.env.FUZZ_EINGRIFFE) for (const [k, n] of Object.entries(inj).sort()) console.log('  ' + String(n).padStart(6) + '  ' + k);
  console.log('Läufe ' + laeufe + ', davon Automatik/Nachlauf ' + auto + ' (' + autoG + ' bei richtiger Uhr geprüft), Schutzabschaltungen ' + trips);
  const hv = (k, f) => (hw[k] ? (f ? hw[k].v.toFixed(f) : hw[k].v) + ' (Welt ' + hw[k].i + ')' : '-');
  console.log('Höchstwerte: Lauf ab Start/Übernahme ' + hv('max120', 1) + ' min, ab Ein mit Notabschaltung ' + hv('max130', 1) + ' min · Statustext ' + hv('text') +
    ' Byte · Speicher-Versuch ' + hv('store') + ' Byte · Schreibvorgänge in 24 h gleitend ' + hv('sw24') + ' · LED in 24 h ' + hv('led') + ' · Einstellungen in 24 h ' + hv('cfg'));
  const memK = ['R.lg[]', 'R.fl[]', 'R.kts[]', 'R.starts[]', 'R.ledN[]', 'S.xe[]', 'S.xw[]'];
  console.log('Speicher-Stellvertreter (größte Länge): ' + memK.map((k) => k + ' ' + (mem[k] || 0)).join(' · '));
  const R_ = ['absturz', 'firmware-grenzen', 'laufzeit-120', 'laufzeit-130', 'aus-nach-schutz', 'speicher-1024', 'schreibbremse-minute', 'schreibbremse-24h',
    'schreibbremse-gleitend', 'led-deckel', 'einstellungen-deckel', 'relais-einstellung-stuendlich', 'statustext-typ', 'statustext-255', 'diagnose-seite',
    'automatik-zeit', 'automatik-winter', 'automatik-aus', 'speicher-proxy', 'zustand', 'eval-selbsttest', 'fuzzer-intern'];
  console.log('Regeln: ' + R_.map((k) => k + (regeln[k] ? ' VERSTOSS ' + regeln[k] : ' ok')).join(' · '));
  if (alle.length) {                       // gleiche Regel, gleiches Muster: eine Zeile mit Anzahl und erstem Beispiel
    const gr = {};
    for (const v of alle) {
      const art = /unmöglich/.test(v.tags) ? 'unmögliche Eingabe beteiligt' : (v.tags.split(',')[0] || '').replace(/\(.*$/, '');
      const k = v.regel + ' | ' + norm(v.text.replace(/\(Ein .*$/, '').replace(/„.*“/, '')).replace(/#/g, '·').slice(0, 70) + ' | ' + art;
      const x = gr[k] || (gr[k] = { n: 0, welten: new Set(), v });
      x.n++; x.welten.add(v.welt);
    }
    console.log('\nVerstöße (' + alle.length + ', ' + Object.keys(gr).length + ' Muster):');
    for (const [k, x] of Object.entries(gr).sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      const v = x.v;
      console.log('  ' + v.regel + ' ×' + x.n + ' in ' + x.welten.size + ' Welten; zuerst Welt ' + v.welt + ' [Seed ' + v.ws + '] ' + v.zeit + ': ' + v.text.slice(0, 160) + (v.tags ? ' [' + v.tags.slice(0, 120) + ']' : ''));
    }
    if (process.env.FUZZ_ALLE) for (const v of alle) console.log('    Welt ' + v.welt + ' ' + v.zeit + ' ' + v.regel + ': ' + v.text + (v.tags ? ' [' + v.tags + ']' : ''));
  }
  const fk = Object.entries(fehler).sort((a, b) => b[1].n - a[1].n);
  console.log('\nGefangene Fehler („Fehler …“), verschieden: ' + fk.length);
  for (const [k, f] of fk) console.log('  ×' + f.n + ' in ' + f.welten + ' Welten, zuerst Welt ' + f.welt + ' [Seed ' + f.ws + '] ' + fmt(f.t) + ': ' + f.roh.slice(0, 200));
  const ik = Object.entries(info500);
  console.log('Diagnose-Seite mit Code 500, verschieden: ' + ik.length);
  for (const [k, x] of ik) console.log('  ×' + x.n + ', zuerst Welt ' + x.welt + ' [Seed ' + x.ws + '] ' + fmt(x.t) + ': ' + x.body.slice(0, 200));
  if (process.env.FUZZ_MELDUNGEN) { console.log('\nAlle Meldungen (normiert):'); for (const [k, n] of Object.entries(msgs).sort((a, b) => b[1] - a[1])) console.log('  ' + n + '  ' + k); }
  console.log('\nWiedergabe einer Welt: FUZZ_WELT=<n> node emu/fuzz.js ' + path.relative(process.cwd(), FILE) + ' ' + res.length + ' ' + SEED);
  console.log(`\n${res.length - res.filter((r) => r.V && r.V.length).length} von ${res.length} Welten ohne Regelverstoß, ${fk.length} verschiedene gefangene Fehler [${path.basename(FILE)}]`);
  process.exit(alle.length ? 1 : 0);
}
