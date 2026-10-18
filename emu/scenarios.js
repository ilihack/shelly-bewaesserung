'use strict';
/*
 * Szenarien für das Bewässerungsskript. Aufruf: node emu/scenarios.js [skriptdatei] [filter]
 * Jedes Szenario baut eine eigene Welt, lässt die Zeit laufen und prüft das Verhalten.
 */
const fs = require('fs');
const path = require('path');
const { World, berlinParts, berlinToUnixMs, berlinDateAddDays } = require('./shelly-emu');

const FILE = process.argv[2] || path.join(__dirname, '..', 'src', 'bewaesserung.js');
const FILTER = process.argv[3] || '';
const CODE = fs.readFileSync(FILE, 'utf8');
const H = 3600e3, M = 60e3, D = 86400e3;
const RATE = 8.6;                     // Regenrate ab Werk im Skript (mm/h, Düse 6.0)
const minFor = (mm) => mm / RATE * 60; // Laufzeit in min für eine Gabe

let failures = 0, passes = 0, maxTextAll = 0;
const report = [];
function T(y, m, d, hh, mm) { return berlinToUnixMs(y, m, d, hh || 0, mm || 0); }
function lt(w, t) { const p = berlinParts(t); return p.date + ' ' + String(p.hh).padStart(2, '0') + ':' + String(p.mm).padStart(2, '0'); }
function mkWorld(start, opts) {
  const w = new World(Object.assign({ code: CODE, start }, opts || {}));
  return w;
}
function check(name, cond, detail) {
  if (cond) { passes++; report.push('  ok   ' + name); }
  else { failures++; report.push('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}
function common(w, name) {
  check(name + ': kein Absturz', !w.crashed, w.crashed && w.crashed.err.split('\n')[0]);
  check(name + ': Statustext <= 255 Byte', (w.maxText || 0) <= 255, String(w.maxText));
  maxTextAll = Math.max(maxTextAll, w.maxText || 0);
  check(name + ': Grenzen (Timer<=5, RPC<=5, Handler<=5)', w.limits.timers <= 5 && w.limits.rpc <= 5 && w.limits.handlers <= 5,
    JSON.stringify(w.limits));
}
function runsInfo(w) { return w.runs().map(r => lt(w, r.on) + ' ' + (r.min ? r.min.toFixed(1) + 'min' : 'läuft') + ' (' + r.src + '->' + (r.offSrc || '') + ')').join('; '); }
function logHas(w, re) { return w.logs.some(l => re.test(l.msg)); }
function logsSince(w, t0) { return w.logs.filter(l => l.t >= t0).map(l => lt(w, l.t) + ' ' + l.msg).join('\n'); }
function weatherConst(et0, rain, prob, tmin) { return () => ({ et0, rain: rain || 0, prob: prob || 0, tmin: tmin === undefined ? 14 : tmin }); }

const scenarios = {};

// ------------------------------------------------------------------
scenarios.S01_inbetriebnahme = function () {
  const w = mkWorld(T(2027, 5, 10, 6, 0), { weather: weatherConst(3.5) });
  w.runFor(2 * M);
  check('S01 initial_state off', w.swCfg.initial_state === 'off', w.swCfg.initial_state);
  check('S01 auto_off 9600 s', w.swCfg.auto_off === true && w.swCfg.auto_off_delay === 9600);
  check('S01 Name gesetzt', w.swCfg.name === 'Brunnenpumpe');
  check('S01 Grenzen unverändert (Werk)', w.swCfg.power_limit === 2500 && w.swCfg.current_limit === 12);
  check('S01 7 Bedienelemente', Object.keys(w.vc).length === 7, Object.keys(w.vc).join(','));
  check('S01 Gruppe gefüllt', w.vc['group:200'] && w.vc['group:200'].value.length === 6);
  check('S01 Zustand gespeichert', !!w.state());
  check('S01 Status sichtbar', typeof w.vcText() === 'string' && w.vcText().length > 5, w.vcText());
  const cw = w.cfgWrites;
  w.powerFail(30e3); w.runFor(2 * M);
  check('S01 Neustart: keine erneuten Konfig-Schreibvorgänge', w.cfgWrites === cw, cw + ' -> ' + w.cfgWrites);
  check('S01 Neustart: Relais aus', w.dev.output === false);
  common(w, 'S01');
};

// ------------------------------------------------------------------
scenarios.S02_sommerwoche = function () {
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.run(T(2027, 6, 11, 23, 0));
  const runs = w.runs();
  const auto = runs.filter(r => r.src === 'loopback');
  check('S02 Läufe vorhanden', auto.length >= 3, runsInfo(w));
  check('S02 alle Starts zwischen 10:00 und 10:05', auto.every(r => { const p = berlinParts(r.on); return p.hh === 10 && p.mm < 5; }), runsInfo(w));
  const days = auto.map(r => berlinParts(r.on).date);
  check('S02 höchstens ein Lauf je Tag', new Set(days).size === days.length);
  check('S02 Laufzeit passt zu 5..15 mm', auto.every(r => r.min >= minFor(5) - 1 && r.min <= minFor(15) + 0.5), runsInfo(w));
  const st = w.state();
  check('S02 Normalleistung gelernt ~1320 W', st.pn > 1250 && st.pn < 1400, st.pn);
  // Bilanz: Verdunstung 10 Tage * 4.5 * 0.8 = 36 mm (Tag 1 ab Start nicht gezählt). Gegossen sollte etwa Verdunstung minus Restdefizit sein.
  const applied = auto.reduce((a, r) => a + r.min / 60 * RATE, 0);
  check('S02 gegossen plausibel (25..40 mm)', applied > 25 && applied < 40, applied.toFixed(1) + ' mm');
  const wpd = w.storageWrites.length / 10.7;
  check('S02 Schreibvorgänge je Tag <= 7', wpd <= 7, wpd.toFixed(1));
  common(w, 'S02');
  return { runs: runsInfo(w), writesPerDay: wpd.toFixed(1), status: w.vcText() };
};

// ------------------------------------------------------------------
scenarios.S03_regenprognose = function () {
  const wx = (ds) => ds === '2027-06-05' ? { et0: 2, rain: 14, prob: 85, tmin: 13 } : { et0: 4.5, rain: 0, prob: 10, tmin: 14 };
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: wx });
  // Defizit hochtreiben: 3 Tage ohne Gießen erlaubt? Automatik gießt ab 8 mm -> am 04.06.
  w.run(T(2027, 6, 5, 9, 59));
  const before = w.runs().length;
  w.run(T(2027, 6, 5, 23, 0));
  const on5 = w.runs().filter(r => berlinParts(r.on).date === '2027-06-05');
  check('S03 am Regentag (Prognose 14 mm, 85 %) nicht gegossen', on5.length === 0, runsInfo(w));
  check('S03 Status nennt Grund', /Regen erwartet|nicht nötig/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 6, 11, 0));
  const st = w.state();
  check('S03 Regen verbucht (Konto klein)', st.d < 5, 'd=' + st.d);
  common(w, 'S03');
  return { runs: runsInfo(w), before };
};

// ------------------------------------------------------------------
scenarios.S04_taster = function () {
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.run(T(2027, 6, 1, 18, 0));
  w.press();
  w.runFor(3 * M);
  const sec = w.dev.timer && w.dev.timer.dur;
  check('S04 Handgabe: Timer gesetzt (6 mm)', Math.abs(sec - minFor(6) * 60) <= 10, String(sec));
  w.runFor(2 * H);
  const r = w.runs();
  check('S04 Handgabe lief so lange wie 6 mm und endete', r.length === 1 && Math.abs(r[0].min - minFor(6)) < 1.5, runsInfo(w));
  // zweiter Druck mitten im Lauf
  w.press(); w.runFor(20 * M); w.press(); w.runFor(5 * M);
  const r2 = w.runs();
  check('S04 Stopp per Taster nach 20 min', r2.length === 2 && Math.abs(r2[1].min - 20) < 0.2, runsInfo(w));
  const st = w.state();
  const soll = 6 + 20 / 60 * RATE;
  check('S04 Gutschrift 6 mm + 20 min', Math.abs(st.pi - soll) < 0.5, 'pi=' + st.pi + ' soll ' + soll.toFixed(2));
  common(w, 'S04');
  return { runs: runsInfo(w), pi: st.pi };
};

// ------------------------------------------------------------------
function learnedWorld(start, wx) {
  const w = mkWorld(start, { weather: wx || weatherConst(4.5) });
  w.storage.s = JSON.stringify({ v: 1, t: Math.floor(start / 1000), d: 14, dp: -1, pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1, fc: 0, rt: 0, rm: 0, lr: '',
    la: 49.48, lo: 8.45, pz: 'DELudwigshafen am Rhein' });   // aufgespieltes Gerät: Ort ist bekannt
  return w;
}
scenarios.S05_trockenlauf = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  // Erster Tag: dp=-1 -> Konto wird bei 0 begonnen. Also Konto am ersten Tag setzen:
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.runFor(2 * M);
  w.run(T(2027, 6, 1, 10, 20));
  check('S05 Automatiklauf gestartet', w.dev.output === true, runsInfo(w));
  w.pump.mode = 'dry';
  const tDry = w.t;
  w.runFor(2 * M);
  const r = w.runs();
  const stop = r[0] && r[0].off;
  check('S05 Trockenlauf in < 20 s abgeschaltet', stop && stop - tDry < 20e3, stop ? ((stop - tDry) / 1000).toFixed(1) + ' s' : 'nicht abgeschaltet');
  let st = w.state();
  check('S05 Nachlauf geplant', st.rt > 0 && st.rm >= 2, JSON.stringify({ rt: st.rt, rm: st.rm }));
  check('S05 Status zeigt Störung', /Störung .*Trockenlauf/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 1, 15, 0));      // Brunnen weiter leer: Nachläufe 11:20 und 12:20 brechen ab, mehr gibt es nicht
  const n = w.runs().length;
  check('S05 zwei Nachläufe bis 12:30, keiner danach (insg. 3 Starts)', n === 3 &&
    w.runs().every(r => { const p = berlinParts(r.on); return p.hh < 12 || (p.hh === 12 && p.mm < 30); }), runsInfo(w));
  st = w.state();
  check('S05 danach kein weiterer Nachlauf', st.rt === 0);
  w.pump.mode = 'normal';
  w.run(T(2027, 6, 2, 12, 0));
  const d2 = w.runs().filter(x => berlinParts(x.on).date === '2027-06-02');
  check('S05 nächster Tag: Automatik läuft wieder', d2.length === 1, runsInfo(w));
  common(w, 'S05');
  return { runs: runsInfo(w) };
};
function dayNo(ms) { const p = berlinParts(ms); return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / D); }

// ------------------------------------------------------------------
scenarios.S06_luftgemisch = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 20));
  w.pump.mode = 'airmix';
  const t0 = w.t; w.runFor(3 * M);
  const r = w.runs()[0];
  check('S06 flatternde Leistung (Luft) erkannt', r && r.off && r.off - t0 < 60e3, r && r.off ? ((r.off - t0) / 1000).toFixed(0) + ' s' : 'läuft weiter');
  common(w, 'S06');
};

// ------------------------------------------------------------------
scenarios.S07_hahn_zu = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'closed';
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 10));
  const r = w.runs()[0];
  check('S07 zugedrehter Hahn nach Anlaufzeit erkannt (<= 60 s)', r && r.off && r.min * 60 <= 60, r ? r.min.toFixed(2) + ' min' : 'kein Lauf');
  common(w, 'S07');
};

// ------------------------------------------------------------------
scenarios.S08_blockiert = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'blocked';
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 10));
  const r = w.runs()[0];
  check('S08 Blockade binnen 5 s abgeschaltet (Firmware 12 A)', r && r.off && (r.off - r.on) < 5e3, r ? ((r.off - r.on) / 1000).toFixed(1) + ' s' : '');
  const st = w.state();
  check('S08 ein Nachlauf geplant', st.rt > 0, JSON.stringify(st));
  w.run(T(2027, 6, 1, 12, 0));
  check('S08 nach Nachlauf Schluss für heute', w.runs().length === 2 && w.state().rt === 0, runsInfo(w));
  // Variante: Firmware-Grenze höher (falls Werkseinstellung anders) -> Skript schaltet selbst
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30));
  w2.storage.s = w.storage.s; w2.swCfg.current_limit = 40; w2.swCfg.power_limit = 4000;
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14, ev: -1, rt: 0, fd: -1, fc: 0 }));
  w2.pump.mode = 'blocked'; w2.powerFail(1000); w2.run(T(2027, 6, 1, 10, 10));
  const r2 = w2.runs()[0];
  check('S08b Skript erkennt Blockade selbst (<= 6 s)', r2 && r2.off && (r2.off - r2.on) <= 6e3, r2 ? ((r2.off - r2.on) / 1000).toFixed(1) + ' s' : '');
  common(w, 'S08'); common(w2, 'S08b');
};

// ------------------------------------------------------------------
scenarios.S09_keine_last = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'noload';
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 10));
  const r = w.runs()[0];
  check('S09 Pumpe zieht keinen Strom: Abschaltung <= 10 s', r && r.off && (r.off - r.on) <= 10e3, r ? ((r.off - r.on) / 1000).toFixed(1) + ' s' : '');
  check('S09 Status nennt Ursache', /keinen Strom/.test(w.vcText()), w.vcText());
  common(w, 'S09');
};

// ------------------------------------------------------------------
scenarios.S10_relais_klebt = function () {
  const w = mkWorld(T(2027, 6, 1, 17, 0), { weather: weatherConst(4.5) });
  w.runFor(M);
  w.press(); w.runFor(5 * M); w.pump.weld = true; w.press(); w.runFor(2 * M);
  check('S10 Alarm im Status', /ALARM.*Relais klebt/.test(w.vcText()), w.vcText());
  check('S10 Skript schickt erneut AUS', logHas(w, /Relais klebt/));
  w.pump.weld = false; w.runFor(2 * M);
  check('S10 Alarm verschwindet, wenn Strom weg', !/ALARM/.test(w.vcText()), w.vcText());
  common(w, 'S10');
};

// ------------------------------------------------------------------
scenarios.S11_stromausfall_ohne_internet = function () {
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.run(T(2027, 6, 4, 2, 50));      // läuft drei Tage normal
  w.internet = false;               // Internet weg (Router), NTP damit auch
  w.run(T(2027, 6, 4, 3, 0));
  w.powerFail(10 * M);              // 03:00 - 03:10 Stromausfall
  w.run(T(2027, 6, 4, 18, 0));
  const r4 = w.runs().filter(r => berlinParts(r.on).date === '2027-06-04');
  check('S11 Uhr geschätzt gemeldet', /Uhr geschätzt/.test(w.vcText()) || logHas(w, /Zeitanker geschätzt/), w.vcText());
  const early = r4.filter(r => berlinParts(r.on).hh < 10);
  check('S11 nie vor 10:00 gestartet', early.length === 0, runsInfo(w));
  check('S11 an diesem Tag geprüft (ohne Internet)', logHas(w, /ohne Internet/));
  const late = r4.length ? (r4[0].on - T(2027, 6, 4, 10, 0)) / M : null;
  check('S11 Verspätung höchstens 6 h Anker + 10 min Ausfall + 21 min Wetterversuche', r4.length === 0 || late <= 391, late === null ? 'kein Lauf' : late.toFixed(0) + ' min');
  w.internet = true;
  w.run(T(2027, 6, 5, 12, 0));
  check('S11 Uhr wieder echt', !/Uhr geschätzt/.test(w.vcText()), w.vcText());
  common(w, 'S11');
  return { runs: runsInfo(w), lateMin: late };
};

// ------------------------------------------------------------------
scenarios.S12_stromausfall_im_lauf = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 11, 10));
  check('S12 Lauf aktiv vor Ausfall', w.dev.output === true);
  w.powerFail(5 * M);
  w.run(T(2027, 6, 1, 16, 0));
  const r = w.runs();
  check('S12 nach Ausfall kein Wiederanlauf am selben Tag', r.length === 1, runsInfo(w));
  const st = w.state();
  check('S12 Teilmenge gutgeschrieben (Stand nach 1 h)', Math.abs(st.pi - RATE) < 0.6, 'pi=' + st.pi);
  common(w, 'S12');
};

// ------------------------------------------------------------------
scenarios.S13_internet_3_tage_weg = function () {
  // echte Werte: Regen am 2. Offline-Tag 20 mm; Klimamittel kennt den Regen nicht
  const wx = (ds) => ds === '2027-07-06' ? { et0: 2.0, rain: 20, prob: 90, tmin: 15 } : { et0: 5.0, rain: 0, prob: 5, tmin: 16 };
  const w = mkWorld(T(2027, 7, 1, 6, 0), { weather: wx });
  w.run(T(2027, 7, 4, 22, 0));
  w.internet = false;
  w.run(T(2027, 7, 8, 6, 0));
  check('S13 ohne Internet weiter entschieden', logHas(w, /ohne Internet/));
  w.internet = true;
  w.run(T(2027, 7, 8, 11, 0));
  const st = w.state();
  const dp = berlinDateAddDays(berlinParts(w.t).date, -1);
  check('S13 nach Rückkehr alle Tage mit echten Daten verbucht', st.dp === dayNo(T(2027, 7, 7, 12)) && st.pi >= 0, JSON.stringify({ dp: st.dp, pi: st.pi, d: st.d, want: dp }));
  common(w, 'S13');
  return { runs: runsInfo(w), d: st.d };
};

// ------------------------------------------------------------------
scenarios.S14_zeitumstellung = function () {
  const w = mkWorld(T(2027, 3, 26, 6, 0), { weather: weatherConst(3.5) });
  w.storage.s = JSON.stringify({ v: 1, t: 0, d: 20, dp: dayNo(T(2027, 3, 25, 12)), pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1, fc: 0, rt: 0, rm: 0, lr: '' });
  w.powerFail(1000);
  w.run(T(2027, 4, 2, 12, 0));
  const evalTimes = w.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => berlinParts(l.t));
  check('S14 März: Prüfung immer 10:00-10:01 Ortszeit', evalTimes.length >= 6 && evalTimes.every(p => p.hh === 10 && p.mm <= 1), evalTimes.map(p => p.date + ' ' + p.hh + ':' + p.mm).join(', '));
  const w2 = mkWorld(T(2027, 10, 28, 6, 0), { weather: weatherConst(1.5) });
  w2.run(T(2027, 11, 3, 12, 0));
  const ev2 = w2.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => berlinParts(l.t));
  check('S14 Oktober: Prüfung immer 10:00-10:01 Ortszeit', ev2.length >= 6 && ev2.every(p => p.hh === 10 && p.mm <= 1), ev2.map(p => p.date + ' ' + p.hh + ':' + p.mm).join(', '));
  common(w, 'S14'); common(w2, 'S14b');
};

// ------------------------------------------------------------------
scenarios.S15_saison = function () {
  const w = mkWorld(T(2027, 2, 26, 6, 0), { weather: weatherConst(4.0) });
  w.storage.s = JSON.stringify({ v: 1, t: 0, d: 20, dp: dayNo(T(2027, 2, 25, 12)), pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1, fc: 0, rt: 0, rm: 0, lr: '' });
  w.powerFail(1000);
  w.run(T(2027, 2, 28, 22, 0));
  check('S15 Februar: keine Automatik', w.runs().length === 0, runsInfo(w));
  check('S15 Status Winterpause', /Winterpause/.test(w.vcText()), w.vcText());
  w.run(T(2027, 3, 6, 22, 0));
  check('S15 März: Automatik läuft wieder (Konto ab 0)', w.runs().length >= 1, runsInfo(w));
  const w2 = mkWorld(T(2027, 11, 29, 6, 0), { weather: weatherConst(4.0) });
  w2.storage.s = JSON.stringify({ v: 1, t: 0, d: 12, dp: dayNo(T(2027, 11, 28, 12)), pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1, fc: 0, rt: 0, rm: 0, lr: '' });
  w2.powerFail(1000);
  w2.run(T(2027, 12, 3, 12, 0));
  const r2 = w2.runs();
  check('S15 Ende November: Lauf möglich, Dezember nicht', r2.every(r => berlinParts(r.on).m === 11), runsInfo(w2));
  common(w, 'S15'); common(w2, 'S15b');
};

// ------------------------------------------------------------------
scenarios.S16_frost = function () {
  const w = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1 }));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 4, 10, 12, 0));
  check('S16 Frostprognose: kein Lauf', w.runs().length === 0, runsInfo(w));
  check('S16 Status Frostsperre', /Frostsperre/.test(w.vcText()), w.vcText());
  const w2 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 8 }));
  w2.ambient = () => 0;
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w2.internet = false;
  w2.powerFail(1000); w2.run(T(2027, 4, 10, 12, 0));
  check('S16b ohne Internet, Gerät kalt: kein Lauf', w2.runs().length === 0, runsInfo(w2));
  common(w, 'S16'); common(w2, 'S16b');
};

// ------------------------------------------------------------------
scenarios.S17_pause = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.setVc('number:201', 2);         // Pause 2 Tage (heute und morgen)
  w.run(T(2027, 6, 2, 22, 0));
  check('S17 während Pause kein Automatiklauf', w.runs().length === 0, runsInfo(w));
  check('S17 Anzeige zählt herunter', w.vc['number:201'].value === 1, String(w.vc['number:201'].value));
  w.run(T(2027, 6, 3, 12, 0));
  check('S17 danach wieder Automatik', w.runs().length === 1, runsInfo(w));
  check('S17 Anzeige 0', w.vc['number:201'].value === 0, String(w.vc['number:201'].value));
  common(w, 'S17');
};

// ------------------------------------------------------------------
scenarios.S18_automatik_aus = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.setVc('boolean:200', false);
  w.run(T(2027, 6, 2, 12, 0));
  check('S18 Automatik aus: kein Lauf', w.runs().length === 0, runsInfo(w));
  w.press(); w.runFor(10 * M);
  check('S18 Taster geht trotzdem', w.dev.output === true);
  common(w, 'S18');
};

// ------------------------------------------------------------------
scenarios.S19_regenrate = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 9 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.setVc('number:202', 9);         // nach Düsentausch 9 mm/h
  w.run(T(2027, 6, 1, 12, 0));
  const r = w.runs()[0];
  check('S19 9 mm bei 9 mm/h = 60 min', r && Math.abs(r.min - 60) < 1, runsInfo(w));
  common(w, 'S19');
};

// ------------------------------------------------------------------
scenarios.S20_neu_einlernen = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14, pn: 900 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.pressVcButton('button:200');
  w.runFor(M);
  check('S20 Normalleistung zurückgesetzt', w.state().pn === 0, String(w.state().pn));
  w.run(T(2027, 6, 1, 13, 0));
  check('S20 neu gelernt ~1320 W', Math.abs(w.state().pn - 1320) < 60, String(w.state().pn));
  common(w, 'S20');
};

// ------------------------------------------------------------------
scenarios.S21_viele_starts = function () {
  const w = mkWorld(T(2027, 6, 1, 15, 0), { weather: weatherConst(4.5) });
  w.runFor(M);
  for (let i = 0; i < 12; i++) { w.press(); w.runFor(90e3); w.press(); w.runFor(90e3); }
  const n = w.runs().filter(r => r.min > 0.2).length;
  check('S21 höchstens 10 Starts je Stunde laufen länger als 12 s', n <= 10, n + ' Läufe; ' + runsInfo(w));
  check('S21 Hinweis zu vielen Starts', logHas(w, /Zu viele Starts/));
  common(w, 'S21');
};

// ------------------------------------------------------------------
scenarios.S22_erststart_ohne_internet = function () {
  // trüber Tagesgang (6 K): die Uhr bleibt bei der Annahme; das Nachstellen am Tagesgang prüft S34b
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: () => ({ et0: 4.5, rain: 0, prob: 0, tmin: 14, tmax: 20 }) });
  // Gerät wird ohne Internet und ohne gespeicherten Zeitanker eingesteckt
  w.internet = false; w.storage = {}; w.powerFail(1000); w.runFor(5 * M);
  const p = berlinParts(w.devUnix() * 1000);
  check('S22 ohne Internet und Anker: Einstecken gilt als 15. April 10:00', p.date === '2026-04-15' && p.hh === 10 && p.mm <= 5,
    p.date + ' ' + p.hh + ':' + p.mm);
  check('S22 Status nennt angenommene Uhrzeit', /Uhr angenommen/.test(w.vcText()), w.vcText());
  check('S22 sofort geprüft (Einstecken = 10:00)', logHas(w, /Tagesprüfung.*ohne Internet/), logsSince(w, T(2027, 6, 1, 6, 0)).slice(-300));
  w.press(); w.runFor(5 * M);
  check('S22 Taster geht (6 mm)', w.dev.output && w.dev.timer && Math.abs(w.dev.timer.dur - minFor(6) * 60) <= 1, JSON.stringify(w.dev.timer && w.dev.timer.dur));
  w.runFor(9 * D);                  // offline: Klimamittel April 2,0 mm/Tag, Handgabe 6 mm angerechnet
  const auto = w.runs().filter(r => r.src === 'loopback');
  check('S22 Automatik gießt offline nach Klimamittel, zur Einsteck-Uhrzeit', auto.length >= 1 &&
    auto.every(r => { const q = berlinParts(r.on); return q.hh === 6 && q.mm <= 2; }), runsInfo(w));
  const t0 = w.t; w.internet = true; w.runFor(D);
  check('S22 mit Internet: echte Uhrzeit, Anzeige normal', !/Uhr angenommen|Uhr geschätzt/.test(w.vcText()) &&
    Math.abs(w.devUnix() - w.t / 1000) < 2, w.vcText());
  const st = w.state(), nach = w.runs().filter(r => r.on >= t0 && r.src === 'loopback');
  check('S22 Tagesmarken mitverschoben: keine 14 Tage nachgebucht, höchstens eine Gabe', st.dp >= dayNo(w.t) - 2 && st.dp <= dayNo(w.t) - 1 &&
    st.df === 0 && nach.length <= 1 && !logHas(w, /Uhr nach Tagesgang/), JSON.stringify({ dp: st.dp, d: st.d }) + ' ' + runsInfo(w).slice(-200));
  common(w, 'S22');
};

// ------------------------------------------------------------------
scenarios.S23_skript_neustart_im_lauf = function () {
  const w = mkWorld(T(2027, 6, 1, 17, 0), { weather: weatherConst(4.5) });
  w.runFor(M); w.press(); w.runFor(10 * M);
  const dur = w.dev.timer.dur;
  w.restartScript();
  w.runFor(5 * M);
  check('S23 Lauf übernommen, Timer nicht verlängert', w.dev.timer && w.dev.timer.dur === dur, w.dev.timer && w.dev.timer.dur + ' vs ' + dur);
  common(w, 'S23');
};

// ------------------------------------------------------------------
scenarios.S24_kaputte_wetterantwort = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  const orig = w.weatherBody.bind(w);
  let calls = 0;
  w.weatherBody = (url) => { calls++; return calls === 1 ? '{"daily": {"time": [' : (calls === 2 ? '{"daily":{"time":["1999-01-01"]}}' : orig(url)); };
  w.powerFail(1000); w.run(T(2027, 6, 1, 12, 0));
  check('S24 nach 2 kaputten Antworten trotzdem entschieden', logHas(w, /Tagesprüfung/), logsSince(w, T(2027, 6, 1, 6, 30)).slice(-600));
  check('S24 kein Absturz durch kaputtes JSON', !w.crashed);
  common(w, 'S24');
};

// ------------------------------------------------------------------
scenarios.S26_taster_sperren_spaete_pruefung = function () {
  // a) Winterpause: Taster startet eine Handgabe
  const w = mkWorld(T(2027, 1, 15, 12, 0), { weather: weatherConst(0.5) });
  w.runFor(2 * M); w.press(); w.runFor(2 * M);
  check('S26 Winterpause: Taster startet Handgabe (6 mm)', w.dev.output === true && w.dev.timer &&
    Math.abs(w.dev.timer.dur - minFor(6) * 60) <= 1, JSON.stringify(w.dev.timer));
  // b) Pause aktiv: keine Automatik, Taster startet
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w2.powerFail(1000); w2.runFor(3 * M);
  w2.setVc('number:201', 3);
  w2.run(T(2027, 6, 1, 12, 0));
  const vorher2 = w2.runs().length;
  w2.press(); w2.runFor(2 * M);
  check('S26 Pause: keine Automatik, Taster startet', vorher2 === 0 && w2.dev.output === true, runsInfo(w2));
  // c) Frostsperre: keine Automatik, Taster startet
  const w3 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1 }));
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w3.powerFail(1000); w3.run(T(2027, 4, 10, 12, 0));
  const vorher3 = w3.runs().length;
  w3.press(); w3.runFor(2 * M);
  check('S26 Frostsperre: keine Automatik, Taster startet', vorher3 === 0 && w3.dev.output === true, runsInfo(w3));
  // d) Gerät erst ab 11:45 an, Wetterdienst gestört: trotzdem vor 12:30 entschieden (ohne Internet)
  const w4 = learnedWorld(T(2027, 6, 1, 11, 45));
  w4.storage.s = JSON.stringify(Object.assign(JSON.parse(w4.storage.s), { t: Math.floor(T(2027, 6, 1, 9, 30) / 1000), dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w4.httpFail = true;
  w4.powerFail(1000); w4.run(T(2027, 6, 1, 15, 0));
  const ev = w4.logs.filter(l => /Tagesprüfung/.test(l.msg));
  check('S26 späte Prüfung, Wetterdienst gestört: vor 12:30 entschieden', ev.length === 1 &&
    (berlinParts(ev[0].t).hh === 11 || (berlinParts(ev[0].t).hh === 12 && berlinParts(ev[0].t).mm < 30)),
    logsSince(w4, T(2027, 6, 1, 11, 45)).slice(-500));
  check('S26 späte Prüfung: gegossen', w4.runs().length === 1, runsInfo(w4));
  // e) Skript-Neustart 40 s vor Laufende: Lauf endet planmäßig, keine neue Handgabe
  const w5 = mkWorld(T(2027, 6, 1, 17, 0), { weather: weatherConst(4.5) });
  w5.runFor(M); w5.press();
  w5.runFor(minFor(6) * M - 40e3);
  w5.restartScript(); w5.runFor(10 * M);
  const r5 = w5.runs();
  check('S26 Neustart kurz vor Laufende: Lauf endet planmäßig', r5.length === 1 && r5[0].off && Math.abs(r5[0].min - minFor(6)) < 1,
    runsInfo(w5));
  common(w, 'S26a'); common(w2, 'S26b'); common(w3, 'S26c'); common(w4, 'S26d'); common(w5, 'S26e');
};

// ------------------------------------------------------------------
scenarios.S27_taster_mehrfach_und_stopp_vom_pc = function () {
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  let minV = 0, maxD = 0;
  const watch = () => { const s = w.state(); if (s) { maxD = Math.max(maxD, s.d); minV = Math.min(minV, s.pi, s.d); } };
  // drei Abende hintereinander mehrmals drücken: 10 min und Stopp, volle Handgabe, an/aus nach 20 s
  for (let day = 1; day <= 3; day++) {
    w.run(T(2027, 6, day, 18, 0));
    w.press(); w.runFor(10 * M); w.press(); w.runFor(3 * M);
    w.press(); w.runFor(2 * H);
    w.press(); w.runFor(20e3); w.press(); w.runFor(3 * M);
    watch();
  }
  const hand = w.runs().filter(r => r.src === 'button');
  check('S27 jede Handgabe einzeln, keine summiert sich', hand.length === 9 && hand.every(r => r.min <= minFor(15) + 1), runsInfo(w));
  check('S27 Konto nie unter 0 oder über 25 mm', minV >= 0 && maxD <= 25, 'min ' + minV + ', max ' + maxD);
  const st = w.state();
  check('S27 nichts bleibt hängen (kein Nachlauf, keine Pause)', st.rt === 0 && st.pu === 0, JSON.stringify({ rt: st.rt, pu: st.pu }));
  w.run(T(2027, 6, 9, 12, 0));      // nicht mehr drücken: Automatik übernimmt
  const auto = w.runs().filter(r => r.src === 'loopback' && r.on > T(2027, 6, 4, 0, 0));
  check('S27 Automatik gießt danach wieder von selbst', auto.length >= 1, runsInfo(w));
  // Stopp vom PC oder aus der App mitten im Automatiklauf
  let day = 10; while (day < 20) { w.run(T(2027, 6, day, 10, 20)); if (w.dev.output) break; day++; }
  check('S27 Automatiklauf läuft', w.dev.output === true, runsInfo(w));
  w.setOutput(false, 'app', null);
  w.run(T(2027, 6, day, 23, 0));
  const that = w.runs().filter(r => berlinParts(r.on).date === berlinParts(T(2027, 6, day, 12, 0)).date);
  const s2 = w.state();
  check('S27 Stopp vom PC: kein Neustart am selben Tag, kein Nachlauf', that.length === 1 && s2.rt === 0, runsInfo(w));
  check('S27 Stopp vom PC: 20 min angerechnet', Math.abs(s2.pi - 20 / 60 * RATE) < 0.5, 'pi=' + s2.pi);
  common(w, 'S27');
};

// ------------------------------------------------------------------
scenarios.S28_led = function () {
  const w = learnedWorld(T(2027, 6, 1, 9, 0));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.runFor(10 * M);
  const off = () => w.plugsUi.leds.colors['switch:0'].off;
  check('S28 LED aus, wenn alles gut', w.plugsUi.leds.mode === 'switch' && off().brightness === 0, JSON.stringify(w.plugsUi.leds));
  check('S28 LED blau, solange die Pumpe läuft', JSON.stringify(w.plugsUi.leds.colors['switch:0'].on.rgb) === '[0,0,100]');
  w.run(T(2027, 6, 1, 10, 20)); w.pump.mode = 'dry'; w.runFor(5 * M);
  check('S28 LED violett nach Störung', JSON.stringify(off().rgb) === '[100,0,100]', JSON.stringify(off()));
  w.pump.mode = 'normal';
  w.run(T(2027, 6, 2, 0, 10));
  check('S28 LED am nächsten Tag wieder aus', off().brightness === 0, JSON.stringify(off()));
  w.internet = false; w.run(T(2027, 6, 3, 12, 0));
  check('S28 LED gelb ohne Internet', JSON.stringify(off().rgb) === '[100,70,0]', JSON.stringify(off()));
  w.internet = true; w.run(T(2027, 6, 4, 12, 0));
  check('S28 LED aus, sobald Internet zurück ist', off().brightness === 0, JSON.stringify(off()));
  const n = w.ledWrites.length; w.powerFail(1000); w.runFor(30 * M);
  check('S28 Neustart schreibt die LED nicht neu', w.ledWrites.length === n, n + ' -> ' + w.ledWrites.length);
  check('S28 wenige LED-Schreibvorgänge', w.ledWrites.length <= 6, String(w.ledWrites.length));
  common(w, 'S28');
  return { ledWrites: w.ledWrites.length };
};

// ------------------------------------------------------------------
scenarios.S29_waechter = function () {
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.runFor(5 * M);
  check('S29 Wächter-Zeitplan angelegt', w.jobs.length === 1 && /script\.start/i.test(JSON.stringify(w.jobs[0].calls)), JSON.stringify(w.jobs));
  w.powerFail(1000); w.runFor(5 * M);
  check('S29 Neustart legt keinen zweiten an', w.jobs.length === 1, String(w.jobs.length));
  w.run(T(2027, 6, 3, 12, 0));
  w.stopScript();
  w.run(T(2027, 6, 5, 9, 0));
  check('S29 stehendes Skript gießt nicht', w.runs().filter(r => r.on > T(2027, 6, 3, 12, 0)).length === 0, runsInfo(w));
  w.fireSchedules(); w.run(T(2027, 6, 6, 12, 0));
  check('S29 nach Start durch den Zeitplan gießt es wieder', w.runs().filter(r => r.on > T(2027, 6, 5, 9, 0)).length >= 1, runsInfo(w));
  common(w, 'S29');
};

// ------------------------------------------------------------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// ------------------------------------------------------------------
scenarios.S30_regen_angekuendigt_nicht_gekommen = function () {
  // a) 10:00 Regen 90 %, 12 mm angekündigt -> keine Gabe; um 11:00 ist die Prognose abgesagt -> sofort gießen
  const dry = () => ({ et0: 4.5, rain: 0, prob: 10, tmin: 14 });
  const w = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 10 }));
  w.forecast = () => (w.t < T(2027, 6, 1, 11, 0) ? { rain: 12, prob: 90 } : { rain: 0.5, prob: 20 });
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 30));
  check('S30 Regen angekündigt: um 10:00 keine Gabe', w.runs().length === 0 && /Regen erwartet/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 1, 12, 30));
  const r = w.runs();
  check('S30 Regen bei der Nachprüfung 11:05 abgesagt: sofort nachgeholt', r.length === 1 && berlinParts(r[0].on).hh === 11 &&
    berlinParts(r[0].on).mm >= 5 && berlinParts(r[0].on).mm < 8, runsInfo(w));
  check('S30 Status nennt die Absage', /Regen abgesagt/.test(w.vcText()) || /Regen abgesagt/.test(w.logs.map(l => l.msg).join('|')), w.vcText());
  // b) Prognose bleibt den ganzen Tag, Regen kommt nicht -> 11:00 und 12:00 bestätigt, am Folgetag zählt sie nicht
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 10 }));
  w2.forecast = () => ({ rain: 12, prob: 90 });
  w2.powerFail(1000); w2.run(T(2027, 6, 1, 12, 30));
  check('S30b stündlich nachgesehen, Regen weiter erwartet: keine Gabe', w2.runs().length === 0 && /12:05 bestätigt/.test(w2.vcText()) &&
    w2.logs.filter(l => /bestätigt/.test(l.msg)).length === 2, w2.vcText());
  w2.run(T(2027, 6, 2, 12, 0));
  const r2 = w2.runs();
  check('S30b Folgetag: Regen blieb aus, Prognose zählt nicht, volle Gabe', r2.length === 1 && berlinParts(r2[0].on).hh === 10 &&
    r2[0].min > minFor(12.5), runsInfo(w2));
  check('S30b Status nennt den ausgebliebenen Regen', /gestern Regen ausgeblieben/.test(w2.vcText()), w2.vcText());
  // c) Prognose ab 11:00 abgesagt, aber der Wetterdienst antwortet nicht mehr -> bleibt bei der Entscheidung von 10:00
  const w3 = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 10 }));
  w3.forecast = () => (w3.t < T(2027, 6, 1, 11, 0) ? { rain: 12, prob: 90 } : { rain: 0.5, prob: 20 });
  w3.powerFail(1000); w3.run(T(2027, 6, 1, 10, 30)); w3.httpFail = true; w3.run(T(2027, 6, 1, 13, 0));
  check('S30c Nachprüfung ohne Antwort: keine Gabe, kein Absturz', w3.runs().length === 0, runsInfo(w3));
  common(w, 'S30'); common(w2, 'S30b'); common(w3, 'S30c');
  return { runs: runsInfo(w) + ' | ' + runsInfo(w2) };
};

// ------------------------------------------------------------------
scenarios.S31_wochenlang_ohne_wetterdienst = function () {
  // Uhr per Zeitserver da, aber der Wetterdienst antwortet acht Wochen nicht (früher: nach ~2 Wochen kein Gießen mehr)
  const wx = () => ({ et0: 4.4, rain: 0, prob: 0, tmin: 12, tmax: 24 });
  const w = mkWorld(T(2027, 5, 1, 0, 0), { weather: wx });
  w.run(T(2027, 5, 4, 0, 0)); w.httpFail = true;
  w.run(T(2027, 6, 29, 0, 0));
  const off = w.runs().filter(r => r.on >= T(2027, 5, 4, 0, 0));
  const wochen = new Set(off.map(r => Math.floor((r.on - T(2027, 5, 4, 0, 0)) / (7 * D))));
  check('S31 ohne Wetterdienst jede Woche gegossen (8 Wochen)', wochen.size === 8, [...wochen].join(',') + ' | ' + runsInfo(w).slice(-300));
  const mm = off.reduce((a, r) => a + (r.min || 0) / 60 * RATE, 0), soll = 4.4 * 0.85 * 56;
  check('S31 gegossene Menge passt zur geschätzten Verdunstung (±25 %)', Math.abs(mm / soll - 1) <= 0.25, mm.toFixed(0) + ' von ' + soll.toFixed(0) + ' mm');
  check('S31 Status ohne Internet', /ohne Internet/.test(w.vcText()), w.vcText());
  const st1 = w.state();
  check('S31 Schätzungen gemerkt (höchstens 14 Tage)', st1.xa >= 0 && st1.xe.length >= 1 && st1.xe.length <= 14, JSON.stringify({ xa: st1.xa, n: st1.xe.length }));
  w.httpFail = false; w.run(T(2027, 7, 1, 12, 0));
  const st = w.state();
  check('S31 Internet zurück: Schätzungen mit echten Daten korrigiert', st.xa === -1 && st.xe.length === 0 && st.dp === dayNo(T(2027, 6, 30, 12)),
    JSON.stringify({ xa: st.xa, n: st.xe.length, dp: st.dp }));
  check('S31 Gerät hat seine Eigenwärme gelernt', Math.abs(st.ob - 14) <= 1.5 && Math.abs(st.oa - 14) <= 1.5, JSON.stringify({ ob: st.ob, oa: st.oa }));
  common(w, 'S31');
  return { mm: mm.toFixed(0), soll: soll.toFixed(0) };
};

// ------------------------------------------------------------------
scenarios.S32_frost_ohne_internet_eigenwaerme = function () {
  // Gerät mit 25 K Eigenwärme: lernt sie online, erkennt ohne Internet eine Frostnacht und eine milde Nacht
  const wx = (ds) => ds === '2027-04-06' ? { et0: 2.6, rain: 0, prob: 0, tmin: 0.5, tmax: 12 } :
    (ds === '2027-04-07' ? { et0: 2.6, rain: 0, prob: 0, tmin: 9, tmax: 20 } : { et0: 2.6, rain: 0, prob: 0, tmin: 8, tmax: 18 });
  const w = mkWorld(T(2027, 4, 1, 0, 0), { weather: wx, selfHeat: 25 });
  w.run(T(2027, 4, 5, 12, 0));
  const st = w.state();
  check('S32 Eigenwärme gelernt (Tief ~25 K, Hoch ~25 K)', Math.abs(st.ob - 25) <= 1.5 && Math.abs(st.oa - 25) <= 1.5, JSON.stringify({ ob: st.ob, oa: st.oa }));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { d: 14 })); w.restartScript();
  w.run(T(2027, 4, 5, 20, 0)); w.httpFail = true;
  w.run(T(2027, 4, 6, 12, 0));
  const r6 = w.runs().filter(r => berlinParts(r.on).date === '2027-04-06');
  check('S32 Frostnacht ohne Internet (0,5 °C, Gerät ~25 °C): kein Lauf', r6.length === 0 && /Frostsperre \(geschätzt/.test(w.vcText()), w.vcText());
  w.run(T(2027, 4, 7, 12, 0));
  const r7 = w.runs().filter(r => berlinParts(r.on).date === '2027-04-07');
  check('S32 milde Nacht ohne Internet (9 °C): gegossen', r7.length === 1, runsInfo(w));
  common(w, 'S32');
};

// ------------------------------------------------------------------
scenarios.S33_verdunstung_ohne_internet_nach_temperatur = function () {
  // Juni, Monatsmittel 4,5 mm und 26,3 °C: Hitzetag 35 °C verbucht mehr, kühler Tag 18 °C weniger
  const wx = (ds) => ds === '2027-06-05' ? { et0: 7, rain: 0, prob: 0, tmin: 20, tmax: 35 } :
    (ds === '2027-06-06' ? { et0: 2, rain: 0, prob: 0, tmin: 12, tmax: 18 } : { et0: 4.5, rain: 0, prob: 0, tmin: 15, tmax: 27 });
  const w = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w.run(T(2027, 6, 4, 22, 0)); w.httpFail = true;
  w.run(T(2027, 6, 7, 11, 0));
  const st = w.state(), e5 = st.xe[dayNo(T(2027, 6, 5, 12)) - st.xa], e6 = st.xe[dayNo(T(2027, 6, 6, 12)) - st.xa];
  // ohne Internet +10 % (OFF_ET); der kühle Tag folgt auf den heißen, sein Höchstwert liegt darum kurz nach Mitternacht
  const mittel = 4.5 * 0.85 * 1.1, hot = mittel * (1 + 0.06 * (35 - 26.3));
  check('S33 Hitzetag ohne Internet: mehr verbucht als das Monatsmittel', e5 > mittel + 1 && Math.abs(e5 - hot) <= 0.4,
    e5 + ' statt ' + hot.toFixed(1) + ' (Monatsmittel ' + mittel.toFixed(1) + ')');
  check('S33 kühler Tag ohne Internet: weniger verbucht', e6 < mittel * 0.7 && e6 >= mittel * 0.5 - 0.1, e6 + ' (Monatsmittel ' + mittel.toFixed(1) + ')');
  common(w, 'S33');
};

// ------------------------------------------------------------------
scenarios.S34_uhr_nach_tagesgang = function () {
  // a) klare Tage; nachts Strom- und Internetausfall 4 h, Internet bleibt drei Tage weg: Uhr geht stark nach
  const wx = () => ({ et0: 4.5, rain: 0, prob: 0, tmin: 10, tmax: 28 });
  const w = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w.run(T(2027, 6, 4, 1, 0)); w.internet = false; w.powerFail(4 * H);
  w.run(T(2027, 6, 8, 0, 0));
  const fix = w.logs.filter(l => /Uhr nach Tagesgang/.test(l.msg));
  check('S34 Uhr am Tagesgang nachgestellt', fix.length >= 1, logsSince(w, T(2027, 6, 4, 0, 0)).slice(-400));
  // Anker-Uhr geht nur nach; nach dem Stellen liegt sie 1 h hinter dem errechneten Wert. Der Tiefpunkt streut
  // (DWD: in 5 % der Fälle mehr als 1 h vor dem Sonnenaufgang), im Emulator bis gut 1 h: höchstens 30 min zu früh
  const tFix = fix.length ? fix[0].t : Infinity, auto = w.runs().filter(r => r.src === 'loopback');
  const vm = (r) => { const p = berlinParts(r.on); return p.hh * 60 + p.mm; };
  check('S34 vor dem Stellen nie vor 10:00', auto.filter(r => r.on < tFix).every(r => vm(r) >= 600), runsInfo(w));
  check('S34 nach dem Stellen vormittags gegossen (09:30 bis 11:30)', auto.some(r => r.on > tFix) &&
    auto.filter(r => r.on > tFix).every(r => vm(r) >= 570 && vm(r) <= 690), runsInfo(w));
  // b) erster Start ohne Internet um 16:00 (gilt als 10:00): Tageszeit wird am Tagesgang korrigiert
  const w2 = mkWorld(T(2027, 6, 1, 15, 0), { weather: wx });
  w2.internet = false; w2.storage = {}; w2.run(T(2027, 6, 1, 16, 0)); w2.powerFail(1000);
  w2.run(T(2027, 6, 6, 0, 0));
  const fix2 = w2.logs.filter(l => /Uhr nach Tagesgang/.test(l.msg));
  const a2 = w2.runs().filter(r => r.on >= T(2027, 6, 4, 0, 0) && r.src === 'loopback');
  check('S34b angenommene Uhr: Tageszeit nach Tagesgang korrigiert', fix2.length >= 1 && /Uhr angenommen/.test(w2.vcText()), w2.vcText());
  check('S34b danach vormittags gegossen statt um 16:00', a2.length >= 1 && a2.every(r => { const h = berlinParts(r.on).hh; return h >= 8 && h <= 11; }), runsInfo(w2));
  common(w, 'S34'); common(w2, 'S34b');
  return { runs: runsInfo(w), fix: fix.map(l => lt(w, l.t) + ' ' + l.msg).join('; '), fix2: fix2.map(l => lt(w2, l.t) + ' ' + l.msg).join('; ') };
};

// ------------------------------------------------------------------
scenarios.S35_handgabe_um_zehn = function () {
  // Handgabe 09:55 gestartet, 10:05 wieder gestoppt: geprüft wird danach, der Rest kommt sofort
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 9, 55)); w.press();
  w.run(T(2027, 6, 1, 10, 5)); w.press();
  w.run(T(2027, 6, 1, 12, 0));
  const r = w.runs();
  check('S35 Prüfung nach der Handgabe: Rest sofort gegossen', r.length === 2 && r[1].src === 'loopback' &&
    r[1].on - r[0].off < 5 * M && Math.abs(r[1].min - minFor(14 - 10 / 60 * RATE)) < 2, runsInfo(w));
  common(w, 'S35');
};

// ------------------------------------------------------------------
scenarios.S36_automatik_aus_beendet_lauf = function () {
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 20));
  check('S36 Automatiklauf läuft', w.dev.output === true, runsInfo(w));
  w.setVc('boolean:200', false); w.runFor(2 * M);
  check('S36 Automatik aus: laufende Automatikgabe endet', w.dev.output === false && /Automatik aus/.test(w.vcText()), w.vcText());
  const st = w.state();
  check('S36 Gegossenes angerechnet, kein Nachlauf', st.rt === 0 && st.pi > 2.5 && st.pi < 3.5, JSON.stringify({ pi: st.pi, rt: st.rt }));
  w.setVc('boolean:200', true); w.press(); w.runFor(2 * M);
  check('S36 Handgabe läuft trotz vorher ausgeschalteter Automatik', w.dev.output === true);
  common(w, 'S36');
};

// ------------------------------------------------------------------
scenarios.S37_skript_neustart_bei_geschaetzter_uhr = function () {
  // Strom 8 h weg, Internet bleibt weg; um 09:10 startet nur das Skript neu (Absturz, Wächter): die Uhr bleibt geschätzt
  const wx = () => ({ et0: 4.5, rain: 0, prob: 0, tmin: 10, tmax: 28 });
  const w = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w.run(T(2027, 6, 4, 1, 0)); w.internet = false; w.powerFail(8 * H);
  w.run(T(2027, 6, 4, 9, 10)); w.restartScript(); w.runFor(2 * M);
  check('S37 nach Skript-Neustart weiter „Uhr geschätzt“', /Uhr geschätzt/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 9, 0, 0));
  const fix = w.logs.filter(l => /Uhr nach Tagesgang/.test(l.msg));
  const tFix = fix.length ? fix[0].t : Infinity, auto = w.runs().filter(r => r.src === 'loopback' && r.on > tFix);
  const vm = (r) => { const p = berlinParts(r.on); return p.hh * 60 + p.mm; };
  check('S37 Uhr am Tagesgang gestellt, danach vormittags gegossen', fix.length >= 1 && auto.length >= 1 &&
    auto.every(r => vm(r) >= 570 && vm(r) <= 690), runsInfo(w) + ' | ' + fix.map(l => lt(w, l.t)).join(','));
  w.internet = true; w.run(T(2027, 6, 9, 1, 0));
  check('S37 Zeitserver zurück: Uhr wieder echt', !/Uhr geschätzt/.test(w.vcText()) && w.state().ce === 0, w.vcText());
  common(w, 'S37');
  return { runs: runsInfo(w), fix: fix.map(l => lt(w, l.t) + ' ' + l.msg).join('; ') };
};

// ------------------------------------------------------------------
scenarios.S38_internet_ohne_zeitserver = function () {
  // nach dem Stromausfall geht der Wetterdienst wieder, der Zeitserver nicht: die Uhr gilt weiter als geschätzt
  const wx = () => ({ et0: 4.5, rain: 0, prob: 0, tmin: 10, tmax: 28 });
  const w = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w.run(T(2027, 6, 4, 1, 0)); w.ntp = false; w.powerFail(6 * H);
  w.run(T(2027, 6, 4, 12, 0));
  check('S38 Wetterdienst da, Zeitserver nicht: „Uhr geschätzt“', /Uhr geschätzt/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 8, 0, 0));
  const fix = w.logs.filter(l => /Uhr nach Tagesgang/.test(l.msg));
  check('S38 Uhr trotzdem am Tagesgang gestellt', fix.length >= 1, logsSince(w, T(2027, 6, 4, 0, 0)).slice(-300));
  common(w, 'S38');
  return { runs: runsInfo(w) };
};

// ------------------------------------------------------------------
scenarios.S39_regenprognose_und_deckel = function () {
  // a) Defizit 20 mm, 4 mm Regen angekündigt: gegeben werden 15 mm wie ohne Prognose (Deckel). Am Folgetag 20 mm bei 95 %:
  //    die Prognose muss zählen, gestern hat sie ja nichts gekürzt
  const dry = () => ({ et0: 4.5, rain: 0, prob: 10, tmin: 14, tmax: 26 });
  const w = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w.forecast = (ds) => ds === '2027-06-01' ? { rain: 4, prob: 70 } : (ds === '2027-06-02' ? { rain: 20, prob: 95 } : {});
  w.powerFail(1000); w.run(T(2027, 6, 2, 13, 0));
  const r = w.runs();
  check('S39 Deckel statt Prognose: Folgetag zählt die Regenprognose', r.length === 1 && berlinParts(r[0].on).d === 1, runsInfo(w));
  // b) bei der Nachprüfung abgesagt und volle Gabe gegossen: am Folgetag zählt die Prognose wieder
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w2.forecast = (ds) => ds === '2027-06-01' ? (w2.t < T(2027, 6, 1, 11, 0) ? { rain: 18, prob: 90 } : { rain: 0, prob: 10 }) :
    (ds === '2027-06-02' ? { rain: 20, prob: 95 } : {});
  w2.powerFail(1000); w2.run(T(2027, 6, 2, 13, 0));
  const r2 = w2.runs();
  check('S39b nach Absage bei der Nachprüfung: Folgetag zählt die Regenprognose', r2.length === 1 && berlinParts(r2[0].on).d === 1, runsInfo(w2));
  // c) Wetterdienst antwortet nicht, die Prüfung beginnt 12:29: nach 12:30 startet nichts mehr
  const w3 = learnedWorld(T(2027, 6, 1, 12, 29) + 10e3, dry);   // Uhr ab 12:29:25, Abruf 12:29:44, Antwort bleibt 20 s aus
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14, t: 0 }));
  w3.httpFail = true; w3.run(T(2027, 6, 1, 13, 0));
  check('S39c Abruf bis nach 12:30: kein Start mehr', w3.runs().length === 0 &&
    w3.logs.some(l => /vorbei, nicht mehr gestartet/.test(l.msg)), runsInfo(w3) + ' | ' + w3.vcText());
  common(w, 'S39'); common(w2, 'S39b'); common(w3, 'S39c');
  return { runs: runsInfo(w) + ' | ' + runsInfo(w2) };
};

// ------------------------------------------------------------------
scenarios.S40_eigenwaerme_nach_uhrsprung = function () {
  // frisches Gerät, nachts Strom und Internet weg: die Tage unter geschätzter Uhr lernen die Eigenwärme nicht
  const wx = (ds) => ({ et0: 4.5, rain: 0, prob: 0, tmin: ds === '2027-06-02' ? 15 : (ds === '2027-06-03' ? 8 : 12), tmax: 26 });
  const w = mkWorld(T(2027, 6, 1, 12, 0), { weather: wx });
  w.run(T(2027, 6, 2, 1, 0)); w.internet = false; w.powerFail(8 * H);
  w.run(T(2027, 6, 3, 9, 30)); w.internet = true; w.run(T(2027, 6, 5, 10, 30));
  const st = w.state();
  check('S40 Eigenwärme nicht aus verschobenen Tagen gelernt', (st.ob === -99 || Math.abs(st.ob - 14) <= 2) &&
    (st.oa === -99 || Math.abs(st.oa - 14) <= 2), JSON.stringify({ ob: st.ob, oa: st.oa }));
  common(w, 'S40');
};

// ------------------------------------------------------------------
scenarios.S41_ort_einstellen = function () {
  // a) frisches Gerät mit Internet: Ortsname wird einmal aufgelöst und gespeichert, das Wetter kommt für diesen Ort
  const w = learnedWorld(T(2027, 6, 1, 6, 30), weatherConst(4.5));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { la: null, lo: null, pz: '' }));   // frisch
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 30));
  const st = w.state(), wx = w.http.filter(h => /api\.open-meteo\.com\/v1\/forecast/.test(h.url));
  check('S41 Ort aufgelöst und gespeichert', st.la === 49.48 && st.lo === 8.45 && /Ludwigshafen am Rhein/.test(st.pz), JSON.stringify(st));
  check('S41 Wetter für den Ort, Zeitzone des Ortes', wx.length >= 1 && wx.every(h => /latitude=49\.48&longitude=8\.45/.test(h.url) && /timezone=auto/.test(h.url)),
    wx.map(h => h.url).join(' '));
  w.powerFail(1000); w.run(T(2027, 6, 2, 10, 30));
  check('S41 nach Neustart keine neue Ortsabfrage', w.http.filter(h => /geocoding/.test(h.url)).length === 1, String(w.http.filter(h => /geocoding/.test(h.url)).length));
  // b) Ort mit Umlaut: richtig kodiert
  const w2 = mkWorld(T(2027, 6, 1, 6, 30), { weather: weatherConst(4.5), code: CODE.replace('"Ludwigshafen am Rhein"',
    /min\.js$/.test(FILE) ? '"M\\xC3\\xBCnchen"' : '"M\u00fcnchen"') });   // Gerätefassung: UTF-8-Bytes wie tools/build.js
  w2.run(T(2027, 6, 1, 7, 0));
  check('S41b Umlaut im Ortsnamen', w2.state().la === 48.14 && w2.http.some(h => /name=M%C3%BCnchen/.test(h.url)), w2.http.map(h => h.url).join(' '));
  // c) unbekannter Ort: keine Koordinaten, Automatik rechnet wie ohne Internet, Selbsttest meldet den Fehler
  const w3 = learnedWorld(T(2027, 6, 1, 6, 30), weatherConst(4.5));
  w3.code = CODE.replace('"Ludwigshafen am Rhein"', '"Nirgendwo"');
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w3.powerFail(1000); w3.run(T(2027, 6, 1, 10, 30));
  const ev3 = w3.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg).join(' | ');
  check('S41c unbekannter Ort: gegossen wie ohne Internet', /ohne Internet/.test(ev3) && w3.runs().length === 1, ev3);
  check('S41c Selbsttest meldet den Ort', /Ort unbekannt/.test(String(w3.eval('selfTest()'))), String(w3.eval('selfTest()')));
  // d) Koordinaten eingetragen: keine Abfrage
  const c4 = CODE.replace('LAT: null, LON: null', 'LAT: 49.51, LON: 8.55')            // Quelltext
    .replace(/("Ludwigshafen am Rhein",[\w$]+:"DE",[\w$]+:)null,([\w$]+:)null/, '$149.51,$28.55'); // Gerätefassung
  const w4 = mkWorld(T(2027, 6, 1, 6, 30), { weather: weatherConst(4.5), code: c4 });
  w4.run(T(2027, 6, 1, 10, 30));
  check('S41d Koordinaten eingetragen: keine Ortsabfrage', !w4.http.some(h => /geocoding/.test(h.url)) &&
    w4.http.some(h => /latitude=49\.51&longitude=8\.55/.test(h.url)), w4.http.map(h => h.url).join(' '));
  common(w, 'S41'); common(w2, 'S41b'); common(w3, 'S41c'); common(w4, 'S41d');
};

// ------------------------------------------------------------------
scenarios.S42_frostwert_fehlt = function () {
  // Wetterdienst liefert für heute keinen Tiefstwert (null): die Frostsperre fällt auf den Gerätefühler zurück
  const cold = () => ({ et0: 2, rain: 0, prob: 0, tmin: -3, tmax: 9 });
  const w = learnedWorld(T(2027, 4, 9, 6, 30), cold);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 4, 8, 12)), d: 14, ob: 14, oa: 14 }));
  w.forecast = () => ({ tmin: null });
  w.powerFail(1000); w.run(T(2027, 4, 10, 6, 30)); w.powerFail(1000); w.run(T(2027, 4, 10, 12, 0));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg);
  check('S42 Tiefstwert fehlt: Frostsperre über den Gerätefühler', w.runs().length === 0 && /Frostsperre \(geschätzt/.test(ev.join('|')),
    ev.join(' | '));
  common(w, 'S42');
};

// ------------------------------------------------------------------
scenarios.S43_anlauf_und_wiedereinschalten = function () {
  // a) Überstromschutz der Firmware schaltet beim Anlauf binnen 0,4 s ab, zwischen zwei Takten des Skripts:
  //    als Störung werten, Nachlauf nach 60 min, die Automatik muss an den Folgetagen weiterlaufen
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'anlauf';
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 5));
  w.pump.mode = 'normal';
  const off = () => w.plugsUi.leds.colors['switch:0'].off;
  check('S43 Abschaltung beim Anlauf als Störung gemeldet', /Störung .*Firmware-Schutz: overcurrent/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 1, 10, 9));
  check('S43 LED violett', JSON.stringify(off().rgb) === '[100,0,100]', JSON.stringify(off()));
  w.run(T(2027, 6, 3, 13, 0));
  const r = w.runs(), p1 = berlinParts(r[1] ? r[1].on : 0);
  check('S43 Nachlauf nach 60 min mit voller Menge', r.length >= 2 && p1.d === 1 && p1.hh === 11 && p1.mm <= 2 &&
    Math.abs(r[1].min - minFor(14)) < 1.5, runsInfo(w));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => berlinParts(l.t).d);
  check('S43 Tagesprüfung an den Folgetagen', ev.indexOf(2) >= 0 && ev.indexOf(3) >= 0, ev.join(','));
  // b) vom Vorbesitz eingestelltes "auto_on": Firmware schaltete nach jedem Aus wieder ein -> Skript stellt es ab
  const w2 = learnedWorld(T(2027, 6, 1, 18, 0));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 3, ev: dayNo(T(2027, 6, 1, 12)) }));
  w2.swCfg.auto_on = true; w2.swCfg.auto_on_delay = 60;
  w2.powerFail(1000); w2.runFor(2 * M);
  w2.press(); w2.runFor(30e3); w2.press();
  w2.run(T(2027, 6, 2, 6, 0));
  check('S43b auto_on abgeschaltet, nachts kein Lauf', w2.swCfg.auto_on === false && w2.runs().length === 1, runsInfo(w2));
  common(w, 'S43'); common(w2, 'S43b');
};

// ------------------------------------------------------------------
scenarios.S44_konto_am_deckel = function () {
  // a) Urlaubspause, Wetterdienst 01.–09.06. weg, am 05.06. 25 mm Regen, Konto am Deckel 25 mm: die Korrektur am 10.06.
  //    darf nur austauschen, was die Schätzung wirklich gebucht hat
  const wx = (ds) => ds === '2027-06-05' ? { et0: 2.0, rain: 25, prob: 90, tmin: 15, tmax: 22 } : { et0: 4.5, rain: 0, prob: 0, tmin: 15, tmax: 27 };
  const w = learnedWorld(T(2027, 6, 1, 6, 30), wx);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.setVc('number:201', 12); w.runFor(30e3);
  w.httpFail = true; w.run(T(2027, 6, 9, 22, 0));
  w.httpFail = false; w.run(T(2027, 6, 10, 11, 0));
  let ind = 20;                             // unabhängig, Tag für Tag mit Deckel
  for (let d = 1; d <= 9; d++) { const x = wx('2027-06-0' + d); ind = Math.min(25, Math.max(0, ind + x.et0 * 0.85 - Math.max(0, x.rain - 1))); }
  check('S44 Korrektur nach Ausfall am Deckel stimmt', Math.abs(w.state().d - ind) < 0.3, 'd=' + w.state().d + ' soll ' + ind.toFixed(2));
  // b) Konto 25 mm, um 10:00 15 mm gegossen: am Folgetag 25 - 15 + Verdunstung, nicht vom Deckel gekappt
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 25 }));
  w2.powerFail(1000); w2.run(T(2027, 6, 2, 10, 30));
  const ev = w2.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg);
  check('S44b nach Gabe am Deckel: Folgetag 13,8 mm', /Defizit 13\.8 mm/.test(ev[1] || ''), ev.join(' | '));
  common(w, 'S44'); common(w2, 'S44b');
};

// ------------------------------------------------------------------
scenarios.S45_rueckruf_fehlt_nachpruefung_neustart = function () {
  // a) Firmware verliert die Rückrufe der Wetterabfrage: nach 60 s als Fehlschlag gewertet, am selben Tag entschieden
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.runFor(10e3);
  const sh = w.dev.ctx.Shelly, orig = sh.call;
  sh.call = function (method, params, cb, ud) {
    if (method === 'HTTP.GET' && /past_days/.test(params.url)) return orig.call(this, method, params, function () {}, ud);
    return orig.call(this, method, params, cb, ud);
  };
  w.run(T(2027, 6, 1, 13, 0));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg));
  const n = w.http.filter(h => /past_days/.test(h.url)).length;
  check('S45 ohne Rückruf: am selben Tag ohne Internet entschieden und gegossen', ev.length === 1 &&
    /ohne Internet/.test(ev[0].msg) && w.runs().length === 1, ev.map(l => lt(w, l.t) + ' ' + l.msg).join(' | ') + ' / ' + runsInfo(w));
  check('S45 vier Abrufe, nicht Dauerfeuer', n === 4, String(n));
  // b) Regen erwartet, um 10:30 kurz Stromausfall, ab 11:00 abgesagt: die Nachprüfung überlebt den Neustart
  const dry = () => ({ et0: 4.5, rain: 0, prob: 10, tmin: 14 });
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30), dry);
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 12 }));
  w2.forecast = () => (w2.t < T(2027, 6, 1, 11, 0) ? { rain: 12, prob: 90 } : { rain: 0, prob: 10 });
  w2.powerFail(1000); w2.run(T(2027, 6, 1, 10, 30)); w2.powerFail(60e3); w2.run(T(2027, 6, 1, 13, 0));
  const r2 = w2.runs(), p = berlinParts(r2[0] ? r2[0].on : 0);
  check('S45b Nachprüfung nach Neustart: um 11:05 gegossen', r2.length === 1 && p.hh === 11 && p.mm >= 5 && p.mm <= 6, runsInfo(w2));
  common(w, 'S45'); common(w2, 'S45b');
};

// ------------------------------------------------------------------
scenarios.S46_ueber_winter_ausgesteckt = function () {
  // im November mit 18 mm Defizit ausgesteckt, am 10. April wieder eingesteckt: Konto beginnt neu, die letzten 14 Tage zählen
  const wx = (ds) => ds === '2028-04-08' ? { et0: 1.5, rain: 22, prob: 90, tmin: 6, tmax: 12 } : { et0: 2.0, rain: 0, prob: 0, tmin: 6, tmax: 16 };
  const w = learnedWorld(T(2028, 4, 10, 6, 0), wx);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 11, 14, 12)), ev: dayNo(T(2027, 11, 15, 12)), d: 18 }));
  w.powerFail(1000); w.run(T(2028, 4, 10, 13, 0));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg);
  check('S46 Konto neu: 14 Tage April, Regen am 8.', ev.length === 1 && /Defizit 2\.4 mm/.test(ev[0]), ev.join(' | '));
  common(w, 'S46');
};

// ------------------------------------------------------------------
scenarios.S25_saison_langlauf = function () {
  const R = rng(42);
  const clim = [0.4, 0.7, 1.5, 2.5, 3.3, 3.8, 4.0, 3.4, 2.2, 1.2, 0.5, 0.3];
  const cache = {};
  const wx = (ds) => {
    if (cache[ds]) return cache[ds];
    const m = +ds.slice(5, 7);
    const wet = R() < 0.3;
    const x = { et0: Math.max(0.2, clim[m - 1] * (wet ? 0.6 : 1.15) * (0.8 + 0.4 * R())), rain: wet ? Math.round(R() * 15 * 10) / 10 : 0,
      prob: wet ? 70 : 10, tmin: m >= 5 && m <= 9 ? 12 : 4 };
    return (cache[ds] = x);
  };
  const w = mkWorld(T(2027, 3, 1, 0, 0), { weather: wx });
  const t0 = w.t;
  // ein Internetausfall (2 Tage) und zwei Stromausfälle in der Saison
  w.run(T(2027, 6, 10, 0, 0)); w.internet = false; w.run(T(2027, 6, 12, 0, 0)); w.internet = true;
  w.run(T(2027, 7, 20, 4, 0)); w.powerFail(20 * M);
  w.run(T(2027, 8, 15, 7, 30)); w.powerFail(3 * M);
  w.run(T(2027, 11, 30, 23, 0));
  const days = (w.t - t0) / D;
  const wpd = w.storageWrites.length / days;
  // höchste Tageszahl
  const perDay = {};
  for (const t of w.storageWrites) { const k = berlinParts(t).date; perDay[k] = (perDay[k] || 0) + 1; }
  const maxDay = Math.max.apply(null, Object.values(perDay));
  const runs = w.runs();
  const mm = runs.reduce((a, r) => a + (r.min || 0) / 60 * RATE, 0);
  const etc = Object.keys(cache).reduce((a, k) => a + cache[k].et0 * 0.8, 0);
  const rain = Object.keys(cache).reduce((a, k) => a + Math.max(0, cache[k].rain - 1), 0);
  check('S25 Schreibvorgänge im Mittel <= 6/Tag', wpd <= 6, wpd.toFixed(1));
  check('S25 Schreibvorgänge an einem Tag <= 12', maxDay <= 12, String(maxDay));
  // unabhängiges Bodenkonto aus Wetter und tatsächlich gegebenem Wasser: der Rasen darf nie lange trocken stehen
  const irr = {};
  for (const r of runs) { const k = berlinParts(r.on).date; irr[k] = (irr[k] || 0) + (r.min || 0) / 60 * RATE; }
  let Dind = 0, maxD = 0, maxDay2 = '';
  for (const ds of Object.keys(cache).sort()) {
    const x = cache[ds], m = +ds.slice(5, 7);
    if (m < 3 || m > 11) continue;
    Dind = Math.min(25, Math.max(0, Dind + x.et0 * 0.8 - Math.max(0, x.rain - 1)));
    Dind = Math.max(0, Dind - (irr[ds] || 0));
    if (Dind > maxD) { maxD = Dind; maxDay2 = ds; }
  }
  check('S25 Bodenkonto (unabhängig gerechnet) nie über 20 mm', maxD <= 20, maxD.toFixed(1) + ' mm am ' + maxDay2);
  check('S25 Gaben im Mittel >= 5 mm', runs.length === 0 || mm / runs.length >= 5, (mm / runs.length).toFixed(1) + ' mm');
  check('S25 Relais-Schaltspiele weit unter 10 000 (Jahr)', runs.length < 400, runs.length + ' Starts');
  common(w, 'S25');
  return { days: days.toFixed(0), writesPerDay: wpd.toFixed(1), maxDay, starts: runs.length, mm: mm.toFixed(0), etc: etc.toFixed(0), rain: rain.toFixed(0), maxDeficit: maxD.toFixed(1) };
};

// ------------------------------------------------------------------
const out = {};
for (const [name, fn] of Object.entries(scenarios)) {
  if (FILTER && !name.includes(FILTER)) continue;
  const t0 = Date.now();
  try { out[name] = fn() || {}; }
  catch (e) { failures++; report.push('  FAIL ' + name + ' -- Testfehler: ' + (e.stack || e)); }
  report.push('  -- ' + name + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}
console.log(report.join('\n'));
console.log('\nDetails:', JSON.stringify(out, null, 1));
console.log('Längster Statustext: ' + maxTextAll + ' Byte');
console.log(`\n${passes} bestanden, ${failures} fehlgeschlagen  [${path.basename(FILE)}]`);
process.exit(failures ? 1 : 0);
