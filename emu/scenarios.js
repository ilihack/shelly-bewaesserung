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
  check(name + ': Grenzen (Timer<=5, RPC<=5, Handler<=5, Speicher je Eintrag <= 1024 Byte)', w.limits.timers <= 5 && w.limits.rpc <= 5 &&
    w.limits.handlers <= 5 && Object.values(w.maxStore).every(n => n <= 1024), JSON.stringify(w.limits) + ' ' + JSON.stringify(w.maxStore));
}
function runsInfo(w) { return w.runs().map(r => lt(w, r.on) + ' ' + (r.min ? r.min.toFixed(1) + 'min' : 'läuft') + ' (' + r.src + '->' + (r.offSrc || '') + ')').join('; '); }
function logHas(w, re) { return w.logs.some(l => re.test(l.msg)); }
function logsSince(w, t0) { return w.logs.filter(l => l.t >= t0).map(l => lt(w, l.t) + ' ' + l.msg).join('\n'); }
function weatherConst(et0, rain, prob, tmin) { return () => ({ et0, rain: rain || 0, prob: prob || 0, tmin: tmin === undefined ? 14 : tmin }); }
const hasCall = (j, m) => (j.calls || []).some(c => String(c.method).toLowerCase() === m);
const wdJob = (w) => w.jobs.find(j => hasCall(j, 'script.start'));    // Wächter
const upJob = (w) => w.jobs.find(j => hasCall(j, 'shelly.update'));   // Firmware-Update
// Text, wie ihn das Skript speichert: die Gerätefassung hat UTF-8-Bytes in ihren Zeichenketten (tools/build.js)
const devStr = (x) => (/min\.js$/.test(FILE) ? Buffer.from(x, 'utf8').toString('latin1') : x);
function ntpNow(w) {                  // der Zeitserver stellt die Geräteuhr jetzt (sonst im Takt des Emulators)
  const d = w.dev; w.ntp = true;
  if (d && !d.ntpSynced) { d.ntpSynced = true; d.syncTs = Math.floor(w.t / 1000); d.clockBase = w.t; d.clockUp = w.uptime(d); }
}

const scenarios = {};

// ------------------------------------------------------------------
scenarios.S01_inbetriebnahme = function () {
  const w = mkWorld(T(2027, 5, 10, 6, 0), { weather: weatherConst(3.5) });
  w.runFor(2 * M);
  check('S01 initial_state off', w.swCfg.initial_state === 'off', w.swCfg.initial_state);
  check('S01 auto_off 7800 s (130 min)', w.swCfg.auto_off === true && w.swCfg.auto_off_delay === 7800);
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
  check('S02 Läufe lernen nichts: Voreinstellung bleibt, bis per Taster angelernt', st.pn === 0 && !st.pc, st.pn + '/' + st.pc);
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
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 3));
  const r = w.runs()[0];
  check('S08 Blockade binnen 5 s abgeschaltet (Firmware 12 A)', r && r.off && (r.off - r.on) < 5e3, r ? ((r.off - r.on) / 1000).toFixed(1) + ' s' : '');
  const st = w.state();
  check('S08 Störung beim Anlauf: ein Nachlauf nach 6 min geplant', st.rt > 0 && Math.abs(st.rt * 1000 - r.off - 6 * M) < 2e3, JSON.stringify(st));
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
  // b) Taster nachts ohne Last (so am echten Gerät geschehen): die nächste Prüfung ist heute 10:00, nach ihr morgen
  const w2 = learnedWorld(T(2027, 6, 2, 0, 30));
  w2.pump.mode = 'noload';
  w2.run(T(2027, 6, 2, 1, 29)); w2.press(); w2.runFor(M);
  const nachts = w2.vcText();
  w2.run(T(2027, 6, 2, 10, 30));
  check('S09b Taster nachts ohne Last: Störung, nächste Prüfung heute 10:00, nach der Prüfung morgen',
    /keinen Strom \(0 W\)\. Nächster Versuch heute 10:00/.test(nachts) && /Nächster Versuch morgen 10:00/.test(w2.vcText()), nachts + ' / ' + w2.vcText());
  common(w2, 'S09b');
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
  // a) Frostnacht, kalter Tag (Luft bleibt unter 5 °C): bis 12:30 keine Automatik
  const w = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1, tmax: 4 }));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w.currentTemp = () => 3;
  w.powerFail(1000); w.run(T(2027, 4, 10, 13, 0));
  check('S16 Frostnacht, Luft bleibt kalt: kein Lauf', w.runs().length === 0, runsInfo(w));
  check('S16 Status Frostsperre bis 5 °C', /Frostsperre \(1 °C\), gießt ab 5 °C/.test(w.vcText()), w.vcText());
  check('S16 stündlich nachgesehen (11:05, 12:05)', w.http.filter(h => h.t > T(2027, 4, 10, 10, 30) && /past_days=0/.test(h.url)).length === 2,
    w.http.map(h => lt(w, h.t)).join(' '));
  // c) Frostnacht, um 11 Uhr 7 °C: Nachprüfung 11:05 gießt
  const w3 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1, tmax: 12 }));
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w3.currentTemp = (t) => (berlinParts(t).hh < 11 ? 3 : 7);
  w3.powerFail(1000); w3.run(T(2027, 4, 10, 13, 0));
  const r3 = w3.runs(), p3 = berlinParts(r3[0] ? r3[0].on : 0);
  check('S16c Frost vorbei: um 11:05 gegossen', r3.length === 1 && p3.hh === 11 && p3.mm >= 5 && p3.mm <= 6 &&
    logHas(w3, /Frost vorbei, gegossen/), runsInfo(w3));
  const w2 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 8 }));
  w2.ambient = () => 0;
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w2.internet = false;
  w2.powerFail(1000); w2.run(T(2027, 4, 10, 12, 0));
  check('S16b ohne Internet, Gerät kalt: kein Lauf', w2.runs().length === 0, runsInfo(w2));
  common(w, 'S16'); common(w2, 'S16b'); common(w3, 'S16c');
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
  check('S20 Knopf im Bedienfeld: angelernte Werte verworfen', w.state().pn === 0 && w.state().pc === 0, String(w.state().pn));
  w.run(T(2027, 6, 1, 13, 0));
  check('S20 danach lernt ein Lauf nichts: Voreinstellung 600/2100 W', w.runs().length >= 1 && w.state().pn === 0 &&
    /Untergrenze 600 W, Obergrenze 2100 W/.test(w.endpoint('info').body), runsInfo(w) + ' pn=' + w.state().pn);
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
  check('S22 ohne Internet und Anker: Einstecken gilt als 1. April 10:00', p.date === '2026-04-01' && p.hh === 10 && p.mm <= 5,
    p.date + ' ' + p.hh + ':' + p.mm);
  check('S22 Status nennt angenommene Uhrzeit', /Uhr angenommen/.test(w.vcText()), w.vcText());
  w.runFor(6 * M);
  const ev22 = w.logs.find(l => /Tagesprüfung/.test(l.msg)), dt22 = ev22 ? (ev22.t - w.dev.bootAt) / 1000 : -1;
  check('S22 nach 10 min geprüft (Einstecken gilt als 10:00, so lange auf den Zeitserver gewartet)', ev22 && /ohne Internet/.test(ev22.msg) &&
    dt22 >= 600 && dt22 <= 640, dt22 + ' s · ' + logsSince(w, T(2027, 6, 1, 6, 0)).slice(-300));
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
  const w3 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1, tmax: 4 }));
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w3.currentTemp = () => 3;
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
  check('S28 LED grün, volle Helligkeit, wenn alles gut', w.plugsUi.leds.mode === 'switch' && JSON.stringify(off().rgb) === '[0,100,0]' &&
    off().brightness === 100 && w.plugsUi.leds.colors['switch:0'].on.brightness === 100, JSON.stringify(w.plugsUi.leds));
  check('S28 LED blau, solange die Pumpe läuft', JSON.stringify(w.plugsUi.leds.colors['switch:0'].on.rgb) === '[0,0,100]');
  w.run(T(2027, 6, 1, 10, 20)); w.pump.mode = 'dry'; w.runFor(5 * M);
  check('S28 LED rot nach Störung', JSON.stringify(off().rgb) === '[100,0,0]', JSON.stringify(off()));
  w.pump.mode = 'normal';
  w.run(T(2027, 6, 2, 0, 10));
  check('S28 LED am nächsten Tag wieder grün', JSON.stringify(off().rgb) === '[0,100,0]', JSON.stringify(off()));
  w.internet = false; w.run(T(2027, 6, 3, 12, 0));
  check('S28 LED gelb ohne Internet', JSON.stringify(off().rgb) === '[100,70,0]', JSON.stringify(off()));
  w.internet = true; w.run(T(2027, 6, 4, 12, 0));
  check('S28 LED grün, sobald Internet zurück ist', JSON.stringify(off().rgb) === '[0,100,0]', JSON.stringify(off()));
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
  check('S29 Wächter-Zeitplan angelegt', w.jobs.length === 2 && wdJob(w) && wdJob(w).enable === true, JSON.stringify(w.jobs));
  const up = upJob(w);
  check('S29 Firmware-Update angelegt: täglich 03:23, neueste stabile', up && up.enable === true && up.timespec === '0 23 3 * * *' &&
    up.calls[0].params.stage === 'stable', JSON.stringify(w.jobs));
  w.powerFail(1000); w.runFor(5 * M);
  check('S29 Neustart legt keine weiteren an', w.jobs.length === 2, String(w.jobs.length));
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
    w2.logs.filter(l => /Tagesprüfung.*bestätigt/.test(l.msg)).length === 2, w2.vcText());
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
  const wx = (ds) => ds === '2027-04-06' ? { et0: 2.6, rain: 0, prob: 0, tmin: 0.5, tmax: 6 } :
    (ds === '2027-04-07' ? { et0: 2.6, rain: 0, prob: 0, tmin: 9, tmax: 20 } : { et0: 2.6, rain: 0, prob: 0, tmin: 8, tmax: 18 });
  const w = mkWorld(T(2027, 4, 1, 0, 0), { weather: wx, selfHeat: 25 });
  w.run(T(2027, 4, 5, 12, 0));
  const st = w.state();
  check('S32 Eigenwärme gelernt (Tief ~25 K, Hoch ~25 K)', Math.abs(st.ob - 25) <= 1.5 && Math.abs(st.oa - 25) <= 1.5, JSON.stringify({ ob: st.ob, oa: st.oa }));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { d: 14, pi: 0 })); w.restartScript();
  w.run(T(2027, 4, 5, 20, 0)); w.httpFail = true;
  w.ambient = (t) => (t < T(2027, 4, 6, 11, 30) ? 1 : 8);   // Frostnacht, bis 11:30 kalt, danach klar über 5 °C
  w.run(T(2027, 4, 6, 11, 30));
  const r6 = w.runs().filter(r => berlinParts(r.on).date === '2027-04-06');
  check('S32 Frostnacht ohne Internet (1 °C, Gerät ~26 °C): vormittags kein Lauf', r6.length === 0 && /Frostsperre \(geschätzt/.test(w.vcText()), w.vcText());
  w.run(T(2027, 4, 6, 13, 0)); w.ambient = null;
  const r6b = w.runs().filter(r => berlinParts(r.on).date === '2027-04-06'), p6 = berlinParts(r6b[0] ? r6b[0].on : 0);
  check('S32 ohne Internet: gegossen, sobald der Gerätefühler 5 °C Luft zeigt (12:05)', r6b.length === 1 && p6.hh === 12 && p6.mm >= 5 && p6.mm <= 6,
    runsInfo(w));
  w.run(T(2027, 4, 7, 12, 0));
  const ev7 = w.logs.filter(l => /Tagesprüfung/.test(l.msg) && berlinParts(l.t).date === '2027-04-07').map(l => l.msg).join(' | ');
  check('S32 milde Nacht ohne Internet (9 °C): keine Frostsperre', ev7 !== '' && !/Frostsperre/.test(ev7), ev7);
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
  // ohne Internet +21 % (OFF_ET); der kühle Tag folgt auf den heißen, sein Höchstwert liegt darum kurz nach Mitternacht
  const mittel = 4.5 * 0.85 * 1.21, hot = mittel * (1 + 0.06 * (35 - 26.3));
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
scenarios.S38_nur_zeitserver = function () {
  // Die Uhrzeit kommt nur vom Zeitserver; die Kopfzeile Date der https-Antworten zählt nicht (ohne Zeitserver scheitert
  // https ab Firmware 2.0 ohnehin an der Zertifikatsprüfung). Hier ist er gesperrt, das Internet geht.
  // a) 6 h Stromausfall nachts: Uhr bleibt geschätzt (Anker, nie zu früh), LED erst nach 30 min gelb; Zeitserver
  //    zurück: Uhr echt, LED nach 30 min wieder grün, zusammen 2 LED-Schreibvorgänge
  const wx = () => ({ et0: 4.5, rain: 0, prob: 0, tmin: 10, tmax: 28 });
  const w = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w.run(T(2027, 6, 4, 1, 0)); const l0 = w.ledWrites.length;
  w.ntp = false; w.powerFail(6 * H);
  w.run(T(2027, 6, 4, 7, 25));
  const frueh = ledOf(w);
  w.run(T(2027, 6, 4, 7, 40));
  check('S38 Zeitserver gesperrt: Uhr geschätzt (nachgehend), LED erst nach 30 min gelb', /Uhr geschätzt/.test(w.vcText()) &&
    frueh === '[0,100,0]' && ledOf(w) === '[100,70,0]' && w.devUnix() < w.t / 1000 - 3600,
    frueh + ' ' + ledOf(w) + ' ' + w.vcText() + ' ' + (w.devUnix() - w.t / 1000));
  w.run(T(2027, 6, 4, 23, 0));
  const r = w.runs().filter(x => x.on > T(2027, 6, 4, 7, 0));
  check('S38 mit geschätzter Uhr nie vor 10:00 gegossen', r.every(x => berlinParts(x.on).hh >= 10), runsInfo(w));
  w.ntp = true; w.runFor(3 * M);
  check('S38 Zeitserver zurück: Uhr echt', !/Uhr geschätzt/.test(w.vcText()) && Math.abs(w.devUnix() - w.t / 1000) < 5 &&
    w.state().ce === 0, w.vcText());
  w.runFor(35 * M);
  check('S38 LED wieder grün, zusammen 2 LED-Schreibvorgänge', ledOf(w) === '[0,100,0]' && w.ledWrites.length - l0 === 2,
    ledOf(w) + ' ' + (w.ledWrites.length - l0));
  w.run(T(2027, 6, 7, 23, 0));
  const r2 = w.runs().filter(x => x.on > T(2027, 6, 5, 0, 0));
  check('S38 danach um 10:00 gegossen', r2.length >= 1 && r2.every(x => berlinParts(x.on).hh === 10), runsInfo(w));
  // b) die Firmware meldet eine per Sys.SetTime gestellte Zeit nicht (unixtime bleibt leer): das Skript rechnet mit
  //    seiner Schätzung weiter, gießt nie zu früh; mit dem Zeitserver ist die Uhr echt
  const w4 = mkWorld(T(2027, 6, 1, 0, 0), { weather: wx });
  w4.run(T(2027, 6, 4, 1, 0)); w4.ntp = false; w4.setTimeIgnored = true; w4.powerFail(6 * H);
  w4.run(T(2027, 6, 5, 6, 0));
  const r4 = w4.runs().filter(x => x.on > T(2027, 6, 4, 7, 0));
  const gesch = /Uhr geschätzt/.test(w4.vcText()) && w4.dev.clockBase === null;
  w4.ntp = true; w4.run(T(2027, 6, 7, 23, 0));
  const r4b = w4.runs().filter(x => x.on > T(2027, 6, 5, 7, 0));
  check('S38b gestellte Zeit nicht gemeldet: Schätzung im Skript, nie vor 10:00; mit Zeitserver um 10:00', gesch &&
    r4.every(x => berlinParts(x.on).hh >= 10) && r4b.length >= 1 && r4b.every(x => berlinParts(x.on).hh === 10) &&
    !/Uhr geschätzt/.test(w4.vcText()), runsInfo(w4) + ' / ' + w4.vcText());
  // c) Erststart ohne Zeitserver, Internet da: Einstecken gilt als 1. April 10:00 (echt 20. April 07:00). Wetterantworten
  //    tragen ein anderes Datum und werden nicht verbucht (geschätzt wie ohne Internet). Drei Tage später kommt der
  //    Zeitserver: Tagesmarken verschoben, das Konto stimmt danach wie Tag für Tag gerechnet
  const w6 = mkWorld(T(2026, 4, 20, 7, 0), { weather: () => ({ et0: 3.0, rain: 0, prob: 0, tmin: 10, tmax: 22 }) });
  w6.storage = { s: JSON.stringify({ v: 1, la: 49.48, lo: 8.45, pz: 'DELudwigshafen am Rhein', pn: 1320, ln: 3 }) };
  w6.ntp = false; w6.powerFail(1000);
  w6.run(T(2026, 4, 23, 6, 0));
  const vor = w6.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg);
  w6.ntp = true; w6.run(T(2026, 4, 24, 11, 0));
  const g6 = {};
  for (const x of w6.runs()) { const k = berlinParts(x.on).date; g6[k] = (g6[k] || 0) + (x.min || 0) / 60 * RATE; }
  let d6 = 0;
  for (const ds of ['2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23']) d6 = Math.min(25, Math.max(0, d6 - (g6[ds] || 0)) + 3.0 * 0.85);
  const e6 = w6.logs.filter(l => /Tagesprüfung/.test(l.msg) && berlinParts(l.t).date === '2026-04-24').map(l => l.msg);
  const v6 = e6.length ? +(/Defizit ([\d.]+) mm/.exec(e6[e6.length - 1]) || [0, -9])[1] : -9;
  const i6 = w6.endpoint('info').body;
  check('S38c angenommenes Datum: Wetter mit anderem Datum nicht verbucht; Zeitserver: Konto wie Tag für Tag gerechnet',
    vor.length >= 2 && vor.every(m => /ohne Internet/.test(m)) && logHas(w6, /Tagesmarken um 19 Tage verschoben/) &&
    Math.abs(v6 - d6) <= 0.15, vor.join(' | ') + ' // ' + e6.join(' | ') + ' / unabhängig ' + d6.toFixed(2) + ' / ' + runsInfo(w6));
  check('S38c Diagnose danach mit echtem Datum: Saison seit dem Einstecken (20.04.)', /\nSaison seit 20\.04\.:/.test(i6), i6.split('\n')[6]);
  // d) Stromausfall bis 22:00, der Zeitanker sagt 10:00; WLAN und Zeitserver kommen erst 4 min nach dem Hochfahren
  //    (der Router bootet): die Tagesprüfung wartet auf den Zeitserver, heute kein Lauf mehr, morgen um 10:00
  const w5 = learnedWorld(T(2027, 6, 4, 22, 0), wx);
  w5.storage.s = JSON.stringify(Object.assign(JSON.parse(w5.storage.s), { t: Math.floor(T(2027, 6, 4, 10, 0) / 1000), tu: 1e7, ce: 1,
    ev: dayNo(T(2027, 6, 3, 12)), dp: dayNo(T(2027, 6, 3, 12)), d: 14 }));
  w5.internet = false; w5.powerFail(1000); w5.after(1000 + 4 * M, () => { w5.internet = true; });
  w5.run(T(2027, 6, 5, 12, 0));
  const r5 = w5.runs(), p5 = berlinParts(r5[0] ? r5[0].on : 0);
  check('S38d Zeitanker 10:00, echt 22:00, Router braucht 4 min: kein Lauf am Abend, am Morgen um 10:00', r5.length === 1 &&
    p5.d === 5 && p5.hh === 10, runsInfo(w5) + ' / ' + logsSince(w5, T(2027, 6, 4, 21, 59)).split('\n').slice(0, 12).join(' | '));
  // e) Störung beim Anlauf um 10:00, Nachlauf für 10:06 gespeichert; gleich danach 12 h Stromausfall, der Router braucht
  //    8 min: auch der gespeicherte Nachlauf wartet auf den Zeitserver, also kein Lauf in der Nacht
  const w7 = learnedWorld(T(2027, 6, 1, 6, 30), wx);
  w7.storage.s = JSON.stringify(Object.assign(JSON.parse(w7.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w7.powerFail(1000); w7.run(T(2027, 6, 1, 9, 59)); w7.pump.mode = 'noload';
  w7.run(T(2027, 6, 1, 10, 1)); w7.pump.mode = 'normal'; w7.run(T(2027, 6, 1, 10, 2) + 30e3);
  const rt7 = w7.state().rt;
  w7.internet = false; w7.powerFail(12 * H); w7.after(12 * H + 8 * M, () => { w7.internet = true; });
  w7.run(T(2027, 6, 2, 9, 0));
  const nacht = w7.runs().filter(x => x.on > T(2027, 6, 1, 12, 0));
  check('S38e gespeicherter Nachlauf nach Stromausfall: wartet auf den Zeitserver, kein Lauf in der Nacht', rt7 > 0 && nacht.length === 0,
    'rt=' + (rt7 ? lt(w7, rt7 * 1000) : '-') + ' · ' + runsInfo(w7));
  common(w, 'S38'); common(w4, 'S38b'); common(w6, 'S38c'); common(w5, 'S38d'); common(w7, 'S38e');
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
  // c) unbekannter Ortsname: ohne Ort kein Wetter; gegossen wird wie ohne Internet, Status und LED (gelb) nennen den Namen
  const w3 = learnedWorld(T(2027, 6, 1, 6, 30), weatherConst(4.5));
  w3.code = CODE.replace('"Ludwigshafen am Rhein"', '"Nirgendwo"');
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w3.powerFail(1000); w3.run(T(2027, 6, 1, 13, 0));
  const ev3 = w3.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg).join(' | '), st3 = w3.state();
  check('S41c unbekannter Ortsname: ohne Wetterabruf gegossen', st3.la === null && /ohne Internet/.test(ev3) && w3.runs().length === 1 &&
    !w3.http.some(h => /past_days/.test(h.url)), ev3 + ' ' + JSON.stringify(st3));
  check('S41c Status und LED: Ort nicht gefunden, kein „ohne Internet“', /Ort Nirgendwo nicht gefunden/.test(w3.vcText()) &&
    !/ohne Internet/.test(w3.vcText()) && ledOf(w3) === '[100,70,0]', w3.vcText());
  // d) Koordinaten eingetragen: keine Abfrage
  const c4 = CODE.replace('LAT: null, LON: null', 'LAT: 49.51, LON: 8.55')            // Quelltext
    .replace(/("Ludwigshafen am Rhein",[\w$]+:"DE",[\w$]+:)null,([\w$]+:)null/, '$149.51,$28.55'); // Gerätefassung
  const w4 = mkWorld(T(2027, 6, 1, 6, 30), { weather: weatherConst(4.5), code: c4 });
  w4.run(T(2027, 6, 1, 10, 30));
  check('S41d Koordinaten eingetragen: keine Ortssuche, kein Hinweis, LED grün',
    !w4.http.some(h => /geocoding/.test(h.url)) && w4.http.some(h => /latitude=49\.51&longitude=8\.55/.test(h.url)) &&
    !/Ort/.test(w4.vcText()) && JSON.stringify(w4.plugsUi.leds.colors['switch:0'].off.rgb) === '[0,100,0]',
    w4.vcText() + ' ' + w4.http.map(h => h.url).join(' '));
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
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg), r = w.runs();
  check('S42 Tiefstwert fehlt: Frostsperre über den Gerätefühler, gegossen erst ab 5 °C Luft', /Frostsperre \(geschätzt/.test(ev[0] || '') &&
    r.length >= 1 && berlinParts(r[0].on).hh >= 11 && w.ambientAt(r[0].on) >= 5, ev.join(' | ') + ' / ' + runsInfo(w));
  common(w, 'S42');
};

// ------------------------------------------------------------------
scenarios.S43_anlauf_und_wiedereinschalten = function () {
  // a) Überstromschutz der Firmware schaltet beim Anlauf binnen 0,4 s ab, zwischen zwei Takten des Skripts:
  //    als Störung werten, Nachlauf nach 6 min, die Automatik muss an den Folgetagen weiterlaufen
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'anlauf';
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 5));
  w.pump.mode = 'normal';
  const off = () => w.plugsUi.leds.colors['switch:0'].off;
  check('S43 Abschaltung beim Anlauf als Störung gemeldet', /Störung .*Firmware-Schutz: overcurrent/.test(w.vcText()), w.vcText());
  w.run(T(2027, 6, 1, 10, 9));
  check('S43 LED rot', JSON.stringify(off().rgb) === '[100,0,0]', JSON.stringify(off()));
  w.run(T(2027, 6, 3, 13, 0));
  const r = w.runs(), p1 = berlinParts(r[1] ? r[1].on : 0);
  check('S43 Nachlauf nach 6 min mit voller Menge', r.length >= 2 && p1.d === 1 && p1.hh === 10 && p1.mm >= 6 && p1.mm <= 7 &&
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
scenarios.S47_zweite_instanz = function () {
  // Wächter und Relais-Schutz stellt das Skript stündlich nach, auch wenn sie in der App verstellt wurden.
  // Das Firmware-Update legt es nur an, wenn keines da ist: in der App abgeschaltet bleibt es aus.
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.runFor(5 * M);
  const j0 = wdJob(w) || {};
  check('S47 Wächter alle 5 min, aktiv', w.jobs.length === 2 && j0.enable !== false && j0.timespec === '0 */5 * * * *', JSON.stringify(w.jobs));
  const cw = w.cfgWrites;
  w.runFor(65 * M);
  check('S47 stündliches Nachstellen schreibt nichts, solange alles stimmt', w.cfgWrites === cw, cw + ' -> ' + w.cfgWrites);
  j0.enable = false; j0.timespec = '0 50 * * * *'; upJob(w).enable = false;
  Object.assign(w.swCfg, { auto_off: false, initial_state: 'on', auto_on: true });
  w.runFor(61 * M);
  const j1 = wdJob(w) || {};
  check('S47 binnen 1 h: Wächter wieder aktiv, alle 5 min', w.jobs.length === 2 && j1.enable === true && j1.timespec === '0 */5 * * * *', JSON.stringify(w.jobs));
  check('S47 Firmware-Update in der App abgeschaltet: bleibt aus', upJob(w).enable === false, JSON.stringify(w.jobs));
  check('S47 binnen 1 h: Notabschaltung an, Einschaltzustand aus, kein Wiedereinschalten', w.swCfg.auto_off === true &&
    w.swCfg.auto_off_delay === 7800 && w.swCfg.initial_state === 'off' && w.swCfg.auto_on === false, JSON.stringify(w.swCfg));
  w.jobs.length = 0;
  w.runFor(61 * M);
  check('S47 gelöschte Zeitpläne binnen 1 h neu angelegt', w.jobs.length === 2 && wdJob(w) && wdJob(w).enable === true &&
    upJob(w) && upJob(w).enable === true, JSON.stringify(w.jobs));
  // ein Update-Zeitplan aus der App (andere Uhrzeit) genügt: kein zweiter
  const w2 = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w2.jobs.push({ id: 7, enable: true, timespec: '0 0 2 * * 1', calls: [{ method: 'Shelly.Update', params: { stage: 'stable' } }] });
  w2.runFor(5 * M);
  check('S47 Update-Zeitplan aus der App: kein zweiter', w2.jobs.length === 2 && upJob(w2).id === 7, JSON.stringify(w2.jobs));
  common(w, 'S47'); common(w2, 'S47b');
};

// ------------------------------------------------------------------
scenarios.S48_korrektur_nach_regen = function () {
  // Wetterdienst 6 Tage weg, Pause (kein Gießen), am 2. Tag 25 mm Regen: die Korrektur rechnet die Tage neu,
  // der Regen setzt das Konto auf 0, die vier trockenen Tage danach zählen wieder (unabhängig: 4 × 3,825 = 15,3 mm)
  const wx = (ds) => ds === '2027-06-02' ? { et0: 2.0, rain: 25, prob: 90, tmin: 14, tmax: 20 } : { et0: 4.5, rain: 0, prob: 0, tmin: 14, tmax: 24 };
  const w = learnedWorld(T(2027, 6, 1, 6, 30), wx);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 0 }));
  w.powerFail(1000); w.runFor(3 * M);
  w.setVc('number:201', 6); w.runFor(30e3);
  w.httpFail = true; w.run(T(2027, 6, 6, 22, 0));
  w.httpFail = false; w.run(T(2027, 6, 7, 11, 0));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg) && berlinParts(l.t).date === '2027-06-07').map(l => l.msg);
  check('S48 nach der Rückkehr: Defizit 15,3 mm wie Tag für Tag gerechnet, gegossen', ev.length === 1 && /Defizit 15\.3 mm/.test(ev[0]) &&
    /gegossen/.test(ev[0]), ev.join(' | '));
  // ohne Pause, April: 20 mm Regen am ersten Tag ohne Wetterdienst, danach drei trockene Tage
  const wx2 = (ds) => ds === '2027-04-11' ? { et0: 1.0, rain: 20, prob: 90, tmin: 6, tmax: 12 } : { et0: 2.8, rain: 0, prob: 0, tmin: 6, tmax: 18 };
  const w2 = learnedWorld(T(2027, 4, 11, 6, 30), wx2);
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 4, 10, 12)), d: 3, ob: 14, oa: 14 }));   // Eigenwärme gelernt
  w2.powerFail(1000); w2.runFor(3 * M);
  w2.httpFail = true; w2.run(T(2027, 4, 14, 22, 0));
  w2.httpFail = false; w2.run(T(2027, 4, 15, 10, 30));
  const ev2 = w2.logs.filter(l => /Tagesprüfung/.test(l.msg) && berlinParts(l.t).date === '2027-04-15').map(l => l.msg);
  const giv = {};                       // unabhängig Tag für Tag gerechnet, mit dem tatsächlich Gegossenen (vor der Verdunstung)
  for (const r of w2.runs()) { const k = berlinParts(r.on).date; giv[k] = (giv[k] || 0) + (r.min || 0) / 60 * RATE; }
  let dd = 3;
  for (const ds of ['2027-04-11', '2027-04-12', '2027-04-13', '2027-04-14']) {
    const x = wx2(ds); dd = Math.min(25, Math.max(0, Math.max(0, dd - (giv[ds] || 0)) + x.et0 * 0.85 - Math.max(0, x.rain - 1)));
  }
  const got = ev2.length === 1 ? +(/Defizit ([\d.]+) mm/.exec(ev2[0]) || [0, -9])[1] : -9;
  check('S48b April: Defizit wie Tag für Tag gerechnet, die trockenen Tage nach dem Regen zählen', Math.abs(got - dd) <= 0.15 && dd > 2,
    ev2.join(' | ') + ' / unabhängig ' + dd.toFixed(2) + ' / ' + runsInfo(w2));
  common(w, 'S48'); common(w2, 'S48b');
};

// ------------------------------------------------------------------
scenarios.S49_frost_eigenwaerme_ungelernt = function () {
  // neues Gerät ohne Internet, Eigenwärme noch nicht gelernt, Frostnacht: die Luft lässt sich nicht schätzen, also warten
  const wx = (ds) => ds === '2027-04-10' ? { et0: 2, rain: 0, prob: 0, tmin: 0.5, tmax: 5 } : { et0: 2.6, rain: 0, prob: 0, tmin: 4, tmax: 12 };
  const w = learnedWorld(T(2027, 4, 9, 6, 0), wx);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 4, 8, 12)), d: 14, ev: dayNo(T(2027, 4, 9, 12)) }));
  w.httpFail = true; w.powerFail(1000);
  w.run(T(2027, 4, 10, 13, 0));
  const r = w.runs().filter(x => berlinParts(x.on).date === '2027-04-10');
  check('S49 ungelernt, Frostnacht ohne Internet: kein Lauf in der Kälte', r.length === 0 && /Frostsperre \(geschätzt/.test(w.vcText()),
    runsInfo(w) + ' / ' + w.vcText());
  common(w, 'S49');
};

// ------------------------------------------------------------------
scenarios.S50_nachpruefung_gruende = function () {
  // a) ohne Internet Frostsperre, um 11:30 kurz Stromausfall: nach dem Neustart scheitert der Abruf, der Gerätefühler entscheidet
  const wx = (ds) => ds === '2027-04-10' ? { et0: 2, rain: 0, prob: 0, tmin: 1, tmax: 9 } : { et0: 2.6, rain: 0, prob: 0, tmin: 4, tmax: 14 };
  const w = learnedWorld(T(2027, 4, 9, 6, 0), wx);
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 4, 8, 12)), d: 14, ev: dayNo(T(2027, 4, 9, 12)), ob: 14, oa: 14 }));
  w.httpFail = true; w.powerFail(1000);
  w.run(T(2027, 4, 9, 20, 0));
  w.ambient = (t) => (t < T(2027, 4, 10, 11, 45) ? 2 : 8);
  w.run(T(2027, 4, 10, 11, 30)); w.powerFail(60e3); w.run(T(2027, 4, 10, 13, 0)); w.ambient = null;
  const r = w.runs().filter(x => berlinParts(x.on).date === '2027-04-10'), p = berlinParts(r[0] ? r[0].on : 0);
  check('S50 Frost, Neustart, Abruf scheitert: Gerätefühler entscheidet, um 12:05 gegossen', r.length === 1 && p.hh === 12 && p.mm >= 5 && p.mm <= 6,
    runsInfo(w) + ' / ' + logsSince(w, T(2027, 4, 10, 9, 0)).split('\n').filter(x => /Tagesprüfung/.test(x)).join(' | '));
  // b) Frost um 10:00, um 11:05 erstmals Regen angekündigt, um 12:05 abgesagt: Texte nach dem Grund der letzten Prüfung
  const w2 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 1, tmax: 14 }));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w2.currentTemp = (t) => (berlinParts(t).hh < 11 ? 3 : 7);
  w2.forecast = () => (berlinParts(w2.t).hh === 11 ? { rain: 12, prob: 90 } : { rain: 0, prob: 5 });
  w2.powerFail(1000); w2.run(T(2027, 4, 10, 13, 0));
  const e2 = w2.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg.replace(/^.*-> /, ''));
  check('S50b Frost, dann Regen, dann Absage: Texte passen', e2.length === 3 && /^Frostsperre/.test(e2[0]) &&
    /^Regen erwartet \(12 mm, 90 %\)$/.test(e2[1]) && /^Regen abgesagt, gegossen/.test(e2[2]), e2.join(' | '));
  // c) Regen um 10:00, um 11:05 Prognose mit Frostnacht, Luft aber warm, Regen weg: „Regen abgesagt“, nicht „Frost vorbei“
  const w3 = learnedWorld(T(2027, 4, 10, 6, 30), () => ({ et0: 3, rain: 0, prob: 0, tmin: 4, tmax: 14 }));
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 4, 9, 12)), d: 14 }));
  w3.currentTemp = () => 8;
  w3.forecast = () => (berlinParts(w3.t).hh < 11 ? { rain: 12, prob: 90, tmin: 4 } : { rain: 0, prob: 5, tmin: 2.5 });
  w3.powerFail(1000); w3.run(T(2027, 4, 10, 13, 0));
  const e3 = w3.logs.filter(l => /Tagesprüfung/.test(l.msg)).map(l => l.msg.replace(/^.*-> /, ''));
  check('S50c Regen, dann abgesagt: „Regen abgesagt“', e3.length === 2 && /^Regen erwartet/.test(e3[0]) && /^Regen abgesagt, gegossen/.test(e3[1]), e3.join(' | '));
  common(w, 'S50'); common(w2, 'S50b'); common(w3, 'S50c');
};

// ------------------------------------------------------------------
scenarios.S51_led_nach_fehler = function () {
  // ein einzelner Fehler beim Setzen der LED darf die LED-Steuerung nicht dauerhaft abschalten
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'closed';
  w.powerFail(1000); w.runFor(10e3);
  const sh = w.dev.ctx.Shelly, orig = sh.call; let failed = 0;
  sh.call = function (method, params, cb, ud) {   // der erste Versuch zurück auf Grün scheitert (Fehler -103)
    if (method === 'PLUGS_UI.SetConfig' && params.config.leds.colors['switch:0'].off.rgb[1] === 100 && w.t > T(2027, 6, 1, 12, 0) && !failed) {
      failed++; return orig.call(this, 'Switch.SetConfig', { id: 0, config: { busy: 1 } }, cb, ud);
    }
    return orig.call(this, method, params, cb, ud);
  };
  w.run(T(2027, 6, 1, 12, 0)); w.pump.mode = 'normal';
  const off = () => JSON.stringify(w.plugsUi.leds.colors['switch:0'].off.rgb);
  check('S51 nach Störung rot', off() === '[100,0,0]', off());
  w.run(T(2027, 6, 2, 13, 0));
  check('S51 Fehler beim Zurückstellen nach dem nächsten fehlerfreien Lauf: binnen 2 h doch grün', failed === 1 && off() === '[0,100,0]', failed + ' ' + off());
  common(w, 'S51');
};

// ------------------------------------------------------------------
scenarios.S52_fehler_im_rueckruf = function () {
  // Ein Fehler in einem Rückruf darf das Skript nicht beenden. a) in der Wetterantwort, mitten in der Tagesprüfung
  // (hier: ihre Meldung wirft): verworfen, Stand von vorher, 20 min später nochmal, dann gegossen
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 9, 59)); w.throwPrint = /Tagesprüfung/;
  w.run(T(2027, 6, 1, 13, 0));
  const r = w.runs(), p = berlinParts(r[0] ? r[0].on : 0);
  check('S52 Fehler in der Wetterantwort: Skript läuft, 20 min später gegossen', !w.crashed && w.throwPrint === null &&
    logHas(w, /Fehler Wetterantwort/) && r.length === 1 && p.hh === 10 && p.mm >= 20 && p.mm <= 22, runsInfo(w));
  const ev = w.logs.filter(l => /Tagesprüfung/.test(l.msg));
  check('S52 Konto nicht doppelt verbucht, volle Gabe 14 mm, keine Störung', ev.length === 2 && ev.every(l => /Defizit 14 mm/.test(l.msg)) &&
    r.length === 1 && Math.abs(r[0].min - minFor(14)) < 1 && !logHas(w, /Störung/), ev.map(l => l.msg).join(' | ') + ' / ' + runsInfo(w));
  // c) beim Einschalten (Shelly.call wirft, wie bei zu vielen offenen Aufrufen): die Gabe kommt beim nächsten
  //    Durchgang (binnen 1 min), das Konto ist einmal verbucht
  const w3 = learnedWorld(T(2027, 6, 1, 6, 30));
  w3.storage.s = JSON.stringify(Object.assign(JSON.parse(w3.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w3.powerFail(1000); w3.run(T(2027, 6, 1, 9, 59)); w3.throwOnce = 'Switch.Set';
  w3.run(T(2027, 6, 1, 13, 0));
  const r3 = w3.runs(), p3 = berlinParts(r3[0] ? r3[0].on : 0), ev3 = w3.logs.filter(l => /Tagesprüfung/.test(l.msg));
  check('S52c Fehler beim Einschalten: Skript läuft, binnen 1 min gegossen, einmal geprüft', !w3.crashed && w3.throwOnce === null &&
    logHas(w3, /Fehler Plan/) && r3.length === 1 && p3.hh === 10 && p3.mm <= 1 && ev3.length === 1 &&
    Math.abs(r3[0].min - minFor(14)) < 1 && !logHas(w3, /Störung/), runsInfo(w3) + ' / ' + ev3.map(l => l.msg).join(' | '));
  common(w3, 'S52c');
  // b) beim Anlegen des Wächters: binnen 1 h nachgeholt
  const w2 = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w2.throwOnce = 'Schedule.Create'; w2.runFor(5 * M);
  check('S52b Fehler beim Anlegen des Wächters: Skript läuft weiter', !w2.crashed && w2.jobs.length === 0 && logHas(w2, /Fehler im Rückruf/), JSON.stringify(w2.jobs));
  w2.runFor(61 * M);
  check('S52b binnen 1 h nachgeholt', w2.jobs.length === 2 && wdJob(w2) && upJob(w2), JSON.stringify(w2.jobs));
  common(w, 'S52'); common(w2, 'S52b');
};

// ------------------------------------------------------------------
scenarios.S53_bedienfeld_spaet = function () {
  // Skript von Hand eingefügt und gestartet (ohne Aufspielwerkzeug, ohne Neustart): die Griffe der eben angelegten
  // Bedienelemente kommen erst später. Die LED zeigt trotzdem den Zustand, gegossen wird ohnehin; das Bedienfeld
  // bindet sich, sobald es geht. Fehlt ein Element (in der App gelöscht), wird es neu angelegt.
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5) });
  w.handleFail = 20; w.runFor(30e3);
  check('S53 Griffe fehlen: Skript läuft ohne Bedienfeld', !w.crashed && logHas(w, /Bedienfeld unvollständig/) && !logHas(w, /Bedienfeld verbunden/), w.vcText());
  w.runFor(3 * M);
  check('S53 LED schon gesetzt, Bedienfeld noch nicht', w.ledWrites.length >= 1 && !logHas(w, /Bedienfeld verbunden/), String(w.ledWrites.length));
  w.runFor(10 * M);
  check('S53 binnen Minuten verbunden, Status sichtbar', logHas(w, /Bedienfeld verbunden/) && (w.vcText() || '').length > 5, w.vcText());
  // im Betrieb in der App gelöscht (auch aus der Gruppe): erkannt, neu angelegt, wieder in der Gruppe, Eingaben wirken
  delete w.vc['number:201']; w.vc['group:200'].value = w.vc['group:200'].value.filter(k => k !== 'number:201');
  w.runFor(3 * M);
  check('S53 im Betrieb gelöschtes Element: neu angelegt und wieder in der Gruppe', !!w.vc['number:201'] &&
    w.vc['group:200'].value.indexOf('number:201') >= 0 && logHas(w, /Bedienfeld neu: fehlt/), Object.keys(w.vc).join(',') + ' ' + JSON.stringify(w.vc['group:200'].value));
  w.setVc('number:201', 2); w.runFor(30e3);
  check('S53 neues Element ist gebunden: Pause wirkt', logHas(w, /Pause bis/), logsSince(w, w.t - 60e3));
  w.setVc('number:201', 0); w.runFor(30e3);
  // nach einem Neustart fehlt ein Element: angelegt und gebunden
  delete w.vc['number:202']; w.vc['group:200'].value = w.vc['group:200'].value.filter(k => k !== 'number:202');
  w.restartScript(); w.runFor(3 * M);
  check('S53 nach Neustart fehlendes Element angelegt, in der Gruppe', !!w.vc['number:202'] && w.vc['group:200'].value.indexOf('number:202') >= 0 &&
    !logHas(w, /SKRIPT ABGESTÜRZT/), Object.keys(w.vc).join(','));
  w.run(T(2027, 6, 4, 12, 0));
  check('S53 gießt normal', w.runs().filter(r => r.src === 'loopback').length >= 1, runsInfo(w));
  common(w, 'S53');
};

// ------------------------------------------------------------------
scenarios.S54_diagnose = function () {
  // Diagnose-Seite http://<IP>/script/<id>/info (hinter dem Gerätepasswort): letzte Störung, Saison, Ausfälle, Uhr,
  // Schreibvorgänge, letzte Meldungen. Sie entsteht erst beim Aufruf und schreibt nichts.
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 10));
  w.pump.mode = 'dry'; w.runFor(2 * M); w.pump.mode = 'normal';      // Trockenlauf 10:10, Nachlauf 11:10
  w.run(T(2027, 6, 1, 13, 0));
  let p = w.endpoint('info'), maxB = Buffer.byteLength(p.body);
  check('S54 Seite: Text in UTF-8, Uhrzeit, LED wechselt erst nach 30 min auf grün', p.code === 200 && p.sent &&
    JSON.stringify(p.headers) === '[["Content-Type","text/plain; charset=utf-8"]]' && /^Bewässerung 01\.06\.2027 13:00\n/.test(p.body) &&
    /\nLED: rot, wechselt bald auf grün – alles in Ordnung\n/.test(p.body), p.body);
  w.run(T(2027, 6, 1, 13, 30)); p = w.endpoint('info'); maxB = Math.max(maxB, Buffer.byteLength(p.body));
  check('S54 letzte Störung erledigt, Saison gezählt, letzte Meldungen neueste zuerst', /\nLED: grün – alles in Ordnung\n/.test(p.body) &&
    /\nLetzte Störung: 01\.06\.2027 10:1\d Trockenlauf oder Hahn zu \(\d+ W < 990 W\) \(erledigt\)\n/.test(p.body) &&
    /\nSaison seit 01\.06\.: Automatik 2, Hand 0, zusammen 1\d(,\d)? mm, Störungen 1\n/.test(p.body) &&
    /\nLetzte Meldungen \(seit Skriptstart\):\n01\.06\. 1[23]:\d\d Pumpe aus: Ende\/Stopp/.test(p.body) && /Flash-Schreibvorgänge seit Skriptstart: Speicher \d+, Einstellungen \d+, LED [23]\n/.test(p.body), p.body);
  // b) nach einem Stromausfall: Störung und Saison bleiben (gespeichert), Neustart sichtbar, Meldungen neu (nur RAM)
  w.powerFail(10 * M); w.runFor(15 * M);
  p = w.endpoint('info'); maxB = Math.max(maxB, Buffer.byteLength(p.body));
  check('S54b nach Stromausfall: Störung und Saison erhalten, Neustart mit letztem Stand davor', /Letzte Störung: 01\.06\.2027 10:1\d Trockenlauf/.test(p.body) &&
    /Automatik 2, Hand 0/.test(p.body) && /\nGerät: Firmware 1\.7\.1, an seit 01\.06\.2027 13:40 \(5 min\), davor zuletzt gespeichert 01\.06\.2027 1[23]:\d\d; Skript läuft seit 5 min\n/.test(p.body) &&
    /gestartet, Bodenkonto/.test(p.body) && !/Pumpe an \(|Pumpe aus:/.test(p.body.split('Letzte Meldungen (seit Skriptstart):')[1]), p.body);
  // c) Wetterdienst einen Vormittag weg: Beginn und Dauer des letzten Ausfalls
  w.httpCode = (url) => (w.t < T(2027, 6, 2, 12, 0) && /past_days|temperature_2m_min&timezone/.test(url) ? 503 : 200);
  w.run(T(2027, 6, 2, 11, 30)); const off = w.endpoint('info').body;
  w.run(T(2027, 6, 2, 14, 0)); p = w.endpoint('info'); maxB = Math.max(maxB, Buffer.byteLength(off), Buffer.byteLength(p.body));
  check('S54c Internetausfall ab dem ersten gescheiterten Versuch: währenddessen „fehlt seit“, danach Beginn und Dauer',
    /\nInternet: Wetterdienst fehlt seit 02\.06\.2027 10:0\d\n/.test(off) && /\nInternet: ok, letzter Ausfall 02\.06\.2027 10:0\d, 2 h\n/.test(p.body),
    off.split('\n')[9] + ' / ' + p.body.split('\n')[9]);
  // f) die letzten 6 Meldungen als Ring (der Shelly kennt kein Array.shift): nach dem Überlauf genau 6, neueste zuerst
  const logFn = (fs.readFileSync(FILE, 'utf8').match(/function ([\w$]+)\(\w+\)\{\s*var \w+ ?= ?[\w.]+ ?> ?1e9[^]{0,120}print\("\[BW\] "/) || [])[1] || 'log';
  for (let i = 1; i <= 23; i++) w.eval(logFn + '("Ringtest ' + i + '")');
  const zeilen = w.endpoint('info').body.split('Letzte Meldungen (seit Skriptstart):\n')[1].split('\n').map(z => z.replace(/^(\d\d\.\d\d\. ~?\d\d:\d\d|--\.-- --:--) /, ''));
  const neueste = w.logs.map(l => l.msg).filter(m => /^\[BW\] /.test(m)).map(m => m.slice(5)).slice(-6).reverse();
  check('S54f letzte Meldungen: nach 23 weiteren genau 6, neueste zuerst', zeilen.length === 6 &&
    zeilen.every((z, i) => z.slice(0, 30) === neueste[i].slice(0, 30)) && zeilen[0] === 'Ringtest 23' && zeilen[5] === 'Ringtest 18', zeilen.join(' | '));
  // d) Aufrufe ändern nichts: 100 Aufrufe, kein Schreibvorgang, Zustand gleich
  const s0 = JSON.stringify(w.state()), n0 = w.storageWrites.length + w.cfgCallT.length + w.ledWrites.length;
  for (let i = 0; i < 100; i++) w.endpoint('info');
  w.runFor(2 * M);
  check('S54d 100 Aufrufe: nichts geschrieben, Zustand gleich', JSON.stringify(w.state()) === s0 &&
    w.storageWrites.length + w.cfgCallT.length + w.ledWrites.length === n0, s0 + ' / ' + JSON.stringify(w.state()));
  // e) neue Saison: die erste Prüfung im März setzt die Zähler zurück
  const w2 = learnedWorld(T(2028, 3, 1, 6, 30));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { ev: dayNo(T(2028, 2, 29, 12)), dp: dayNo(T(2028, 2, 28, 12)),
    s0: dayNo(T(2027, 3, 1, 12)), sa: 61, sh: 9, sm: 702.5, sf: 3, fu: Math.floor(T(2027, 8, 3, 10, 2) / 1000), fo: 0,
    ft: devStr('Überlast (1800 W > 1716 W)') }));
  w2.powerFail(1000); w2.run(T(2028, 3, 1, 9, 0));
  const alt = w2.endpoint('info').body;
  w2.run(T(2028, 3, 1, 10, 30));
  const neu = w2.endpoint('info').body;
  check('S54e erste Prüfung im März: Saison neu gezählt, letzte Störung bleibt', /Saison seit 01\.03\.: Automatik 61, Hand 9, zusammen 702,5 mm, Störungen 3/.test(alt) &&
    /Saison seit 01\.03\.: Automatik 0, Hand 0, zusammen 0 mm, Störungen 0/.test(neu) && /Letzte Störung: 03\.08\.2027 10:02 Überlast/.test(neu),
    alt.split('\n')[6] + ' / ' + neu.split('\n')[6]);
  // g) Strom 6 h weg, Internet auch: der Ausfall beginnt mit geschätzter Uhr (Prüfung um 10:00 nach der Ankeruhr), der
  //    Zeitserver stellt die Uhr vor der Rückkehr des Wetterdienstes: Beginn und Dauer stimmen in echter Zeit
  const w4 = learnedWorld(T(2027, 6, 1, 6, 30));
  w4.storage.s = JSON.stringify(Object.assign(JSON.parse(w4.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  w4.powerFail(1000); w4.run(T(2027, 6, 2, 1, 0)); w4.internet = false; w4.powerFail(6 * H);   // Anker 22:00: Uhr 9 h nach
  w4.run(T(2027, 6, 2, 20, 30));
  const fail = w4.logs.find(l => l.t > T(2027, 6, 2, 1, 0) && /Tagesprüfung.*ohne Internet/.test(l.msg));
  w4.internet = true; w4.run(T(2027, 6, 2, 21, 30));
  const back = w4.logs.length, st4 = w4.state(), i4 = w4.endpoint('info').body;
  const sollD = fail ? (T(2027, 6, 2, 20, 30) - fail.t) / M : -1;
  check('S54g Ausfall bei geschätzter Uhr: Beginn und Dauer in echter Zeit', !!fail && Math.abs(st4.io * 1000 - fail.t) < 2 * M &&
    st4.id >= sollD - 0.5 && st4.id <= sollD + 20, (fail ? lt(w4, fail.t) : '-') + ' io=' + lt(w4, st4.io * 1000) + ' id=' + st4.id + ' soll≥' +
    Math.round(sollD) + ' · ' + i4.split('\n')[9] + ' ' + back);
  // f) Firmware ohne HTTPServer: Skript läuft ohne Diagnose-Seite weiter
  const w3 = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5), noHttpServer: true });
  w3.run(T(2027, 6, 4, 12, 0));
  check('S54f ohne HTTPServer: gemeldet, Skript gießt normal', logHas(w3, /Diagnose-Seite fehlt/) && w3.endpoint('info').code === 404 &&
    w3.runs().length >= 1, runsInfo(w3));
  check('S54 Seite höchstens 2 KB', maxB <= 2048, maxB + ' Byte');
  // h) Skript-Neustart während eines Ausfalls: der Ausfall bleibt (LED, Statuszeile, Diagnose), keine LED-Wechsel
  const w5 = learnedWorld(T(2027, 6, 1, 6, 30));
  w5.storage.s = JSON.stringify(Object.assign(JSON.parse(w5.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  w5.httpCode = () => 503; w5.powerFail(1000); w5.run(T(2027, 6, 1, 14, 0));
  const l5 = w5.ledWrites.length; w5.restartScript(); w5.run(T(2027, 6, 2, 9, 0));
  const i5 = w5.endpoint('info').body;
  w5.httpCode = null; w5.run(T(2027, 6, 2, 11, 0));
  check('S54h Neustart im Ausfall: weiter „fehlt seit“, gelb ohne LED-Wechsel; Rückkehr danach erkannt',
    /\nInternet: Wetterdienst fehlt seit 01\.06\.2027 10:0\d\n/.test(i5) && /ohne Internet/.test(w5.vcText()) === false &&
    w5.ledWrites.length === l5 + 1 && ledOf(w5) === '[0,100,0]' && /letzter Ausfall 01\.06\.2027 10:0\d/.test(w5.endpoint('info').body),
    i5.split('\n')[9] + ' · LED +' + (w5.ledWrites.length - l5) + ' · ' + w5.vcText());
  common(w, 'S54'); common(w2, 'S54e'); common(w3, 'S54f'); common(w4, 'S54g'); common(w5, 'S54h');
  return { bytes: maxB };
};

// ------------------------------------------------------------------
scenarios.S55_led_letzte_stoerung = function () {
  // die LED zeigt die letzte Störung, bis ein Lauf wieder fehlerfrei war, auch über Mitternacht und Neustart
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w.pump.mode = 'dry';
  w.powerFail(1000); w.run(T(2027, 6, 1, 14, 0));
  const led = () => JSON.stringify(w.plugsUi.leds.colors['switch:0'].off.rgb);
  check('S55 Trockenlauf: LED rot', led() === '[100,0,0]' && /Störung/.test(w.vcText()), led() + ' ' + w.vcText());
  w.run(T(2027, 6, 1, 20, 0)); w.powerFail(60e3); w.run(T(2027, 6, 2, 9, 0));
  check('S55 nach Neustart und Mitternacht: weiter rot, Status nennt die Störung', led() === '[100,0,0]' &&
    /Störung 01\.06\. \d\d:\d\d: Trockenlauf/.test(w.vcText()), led() + ' ' + w.vcText());
  w.pump.mode = 'normal'; w.run(T(2027, 6, 2, 12, 30));
  check('S55 nächster Lauf fehlerfrei: LED grün, Störung erledigt', led() === '[0,100,0]' && !/Störung/.test(w.vcText()) &&
    w.state().fo === 0 && /Letzte Störung: 01\.06\.2027 \d\d:\d\d Trockenlauf .*\(erledigt\)/.test(w.endpoint('info').body),
    led() + ' ' + w.vcText());
  common(w, 'S55');
};

// ------------------------------------------------------------------
scenarios.S56_schreibbremse = function () {
  // a) Speicher: die Pause im Bedienfeld wechselt einen Tag lang alle 20 s (jede Änderung will speichern)
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  w.powerFail(1000); w.runFor(5 * M);
  const t0 = w.t; let v = 0;
  for (let i = 0; i < 3 * 24 * 60; i++) { v = v ? 0 : 2; w.setVc('number:201', v); w.runFor(20e3); }
  const b0 = w.dev.bootAt, wr = w.storageWrites.filter(t => t >= b0 && t < b0 + 24 * H), gaps = wr.slice(1).map((t, i) => t - wr[i]);
  check('S56 Speicher: höchstens 1 je Minute, nach 48 im Tagesfenster 1 je Stunde', wr.length <= 48 + 24 && gaps.every(g => g >= 59e3),
    wr.length + ' Schreibvorgänge, kleinster Abstand ' + Math.min.apply(null, gaps) / 1000 + ' s');
  w.setVc('number:201', 0); w.runFor(3 * H);
  check('S56 nach dem Sturm: letzter Stand geschrieben', w.state().pu === 0, JSON.stringify(w.state().pu));
  // b) Einstellungen: die Firmware nimmt das Wiedereinschalten des Wächters an, ändert aber nichts
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30));
  w2.powerFail(1000); w2.runFor(5 * M);
  wdJob(w2).enable = false; w2.scheduleUpdateIgnored = true;
  const c0 = w2.t;
  w2.runFor(48 * H);
  const tag1 = w2.cfgCallT.filter(t => t >= c0 && t < c0 + 24 * H).length;
  check('S56b Einstellungen: höchstens 30 Schreibversuche am Tag, Bremse gemeldet', tag1 <= 30 && logHas(w2, /Schreibbremse Einstellungen/),
    tag1 + ' Versuche am ersten Tag');
  // c) Absturzschleife ohne Internet: das Skript steht alle 5 min, der Wächter startet es neu, jeder Start will den
  //    Zeitanker schreiben. Die Bremse zählt über Skript-Neustarts weiter.
  const w3 = learnedWorld(T(2027, 6, 1, 6, 30));
  w3.internet = false; w3.ntp = false;
  w3.powerFail(1000); w3.runFor(10 * M);
  const c3 = w3.t;
  for (let i = 0; i < 24 * 12; i++) { w3.stopScript(); w3.runFor(2 * M); w3.fireSchedules(); w3.runFor(3 * M); }
  const s3 = w3.storageWrites.filter(t => t >= c3 && t < c3 + 24 * H).length;
  const n3 = w3.logs.filter(l => l.t >= c3 && /ZEITPLAN startet Skript/.test(l.msg)).length;
  check('S56c Absturzschleife: höchstens 48 + 24 Schreibvorgänge am Tag', s3 <= 72 && n3 >= 250 && !w3.crashed,
    s3 + ' Schreibvorgänge bei ' + n3 + ' Neustarts');
  common(w, 'S56'); common(w2, 'S56b'); common(w3, 'S56c');
};

// ------------------------------------------------------------------
scenarios.S57_laufzeit_120_min = function () {
  // Jeder Lauf höchstens 120 min, Hand wie Automatik: zweite Grenze neben der Unterlast-Erkennung, falls ein zugedrehter
  // Hahn unerkannt bleibt. Den Timer hält die Firmware: er wirkt auch, wenn das Skript steht.
  // a) Regenrate 5 mm/h, Defizit 20 mm: 15 mm bräuchten 180 min, die Handgabe endet nach 120 min mit 10 mm
  const w = learnedWorld(T(2027, 6, 1, 13, 0));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20, ev: dayNo(T(2027, 6, 1, 12)) }));
  w.powerFail(1000); w.runFor(2 * M); w.setVc('number:202', 5); w.runFor(30e3);
  w.press(); w.runFor(2 * H + 5 * M);
  const r = w.runs();
  check('S57 Handgabe bei 5 mm/h: Timer 120 min statt 180, 10 mm gutgeschrieben', r.length === 1 && Math.abs(r[0].min - 120) < 0.2 &&
    r[0].offSrc === 'timer' && Math.abs(w.state().pi - 10) < 0.1, runsInfo(w) + ' pi=' + w.state().pi);
  // b) Skript steht während der Handgabe (Absturz): der Firmware-Timer schaltet trotzdem nach 120 min ab
  w.press(); w.runFor(5 * M); w.stopScript(); w.runFor(3 * H);
  const r2 = w.runs()[1];
  check('S57b Skript steht: Firmware schaltet nach 120 min ab', r2 && Math.abs(r2.min - 120) < 0.2 && r2.offSrc === 'timer', runsInfo(w));
  // c) kleine Handgabe bleibt, wie sie war (Defizit, mindestens 6 mm); die Automatik gibt weiter bis 15 mm (105 min)
  const w2 = learnedWorld(T(2027, 6, 1, 6, 30));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w2.powerFail(1000); w2.run(T(2027, 6, 1, 13, 0));
  w2.press(); w2.runFor(2 * H);
  const a2 = w2.runs();
  check('S57c Automatik 15 mm in 105 min, danach Handgabe 6 mm in 42 min', a2.length === 2 && Math.abs(a2[0].min - minFor(15)) < 0.5 &&
    Math.abs(a2[1].min - minFor(6)) < 0.5, runsInfo(w2));
  // d) Taster, während das Skript steht (Timer der Notabschaltung, 130 min): der Wächter startet es 4 min später, es
  //    macht daraus eine gewöhnliche Handgabe ab dann (Defizit 14 mm), höchstens 120 min ab Beginn
  const w3 = learnedWorld(T(2027, 6, 1, 13, 0));
  w3.powerFail(1000); w3.runFor(2 * M); w3.stopScript(); w3.runFor(M);
  w3.press(); w3.runFor(4 * M); w3.fireSchedules(); w3.runFor(3 * H);
  const r3 = w3.runs();
  check('S57d Taster bei stehendem Skript: gewöhnliche Handgabe ab dem Skriptstart, höchstens 120 min ab Beginn', r3.length === 1 &&
    Math.abs(r3[0].min - (4 + minFor(14))) < 0.5 && r3[0].min <= 120.5 && r3[0].offSrc === 'timer' &&
    logHas(w3, /Pumpe an \(hand\), Ziel 14 mm/), runsInfo(w3));
  // e) Automatik 15 mm bei 6 mm/h bräuchte 150 min: geplant nur 120 min (12 mm); Skript-Neustart nach 100 min ändert nichts
  const w4 = learnedWorld(T(2027, 6, 1, 6, 30));
  w4.storage.s = JSON.stringify(Object.assign(JSON.parse(w4.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 20 }));
  w4.powerFail(1000); w4.runFor(2 * M); w4.setVc('number:202', 6);
  w4.run(T(2027, 6, 1, 11, 40)); w4.restartScript(); w4.run(T(2027, 6, 1, 14, 0));
  const r4 = w4.runs();
  check('S57e Automatik bei 6 mm/h: 120 statt 150 min, Skript-Neustart nach 100 min: läuft seine 120 min zu Ende', r4.length === 1 &&
    Math.abs(r4[0].min - 120) < 0.5 && r4[0].offSrc === 'timer' && logHas(w4, /Pumpe an \(auto\), Ziel 12 mm in 120 min/), runsInfo(w4));
  common(w, 'S57'); common(w2, 'S57c'); common(w3, 'S57d'); common(w4, 'S57e');
};

scenarios.S58_einschalten_abgelehnt = function () {
  // die Firmware lehnt das Einschalten ab (etwa Übertemperatur): Statuszeile und LED zeigen es wie eine Störung;
  // die Automatik versucht es bis 12:30 weiter, ein fehlerfreier Lauf am Folgetag stellt die LED zurück
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  const led = () => JSON.stringify(w.plugsUi.leds.colors['switch:0'].off.rgb);
  w.switchRefuse = 1e9;
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 10));
  const s0 = w.state();
  check('S58 abgelehnt: Störung in der Statuszeile, neue Versuche bis 12:30, LED rot', w.runs().length === 0 &&
    /^Störung 10:0\d: Einschalten abgelehnt: overtemperature\. Neuer Versuch bis 12:30/.test(w.vcText()) &&
    led() === '[100,0,0]' && s0.fu > 0, led() + ' ' + w.vcText());
  w.run(T(2027, 6, 1, 13, 0));
  const tries = w.logs.filter(l => /Einschalten abgelehnt/.test(l.msg)).length;
  check('S58 bis 12:30 abgelehnt: kein Lauf, nächster Versuch morgen, je Minute höchstens 2 Versuche',
    w.runs().length === 0 && /Nächster Versuch morgen 10:00/.test(w.vcText()) && tries >= 100 && tries <= 2 * 155,
    tries + ' Versuche · ' + w.vcText());
  w.switchRefuse = 0; w.run(T(2027, 6, 2, 13, 0));
  check('S58 am Folgetag gegossen: LED grün, Störung erledigt', w.runs().length === 1 && led() === '[0,100,0]' &&
    !/Störung|abgelehnt/.test(w.vcText()) && w.state().fo === 0, led() + ' ' + w.vcText());
  common(w, 'S58');
};

// ------------------------------------------------------------------
// Funde der unabhängigen Prüfung, je Fund ein Szenario
const withLatLon = (code) => code.replace('LAT: null, LON: null', 'LAT: 49.51, LON: 8.55')           // Quelltext
  .replace(/("Ludwigshafen am Rhein",[\w$]+:"DE",[\w$]+:)null,([\w$]+:)null/, '$149.51,$28.55');      // Gerätefassung
const ledOf = (x) => JSON.stringify(x.plugsUi.leds.colors['switch:0'].off.rgb);
const ledOnOf = (x) => JSON.stringify(x.plugsUi.leds.colors['switch:0'].on.rgb);

scenarios.S59_pruefer_uhr_und_speicher = function () {
  // a) Erststart ohne Zeitserver: Einstecken gilt als 1. April 10:00, geprüft nach 10 min. Der Zeitserver stellt die Uhr,
  //    während der Wetterabruf läuft (Antwort erst nach dem nächsten Takt): die Antwort wird verworfen, die Tagesmarken
  //    sind verschoben, kein Lauf aus falsch gebuchten Tagen
  const w = mkWorld(T(2027, 6, 1, 6, 0), { weather: weatherConst(4.5), code: withLatLon(CODE) });
  w.storage = {}; w.ntp = false;
  let scharf = true;
  w.httpLat = (url) => {
    if (scharf && /past_days/.test(url)) { scharf = false; w.after(2000, () => ntpNow(w)); return 45000; }
    return 400;
  };
  w.powerFail(1000); w.run(T(2027, 6, 1, 13, 0));
  check('S59 Uhr gestellt, während der Wetterabruf läuft: Antwort verworfen, Tage verschoben, kein Lauf am ersten Tag',
    !scharf && w.runs().length === 0 && w.state().dp === dayNo(T(2027, 5, 31, 12)) && w.state().df === 0 && logHas(w, /Tagesmarken um \d+ Tage verschoben/),
    runsInfo(w) + ' dp=' + w.state().dp + ' df=' + w.state().df);
  // b) Absturzschleife ohne Internet: das Skript steht alle 5 min, der Wächter startet es neu. Ein Neustart schreibt
  //    nichts, also kommt die Tagesprüfung durch die Bremse in den Speicher: je Tag eine Gabe
  const w2 = learnedWorld(T(2027, 6, 1, 0, 0));
  w2.storage.s = JSON.stringify(Object.assign(JSON.parse(w2.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  w2.internet = false; w2.ntp = false;
  w2.powerFail(1000); w2.runFor(5 * M);
  while (w2.t < T(2027, 6, 3, 0, 0)) { w2.stopScript(); w2.runFor(2 * M); w2.fireSchedules(); w2.runFor(3 * M); }
  check('S59b Absturzschleife ohne Internet: je Tag eine Gabe, Tagesprüfung gespeichert',
    w2.runs().length === 2 && w2.state().ev === dayNo(T(2027, 6, 2, 12)) && w2.storageWrites.length <= 20,
    runsInfo(w2) + ' | ' + w2.storageWrites.length + ' Schreibvorgänge, ev=' + w2.state().ev);
  common(w, 'S59'); common(w2, 'S59b');
};

scenarios.S60_pruefer_einstellungen = function () {
  // Fünf fremde virtuelle Komponenten: das Bedienfeld passt nicht ganz, seine Versuche erschöpfen die Bremse für
  // Bedienfeld und Zeitpläne. LED und Relais-Sicherungen hängen nicht daran.
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  for (let i = 0; i < 5; i++) {
    w.vc['number:' + (100 + i)] = { type: 'number', id: 100 + i, config: { name: 'fremd' + i, persisted: true, default_value: 0 }, value: 0 };
  }
  w.powerFail(1000); w.run(T(2027, 6, 1, 15, 0));
  const gebremst = logHas(w, /Schreibbremse Einstellungen/);
  w.pump.mode = 'dry'; w.press(); w.runFor(3 * M); w.pump.mode = 'normal';
  w.swCfg.auto_off = false;
  w.runFor(10 * M);
  const led = ledOf(w);
  w.runFor(60 * M);
  check('S60 Bremse für das Bedienfeld erschöpft: LED trotzdem rot, Notabschaltung binnen 1 h zurück',
    gebremst && led === '[100,0,0]' && w.swCfg.auto_off === true, 'gebremst=' + gebremst + ' LED ' + led + ' auto_off=' + w.swCfg.auto_off);
  common(w, 'S60');
};

scenarios.S61_led_schreibvorgaenge = function () {
  // Jede LED-Farbe ist ein Flash-Schreibvorgang: rot nach 2 min Bestand, jede andere Farbe erst nach 30 min,
  // höchstens 12 am Tag.
  // a) eine Woche lang fehlt der Wetterdienst jeden Vormittag 10:00 bis 11:05: erkannt 11:00, zurück 11:15 -> keine LED-Wechsel
  const a = learnedWorld(T(2027, 6, 1, 6, 30));
  a.powerFail(1000); a.runFor(10 * M);
  const a0 = a.ledWrites.length;
  a.httpCode = (url) => { const q = berlinParts(a.t), m = q.hh * 60 + q.mm; return m >= 600 && m < 665 ? 503 : 200; };
  a.run(T(2027, 6, 8, 23, 0));
  const offs = a.logs.filter(l => /Tagesprüfung.*ohne Internet/.test(l.msg)).length;
  check('S61 Wetterdienst täglich kurz weg: ohne Internet entschieden, keine LED-Wechsel', offs >= 6 && a.ledWrites.length === a0,
    offs + ' Tage ohne Wetter, LED +' + (a.ledWrites.length - a0));
  // b) zwei Tage weg: gelb 30 min nach dem Erkennen, grün 30 min nach der Rückkehr, zusammen 2 Wechsel
  const b = learnedWorld(T(2027, 6, 1, 6, 30));
  b.powerFail(1000); b.runFor(10 * M);
  const b0 = b.ledWrites.length;
  b.httpCode = (url) => (b.t < T(2027, 6, 3, 12, 0) ? 503 : 200);
  b.run(T(2027, 6, 3, 15, 0));
  const lw = b.ledWrites.slice(b0), seit = (t, x) => (t - x) / M;   // erkannt nach dem 4. Versuch um 11:00
  check('S61b zwei Tage ohne Wetterdienst: gelb 30 min nach dem Erkennen, grün 30 bis 47 min nach der Rückkehr, 2 Wechsel',
    lw.length === 2 && seit(lw[0], T(2027, 6, 1, 11, 0)) >= 30 && seit(lw[0], T(2027, 6, 1, 11, 0)) <= 32 &&
    seit(lw[1], T(2027, 6, 3, 12, 0)) >= 30 && seit(lw[1], T(2027, 6, 3, 12, 0)) <= 47, lw.map(t => lt(b, t)).join(', '));
  // c) Störung: rot binnen 3 min
  const c = learnedWorld(T(2027, 6, 1, 14, 0));
  c.powerFail(1000); c.runFor(10 * M);
  c.pump.mode = 'dry'; c.press(); c.runFor(10 * M); c.pump.mode = 'normal';
  const trip = c.relay.filter(x => !x.on).pop(), vi = c.ledWrites[c.ledWrites.length - 1];
  check('S61c Störung: rot binnen 3 min', ledOf(c) === '[100,0,0]' && vi - trip.t <= 3 * M, ((vi - trip.t) / 1000) + ' s');
  // d) Störung und fehlerfreier Lauf wechseln den ganzen Tag (Handgaben alle 35 min): höchstens 12 LED-Wechsel am Tag
  const d = learnedWorld(T(2027, 6, 1, 14, 0));
  d.powerFail(1000); d.runFor(10 * M);
  const d0 = d.ledWrites.length, td = d.t;
  for (let k = 0; d.t < td + 24 * H; k++) {
    d.pump.mode = k % 2 ? 'normal' : 'dry'; d.press(); d.runFor(2 * M);
    if (d.dev.output) d.press();          // fehlerfreier Lauf: nach 2 min von Hand gestoppt
    d.runFor(33 * M);
  }
  const nd = d.ledWrites.filter(t => t < d.ledWrites[0] + 24 * H).length;   // ab dem ersten Setzen beim Start
  check('S61d Störung und fehlerfreier Lauf im Wechsel: höchstens 12 LED-Wechsel am Tag', nd === 12 && d0 === 1, nd + ' Wechsel');
  common(a, 'S61'); common(b, 'S61b'); common(c, 'S61c'); common(d, 'S61d');
};

scenarios.S62_pruefer_rest = function () {
  // a) Einschalten an zwei Tagen hintereinander abgelehnt: die Störung trägt den zweiten Tag
  const a = learnedWorld(T(2027, 6, 1, 6, 30));
  a.storage.s = JSON.stringify(Object.assign(JSON.parse(a.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  a.switchRefuse = 1e9;
  a.powerFail(1000); a.run(T(2027, 6, 2, 10, 10));
  check('S62 Einschalten am Folgetag wieder abgelehnt: Störung neu datiert', /^Störung 10:0\d: Einschalten abgelehnt/.test(a.vcText()) &&
    dayNo(a.state().fu * 1000) === dayNo(T(2027, 6, 2, 12)) && ledOf(a) === '[100,0,0]', a.vcText());
  // b) nach einem Stromausfall steht das WLAN erst 10 s nach dem Hochfahren: bald kein „ohne Internet“, keine LED-Wechsel
  const b = learnedWorld(T(2027, 6, 1, 6, 30));
  b.storage.s = JSON.stringify(Object.assign(JSON.parse(b.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  b.powerFail(1000); b.run(T(2027, 6, 1, 14, 0));
  const l0 = b.ledWrites.length;
  b.internet = false; b.powerFail(60e3);
  b.after(60e3 + 10e3, () => { b.internet = true; });
  b.runFor(70e3 + 4 * M);
  check('S62b WLAN erst nach dem Hochfahren: nach 4 min kein „ohne Internet“, keine LED-Schreibvorgänge',
    !/ohne Internet/.test(b.vcText()) && b.ledWrites.length === l0, b.vcText() + ' | LED +' + (b.ledWrites.length - l0));
  common(a, 'S62'); common(b, 'S62b');
};

// ------------------------------------------------------------------
// Anlernen per Taster: Hahn offen, einstecken, in der ersten Minute 5× drücken, gut 1 min später Hahn zu (kein Signal)
function kalWorld(o) {                    // nicht angelerntes Gerät, eingesteckt am 15.05.2027 14:00 (keine Automatik)
  o = o || {};
  const w = learnedWorld(T(2027, 5, 15, 14, 0));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 14, 12)), d: 3, pn: 0, ln: 0 }, o.s || {}));
  if (o.Pn) w.pump.Pn = o.Pn;
  if (o.closedRel) w.pump.closedRel = o.closedRel;
  if (o.noise !== undefined) w.pump.noise = o.noise;
  if (o.mode) w.pump.mode = o.mode;
  w.powerFail(1000); w.runFor(1500);       // Hochfahren nach 1 s, Skript nach weiteren 3 s
  return w;
}
function presses(w, n, firstS, gapS) {    // n Drücke, der erste firstS nach dem Hochfahren
  const b = w.dev.bootAt;
  for (let i = 0; i < n; i++) w.at(b + (firstS + i * gapS) * 1000, () => w.press());
}
function runUntil(w, cond, maxMs) { const end = w.t + maxMs; while (w.t < end && !cond()) w.runFor(250); return cond(); }
const kalLog = (w) => w.logs.filter(l => /Anlernen|Angelernt|Pumpenwerte/.test(l.msg)).map(l => lt(w, l.t).slice(11) + ' ' + l.msg.slice(5)).join(' | ');
function kalZu(w, s) {                    // Hahn zu, s Sekunden nach dem 5. Druck (Drücke ab 10 s im Abstand 1,5 s: 5. bei 16 s)
  w.at(w.dev.bootAt + (16 + s) * 1000, () => { w.pump.mode = 'closed'; });
}
scenarios.S63_anlernen = function () {
  // a) regulär: 70 s nach dem 5. Druck zugedreht
  const w = kalWorld();
  presses(w, 5, 10, 1.5); kalZu(w, 75);
  w.runFor(30e3);
  const t1 = w.vcText(), tm1 = w.dev.timer && w.dev.timer.dur;
  check('S63a 5 Drücke in der ersten Minute: Anlernen läuft, Firmware-Timer 300 s', /^Anlernen: Hahn offen lassen, Normalleistung messen/.test(t1) &&
    tm1 === 300, t1 + ' / ' + tm1);
  const lw0 = w.ledWrites.length;
  w.runFor(56e3);                         // Normalleistung fertig 60 s nach dem 5. Druck, Statuszeile alle 10 s
  const t2 = w.vcText(), on5 = w.relay.filter(x => x.src === 'button').slice(-1)[0];
  const cueT = w.ledWrites.filter(t => t > on5.t)[0], cueC = ledOnOf(w);
  check('S63a nach 1 min: LED im Lauf weiß (binnen 2 s), Statuszeile „LED weiß: jetzt Hahn zudrehen“',
    /^Anlernen: LED weiß: jetzt Hahn zudrehen/.test(t2) && cueC === '[100,100,100]' && cueT && cueT - on5.t >= 60e3 && cueT - on5.t <= 62e3 &&
    w.ledWrites.length === lw0 + 1, t2 + ' · ' + cueC + ' nach ' + (cueT ? (cueT - on5.t) / 1000 : '-') + ' s');
  runUntil(w, () => logHas(w, /Angelernt|Anlernen abgebrochen/), 3 * M); w.runFor(5e3);
  const st = w.state(), last = w.relay.slice(-1)[0], mid = w.relay.filter(x => x.t > on5.t && x.t < last.t);
  check('S63a nach dem Anlernen: LED im Lauf wieder blau, gleich (2 Schreibvorgänge fürs Anlernen)', ledOnOf(w) === '[0,0,100]' &&
    w.ledWrites.length === lw0 + 2 && w.ledWrites[w.ledWrites.length - 1] - last.t <= 3e3, ledOnOf(w) + ' · ' + (w.ledWrites.length - lw0));
  check('S63a kein Aus-Ein-Zeichen: das Relais bleibt bis zum Ende an (kein Rückschlagventil), das Zeichen ist die weiße LED',
    mid.length === 0 && last.src === 'loopback' && !last.on, JSON.stringify(mid.map(x => [x.on, x.src, x.t - on5.t])));
  check('S63a übernommen: normal ~1320 W, Hahn zu ~818 W, Untergrenze in der Mitte ~1069 W, danach aus',
    Math.abs(st.pn - 1320) <= 20 && Math.abs(st.pc - 818) <= 20 && st.kt > 1 && !w.dev.output &&
    last.t - on5.t < 2 * M && logHas(w, /Angelernt: 13\d\d W, Hahn zu 8\d\d W, Untergrenze 10[5-8]\d W/), JSON.stringify({ pn: st.pn, pc: st.pc }) + ' · ' + kalLog(w));
  check('S63a Status-Abo nach der ersten Minute beendet (Handle 0)', Object.keys(w.dev.stHandlers).length === 0 && w.dev.stSeq === 1, JSON.stringify(Object.keys(w.dev.stHandlers)));
  let i1 = w.endpoint('info').body;
  check('S63a Diagnose: angelernt mit Datum, beide Werte, Grenzen', /\nPumpe: angelernt 15\.05\.2027 14:0\d, normal 13\d\d W, Hahn zu 8\d\d W; Untergrenze 10[5-8]\d W, Obergrenze 17\d\d W\n/.test(i1),
    i1.split('\n').filter(z => /^Pumpe/.test(z)).join(''));
  // im Betrieb: Hahn offen läuft, zugedreht schaltet die Unterlast nach Anlauf (40 s) plus 8 s ab
  w.pump.mode = 'normal'; w.runFor(3 * M); w.press(); w.runFor(2 * M);
  const ok1 = w.dev.output;
  w.pump.mode = 'closed'; const tz = w.t; w.runFor(30e3);
  const tr = w.relay.filter(x => !x.on && x.t > tz)[0];
  check('S63a danach: Handgabe läuft bei offenem Hahn, zugedreht nach ~8 s aus (Unterlast)', ok1 && tr && tr.t - tz <= 12e3 &&
    logHas(w, /Schutz: unterlast \(8\d\d W < 10[5-8]\d W\)/), (tr ? (tr.t - tz) / 1000 + ' s' : 'kein Aus') + ' · ' + runsInfo(w));
  w.powerFail(10e3); w.runFor(2 * M);
  i1 = w.endpoint('info').body;
  check('S63a nach Stromausfall: angelernte Werte und Störung gespeichert', w.state().pn === st.pn && w.state().pc === st.pc &&
    /\nPumpe: angelernt 15\.05\.2027/.test(i1) && /\nStörungen \(gespeichert, neueste zuerst\):\n15\.05\.2027 14:0\d Trockenlauf oder Hahn zu \(8\d\d W < 10\d\d W\)\n/.test(i1),
    i1.split('\n').slice(-12).join(' | '));
  // Bedienfeld-Knopf: zurück auf die Voreinstellung
  w.pressVcButton('button:200'); w.runFor(M);
  i1 = w.endpoint('info').body;
  check('S63a Knopf im Bedienfeld: Voreinstellung (600/2100 W), Hinweis zum Anlernen', w.state().pn === 0 && w.state().pc === 0 &&
    w.state().kt === 0 && /\nPumpe: Voreinstellung, nicht angelernt; Untergrenze 600 W, Obergrenze 2100 W\n/.test(i1) &&
    logHas(w, /Pumpe auf Voreinstellung; anlernen: einstecken, 5× drücken/), w.vcText());
  common(w, 'S63a');

  // b) nicht zugedreht: nach 3 min Normalleistung übernommen, Untergrenze 75 %
  const b = kalWorld(); presses(b, 5, 10, 1.5); b.runFor(4 * M);
  const bOff = b.relay.filter(x => !x.on).slice(-1)[0], bOn = b.relay.filter(x => x.src === 'button').slice(-1)[0];
  check('S63b nicht zugedreht: nach 3 min übernommen, Untergrenze 75 % (990 W), Diagnose „Hahn zu nicht erkannt“',
    Math.abs(b.state().pn - 1320) <= 20 && b.state().pc === 0 && logHas(b, /Angelernt: 13\d\d W, Hahn nicht zugedreht, Untergrenze 9[89]\d W/) &&
    bOff && Math.abs(bOff.t - bOn.t - 182e3) <= 3e3 &&
    /\nPumpe: angelernt 15\.05\.2027 14:0\d, normal 13\d\d W, Hahn zu nicht erkannt; Untergrenze 9[89]\d W/.test(b.endpoint('info').body),
    kalLog(b) + ' · aus nach ' + (bOff ? (bOff.t - bOn.t) / 1000 : '-') + ' s');
  // c) Grenzen zu eng: zugedreht nur 14 % weniger -> nicht verwendet; 22 % weniger -> Mitte, je mindestens 10 % Abstand
  const c = kalWorld({ closedRel: 0.86 }); presses(c, 5, 10, 1.5); kalZu(c, 70); c.runFor(3 * M);
  check('S63c Hahn zu nur 14 % weniger: nicht erkennbar, Untergrenze 75 %', c.state().pc === 0 && Math.abs(c.state().pn - 1320) <= 20 &&
    logHas(c, /Angelernt: 13\d\d W, Hahn zu nur 1[345] % weniger, nicht erkennbar, Untergrenze 9[89]\d W/), kalLog(c));
  const c2 = kalWorld({ closedRel: 0.78 }); presses(c2, 5, 10, 1.5); kalZu(c2, 70); c2.runFor(3 * M);
  const s2 = c2.state(), lo2 = (s2.pn + s2.pc) / 2;
  check('S63c Hahn zu 22 % weniger: Untergrenze in der Mitte, zu beiden Seiten mindestens 10 % Abstand', s2.pc > 0 &&
    lo2 <= s2.pn * 0.9 + 1 && lo2 >= s2.pc * 1.1, JSON.stringify(s2.pn + '/' + s2.pc + ' -> ' + lo2) + ' · ' + kalLog(c2));
  // d) kleine Tauchpumpe 400 W: übernommen; Trockenlauf danach erkannt
  const d = kalWorld({ Pn: 400, noise: 8 }); presses(d, 5, 10, 1.5); kalZu(d, 70); d.runFor(3 * M);
  const sd = d.state();
  d.pump.mode = 'normal'; d.runFor(3 * M); d.press(); d.runFor(M); d.pump.mode = 'dry'; d.runFor(M);
  check('S63d kleine Pumpe 400 W: angelernt (Hahn zu ~248 W), Trockenlauf danach erkannt', Math.abs(sd.pn - 400) <= 10 && Math.abs(sd.pc - 248) <= 10 &&
    logHas(d, /Schutz: unterlast \(1\d\d W < 3[12]\d W\)/), JSON.stringify({ pn: sd.pn, pc: sd.pc }) + ' · ' + kalLog(d) + ' · ' + runsInfo(d));
  // e) unplausibel: zu wenig, zu viel, unruhig -> abgebrochen, nichts übernommen, im Störungsprotokoll
  const e = kalWorld({ Pn: 250, noise: 5 }); presses(e, 5, 10, 1.5); e.runFor(2 * M);
  const ie = e.endpoint('info').body;
  const eAb = e.logs.filter(l => /Anlernen abgebrochen/.test(l.msg))[0], eLed = e.ledWrites.filter(t => eAb && t >= eAb.t)[0];
  check('S63e Abbruch ist eine Störung: LED binnen 15 s rot, nicht erst nach 2 min', e.state().fo === 1 && eLed && eLed - eAb.t <= 15e3 &&
    ledOf(e) === '[100,0,0]', (eLed ? (eLed - eAb.t) / 1000 + ' s ' : 'keine LED ') + ledOf(e));
  check('S63e 250 W: abgebrochen, nichts übernommen, gespeichert im Störungsprotokoll', e.state().pn === 0 && !e.dev.output &&
    logHas(e, /Anlernen abgebrochen: 2[45]\d W zu wenig – nichts übernommen/) && /\n15\.05\.2027 14:0\d Anlernen abgebrochen \(2[45]\d W zu wenig\)/.test(ie),
    kalLog(e) + ' · ' + ie.split('Störungen')[1]);
  const e2 = kalWorld({ Pn: 2000 }); presses(e2, 5, 10, 1.5); e2.runFor(2 * M);
  const e3 = kalWorld({ mode: 'airmix' }); presses(e3, 5, 10, 1.5); e3.runFor(2 * M);
  const e4 = kalWorld(); presses(e4, 5, 10, 1.5); kalZu(e4, 52); e4.runFor(2 * M);
  check('S63e 2000 W zu viel, Luftgemisch unruhig, im Messfenster zugedreht: abgebrochen, nichts übernommen', e2.state().pn === 0 &&
    e3.state().pn === 0 && e4.state().pn === 0 && logHas(e2, /Anlernen abgebrochen: 20\d\d W zu viel/) &&
    logHas(e3, /Anlernen abgebrochen: unruhig \d+-\d+ W, zu früh zugedreht oder Luft im Rohr\?/) &&
    logHas(e4, /Anlernen abgebrochen: unruhig [78]\d\d-13\d\d W/) && JSON.parse(e3.storage.f)[0].indexOf('ka:unruhig ') > 0,
    kalLog(e2) + ' // ' + kalLog(e3) + ' // ' + kalLog(e4));
  // f) Taster während des Anlernens (6. Druck): abgebrochen, nichts übernommen
  const f = kalWorld(); presses(f, 5, 10, 1.5); f.at(f.dev.bootAt + 45e3, () => f.press()); f.runFor(2 * M);
  check('S63f Taster während des Anlernens: aus, abgebrochen, nichts übernommen, im Störungsprotokoll', f.state().pn === 0 && !f.dev.output &&
    logHas(f, /Anlernen abgebrochen: ausgeschaltet – nichts übernommen/) && /ka:ausgeschaltet/.test(f.storage.f || ''), kalLog(f));
  // g) Geste: 5 Drücke binnen 10 s in der ersten Minute. Zu spät, der 5. Druck nach der ersten Minute, nur 3 Drücke,
  //    langsamer als 10 s: kein Anlernen, eine Handgabe läuft; 8 s gehen; der erste Druck vor dem Skriptstart zählt mit
  const g1 = kalWorld(); presses(g1, 5, 65, 1.5); g1.runFor(2 * M);
  const g2 = kalWorld(); presses(g2, 5, 30, 8); g2.runFor(2 * M);
  const g3 = kalWorld(); presses(g3, 3, 10, 1.5); g3.runFor(2 * M);
  const g4 = kalWorld(); presses(g4, 5, 10, 2.7); g4.runFor(2 * M);      // 10,8 s vom 1. bis zum 5. Druck
  const g6 = kalWorld(); presses(g6, 5, 10, 10); g6.runFor(2 * M);       // alle in der ersten Minute, aber über 40 s
  check('S63g zu spät, 5. Druck nach der ersten Minute, nur 3 Drücke, 10,8 s und 40 s für 5 Drücke: kein Anlernen, eine Handgabe läuft',
    [g1, g2, g3, g4, g6].every(x => !logHas(x, /Anlernen/) && x.state().pn === 0 && x.dev.output && x.dev.timer && x.dev.timer.dur !== 300),
    [g1, g2, g3, g4, g6].map(kalLog).join(' // '));
  const g7 = kalWorld(); presses(g7, 5, 10, 2); kalZu(g7, 72); g7.runFor(3 * M);   // 8 s vom 1. bis zum 5. Druck
  const g5 = learnedWorld(T(2027, 5, 15, 14, 0));
  g5.storage.s = JSON.stringify(Object.assign(JSON.parse(g5.storage.s), { dp: dayNo(T(2027, 5, 14, 12)), d: 3, pn: 0 }));
  g5.powerFail(1000); g5.runFor(1200); g5.press(); g5.runFor(300);    // 1. Druck 0,2 s nach dem Hochfahren, das Skript startet erst
  const g5pre = !g5.dev.scriptRunning || g5.logs.filter(l => /gestartet, Bodenkonto/.test(l.msg)).length < 2;
  presses(g5, 4, 4, 1.5); g5.runFor(40e3);
  check('S63g 5 Drücke in 8 s: Anlernen; 1. Druck vor dem Skriptstart zählt mit (als Druck beim Skriptstart)',
    logHas(g7, /Angelernt: 13\d\d W, Hahn zu 8\d\d W/) && g5pre && logHas(g5, /Anlernen: Hahn offen lassen/), kalLog(g7) + ' // ' + kalLog(g5));
  // h) Stromausfall während des Anlernens: nichts übernommen; Automatik aus: Anlernen läuft trotzdem durch
  const h = kalWorld(); presses(h, 5, 10, 1.5); h.runFor(40e3); h.powerFail(5e3); h.runFor(2 * M);
  const h2 = kalWorld(); h2.setVc('boolean:200', false); presses(h2, 5, 10, 1.5); kalZu(h2, 70); h2.runFor(3 * M);
  check('S63h Stromausfall: nichts übernommen; Automatik aus: Anlernen läuft durch', h.state().pn === 0 && !logHas(h, /Angelernt/) &&
    h2.state().pc > 0 && logHas(h2, /Angelernt/), kalLog(h) + ' // ' + kalLog(h2));
  // i) Skript steht während des Anlernens: der Firmware-Timer schaltet nach 300 s ab
  const k2 = kalWorld(); presses(k2, 5, 10, 1.5); k2.runFor(40e3); k2.stopScript(); k2.runFor(6 * M);
  const k2on = k2.logs.filter(x => /Anlernen: Hahn offen lassen/.test(x.msg))[0], k2off = k2.relay.filter(x => !x.on).slice(-1)[0];
  check('S63i Skript steht: Firmware-Timer aus nach 300 s', k2on && k2off && k2off.src === 'timer' && Math.abs(k2off.t - k2on.t - 300e3) <= 1500 &&
    k2.state().pn === 0, k2off ? k2off.src + ' ' + (k2off.t - k2on.t) / 1000 + ' s' : 'kein Aus');
  // j) Fehlbedienung: Hahn schon beim Anlernen zu (oder zu früh zugedreht) -> als Normalleistung übernommen; im Betrieb
  //    meldet die Pumpe gleich Überlast (sicher), neu anlernen
  const j = kalWorld({ mode: 'closed' }); presses(j, 5, 10, 1.5); j.runFor(4 * M);
  const sj = j.state(); j.pump.mode = 'normal'; j.press(); j.runFor(2 * M);
  check('S63j Hahn beim Anlernen schon zu: übernommen, im Betrieb Überlast nach Anlauf', Math.abs(sj.pn - 818) <= 20 &&
    logHas(j, /Schutz: ueberlast \(13\d\d W > 10\d\d W\)/) && !j.dev.output, JSON.stringify(sj.pn) + ' · ' + runsInfo(j));
  // l) Stecker gleich nach dem Anlernen gezogen: Werte schon gespeichert (Schreibbremse greift hier nicht)
  const l = kalWorld(); presses(l, 5, 10, 1.5); kalZu(l, 70);
  runUntil(l, () => logHas(l, /Angelernt/), 3 * M); l.runFor(1500); l.powerFail(5e3); l.runFor(M);
  check('S63l Stecker 1,5 s nach dem Anlernen gezogen: Werte gespeichert', l.state().pc > 0 && Math.abs(l.state().pn - 1320) <= 20, kalLog(l));
  // m) Fehlbedienung: Brunnen leer beim Anlernen (Trockenlauf 554 W, ruhig, im Fenster 300-1900 W): ohne Hahn-zu-Messung
  //    unter 600 W nichts übernommen; kleine Pumpe ohne Zudrehen ebenso. Mit Zudrehen übernimmt sie (S63d)
  const m = kalWorld({ mode: 'dry' }); presses(m, 5, 10, 1.5); kalZu(m, 70); m.runFor(4 * M);
  const m2 = kalWorld({ Pn: 400, noise: 8 }); presses(m2, 5, 10, 1.5); m2.runFor(4 * M);
  check('S63m Trockenlauf beim Anlernen, kleine Pumpe ohne Zudrehen: unter 600 W nichts übernommen', m.state().pn === 0 && m2.state().pn === 0 &&
    logHas(m, /Anlernen abgebrochen: Hahn nicht zugedreht; unter 600 W nur mit Zudrehen \(Trockenlauf\?\) – nichts übernommen/) &&
    /ka:trocken\? 5\d\d W/.test(m.storage.f || '') && logHas(m2, /unter 600 W nur mit Zudrehen/), kalLog(m) + ' // ' + kalLog(m2));
  // n) abgebrochenes Anlernen hebt eine offene Störung nicht auf, gelungenes schon; Blockade beim Anlernen ist eine Störung
  const fs0 = { fo: 1, fu: Math.floor(T(2027, 5, 14, 10, 5) / 1000), ft: 'Pumpe zieht keinen Strom (0 W)' };
  const n2 = kalWorld({ Pn: 250, noise: 5, s: fs0 }); presses(n2, 5, 10, 1.5); n2.runFor(2 * M);
  const n3 = kalWorld({ s: fs0 }); presses(n3, 5, 10, 1.5); kalZu(n3, 70); n3.runFor(3 * M);
  const n4 = kalWorld(); presses(n4, 5, 10, 1.5); n4.runFor(30e3); n4.pump.mode = 'blocked'; n4.runFor(M); n4.pump.mode = 'normal';
  const n3A = n3.logs.filter(l => /Angelernt/.test(l.msg))[0], n3L = n3.ledWrites.filter(t => n3A && t > n3A.t)[0];
  check('S63n abgebrochenes Anlernen lässt die offene Störung stehen, gelungenes hebt sie auf, LED gleich wieder grün', n2.state().fo === 1 &&
    n3.state().fo === 0 && n3.state().pc > 0 && n3L && n3L - n3A.t <= 15e3 && ledOf(n3) === '[0,100,0]',
    'n2 fo=' + n2.state().fo + ' n3 fo=' + n3.state().fo + ' LED nach ' + (n3L ? (n3L - n3A.t) / 1000 : '-') + ' s ' + ledOf(n3));
  check('S63n Blockade beim Anlernen: Störung, im Protokoll, nichts übernommen', n4.state().pn === 0 && n4.state().fo === 1 &&
    /(fw|blockiert):/.test(n4.storage.f || '') && !n4.dev.output, (n4.storage.f || '') + ' · ' + kalLog(n4));
  // o) Aus-Befehl geht verloren (Hahn zu im Betrieb, Unterlast): das Skript schickt ihn alle 5 s erneut
  const o = kalWorld({ s: { pn: 1320, pc: 818, kt: 1 } }); o.runFor(2 * M); o.press(); o.runFor(70e3); o.offLost = 2;
  o.pump.mode = 'closed'; const to = o.t; o.runFor(M);
  const oOff = o.relay.filter(x => !x.on && x.t > to)[0];
  check('S63o Aus-Befehl zweimal verloren: nach gut 10 s doch aus (sonst Firmware-Timer)', oOff && oOff.t - to <= 25e3 && o.offLost === 0,
    (oOff ? (oOff.t - to) / 1000 + ' s' : 'kein Aus') + ' · ' + runsInfo(o));
  // p) einzelner Druck, bevor das Skript läuft: normale Handgabe, kein 120-min-Lauf
  const p = learnedWorld(T(2027, 5, 15, 14, 0));
  p.storage.s = JSON.stringify(Object.assign(JSON.parse(p.storage.s), { dp: dayNo(T(2027, 5, 14, 12)), d: 3 }));
  p.powerFail(1000); p.runFor(1200); p.press(); p.runFor(30e3);
  const pt = p.dev.timer && p.dev.timer.dur;
  check('S63p Druck vor dem Skriptstart: normale Handgabe (Timer wie eine Handgabe, nicht 120 min)', p.dev.output && pt >= 2000 && pt <= 3000 &&
    logHas(p, /Pumpe an \(hand\), Ziel 6 mm in 42 min/), pt + ' s · ' + runsInfo(p));
  // q) Skript startet mitten im Anlernen neu, während die LED weiß ist: danach wieder blau (binnen 2 min), kein Dauerweiß
  const q = kalWorld(); presses(q, 5, 10, 1.5); q.runFor(80e3);
  const qCue = ledOnOf(q); q.restartScript(); q.runFor(3 * M);
  check('S63q Skript-Neustart bei weißer LED: danach im Lauf wieder blau', qCue === '[100,100,100]' && ledOnOf(q) === '[0,0,100]',
    qCue + ' -> ' + ledOnOf(q) + ' · ' + kalLog(q));
  const tests = [b, c, c2, d, e, e2, e3, e4, f, g1, g2, g3, g4, g6, g7, g5, h, h2, k2, j, l, m, m2, n2, n3, n4, o, p, q];
  tests.forEach((x, n) => common(x, 'S63-' + n));
  return { a: kalLog(w).slice(0, 400), speicher: JSON.stringify(w.maxStore) };
};

// ------------------------------------------------------------------
scenarios.S66_hahn_zu_ohne_anlernen = function () {
  // nicht angelernt (600/2100 W): ein im Lauf zugedrehter Hahn fällt am Bezug des Laufs auf (20 % darunter), der Nachlauf
  // mit noch zugedrehtem Hahn ebenso (Bezug des Laufs davor); ein schon vor dem Start zugedrehter Hahn nur mit Anlernen
  const nl = { pn: 0, pc: 0, kt: 0 };
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }, nl));
  w.powerFail(1000); w.run(T(2027, 6, 1, 10, 20));
  const r1 = w.runs()[0];
  w.pump.mode = 'closed'; const tz = w.t; w.runFor(M);
  const off1 = w.relay.filter(x => !x.on && x.t > tz)[0];
  check('S66a nicht angelernt, Hahn im Lauf zugedreht: nach gut 8 s aus, Untergrenze 80 % des Bezugs', r1 && off1 && off1.t - tz <= 15e3 &&
    logHas(w, /Schutz: unterlast \(8\d\d W < 10[3-7]\d W\)/) && w.state().rq >= 1290 && w.state().rq <= 1350,
    (off1 ? (off1.t - tz) / 1000 + ' s' : 'kein Aus') + ' · rq ' + w.state().rq + ' · ' + runsInfo(w));
  w.run(T(2027, 6, 1, 11, 30));
  const r2 = w.runs()[1];
  check('S66b Nachlauf, Hahn noch zu: nach gut 1 min aus (Bezug des Laufs davor)', r2 && r2.off && r2.min * 60 <= 75 &&
    w.logs.filter(l => /Schutz: unterlast \(8\d\d W < 10[3-7]\d W\)/.test(l.msg)).length >= 2, runsInfo(w));
  w.pump.mode = 'normal'; w.run(T(2027, 6, 1, 14, 0));
  const r3 = w.runs()[2];
  check('S66c Hahn wieder offen: der zweite Nachlauf gibt den Rest ohne Fehlauslösung', r3 && r3.offSrc === 'timer' && r3.min > 30 &&
    !logHas(w, /Schutz: unterlast \(1\d\d\d W/), runsInfo(w));
  const v = learnedWorld(T(2027, 6, 1, 6, 30));
  v.storage.s = JSON.stringify(Object.assign(JSON.parse(v.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }, nl));
  v.pump.mode = 'closed'; v.powerFail(1000); v.run(T(2027, 6, 1, 10, 10));
  check('S66d Hahn schon vor dem Start zu, nicht angelernt: fällt nicht auf (Grenze: Anlernen, 120 min)', v.dev.output && !logHas(v, /Schutz/),
    runsInfo(v));
  // e) angelernt ohne Hahn-zu-Wert (Untergrenze 75 % = 990 W): kein Bezug je Lauf, ein Abfall auf 78 % schaltet nicht ab
  const x = learnedWorld(T(2027, 6, 1, 6, 30));
  x.storage.s = JSON.stringify(Object.assign(JSON.parse(x.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14, pn: 1320, pc: 0, kt: 1 }));
  x.pump.closedRel = 0.78; x.powerFail(1000); x.run(T(2027, 6, 1, 10, 20)); x.pump.mode = 'closed'; x.runFor(2 * M);
  check('S66e angelernt: nur die gemessenen Grenzen, kein Bezug je Lauf (78 % liegt über 75 %)', x.dev.output && !logHas(x, /Schutz/), runsInfo(x));
  // f) Überlast im Messfenster (Sand, 2200 W) vergiftet den Nachlauf nicht: Bezug nur nach Unterlast weitergegeben
  const y = learnedWorld(T(2027, 6, 1, 6, 30));
  y.storage.s = JSON.stringify(Object.assign(JSON.parse(y.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }, nl));
  const ym = y.measure.bind(y);
  y.measure = function () { const m = ym(); if (this.pump.mode === 'sand' && this.dev.output) { m.P = 2200 + (this.rand() * 2 - 1) * 25; m.I = m.P / 210; } return m; };
  y.powerFail(1000); y.run(T(2027, 6, 1, 10, 0)); runUntil(y, () => y.dev.output, 5 * M);
  const yt = y.t; y.at(yt + 38e3, () => { y.pump.mode = 'sand'; }); y.runFor(70e3); y.pump.mode = 'normal';
  const yrq = y.state().rq; y.run(T(2027, 6, 1, 12, 40));
  const yr = y.runs();
  check('S66f Überlast im Messfenster: Nachlauf ohne geerbten Bezug, gibt den Rest ohne Fehlauslösung', logHas(y, /Schutz: ueberlast/) &&
    yrq === 0 && yr.length === 2 && yr[1].offSrc === 'timer' && !logHas(y, /Schutz: unterlast/), 'rq ' + yrq + ' · ' + runsInfo(y));
  // g) Leitung füllt sich 50 s lang mit 18 % mehr Leistung: kein Fehlalarm (Bezug erst 10 bis 20 s nach der Anlaufzeit)
  const z = learnedWorld(T(2027, 6, 1, 6, 30));
  z.storage.s = JSON.stringify(Object.assign(JSON.parse(z.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }, nl));
  z.pump.fillS = 50; z.powerFail(1000); z.run(T(2027, 6, 1, 12, 0));
  check('S66g Füllen 50 s: die Gabe läuft ohne Fehlauslösung durch', z.runs().length === 1 && z.runs()[0].offSrc === 'timer' &&
    !logHas(z, /Schutz/), runsInfo(z));
  common(w, 'S66'); common(v, 'S66d'); common(x, 'S66e'); common(y, 'S66f'); common(z, 'S66g');
};

// ------------------------------------------------------------------
scenarios.S64_speicher_gross = function () {
  // größter gespeicherter Zustand: lange Texte mit Umlauten, 14 geschätzte Tage, alle Zahlen lang, Störungsprotokoll voll.
  // Espruino schreibt jedes Byte ab 0x80 als \u00XX: der Emulator zählt so, Grenze 1024 Byte je Eintrag
  const w = learnedWorld(T(2027, 6, 1, 6, 30));
  const xe = [], xw = []; for (let i = 0; i < 14; i++) { xe.push(12.3); xw.push(14.5); }
  w.storage.s = JSON.stringify(Object.assign(JSON.parse(w.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 24.99, pi: 14.99, pn: 1899, pc: 1199,
    kt: 1811833322, pu: 0, rt: 0, rm: 12.3, lr: devStr('31.05. 10:00 Automatik 12,3 mm – abgebrochen'), xa: dayNo(T(2027, 5, 17, 12)), xe, xw,
    xd: 24.9, ob: 14.25, oa: 13.75, rd: 20970, rx: 12.3, rc: 20970, rk: 3, rf: -12.3, cs: 1811923202, fu: 1811838009,
    ft: devStr('Überlast (2100 W > 1716 W) – überlänge überlänge überlänge').slice(0, 60), fo: 1, s0: 20970, sa: 999, sh: 999, sm: 9999.9,
    sf: 999, io: 1811838009, id: 99999, os: 0 }));
  w.powerFail(1000); w.run(T(2027, 6, 1, 9, 59));
  for (let i = 0; i < 6; i++) { w.pump.mode = 'blocked'; w.press(); w.runFor(30e3); w.pump.mode = 'normal'; w.runFor(3 * M); }
  w.runFor(5 * M);
  const f = JSON.parse(w.storage.f || '[]');
  check('S64 größter Zustand und volles Störungsprotokoll: je Eintrag <= 1024 Byte, auch so geschrieben', f.length === 5 &&
    w.maxStore.s <= 1024 && w.maxStore.f <= 1024 && !/Speicher fehlt/.test(w.vcText()), JSON.stringify(w.maxStore) + ' · ' + f.length);
  common(w, 'S64');
  return { speicher: JSON.stringify(w.maxStore) };
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
scenarios.S65_stabil = function () {
  // a) Standort ohne Internet, Eigenwärme nie gelernt, kühle Aprilnächte (Luft 3 bis 19 °C): nach jeder „Frostnacht“ gießt
  //    es, sobald der Fühler 5 °C Luft zeigt (Voreinstellung 15 K), statt den Tag ganz zu sperren
  const wxA = () => ({ et0: 3, rain: 0, prob: 0, tmin: 3, tmax: 19 });
  const a = learnedWorld(T(2027, 4, 8, 12, 0), wxA);
  a.storage.s = JSON.stringify(Object.assign(JSON.parse(a.storage.s), { dp: dayNo(T(2027, 4, 8, 12)), d: 14 }));
  a.internet = false; a.ntp = false; a.powerFail(1000); a.run(T(2027, 4, 14, 13, 0));
  const aRuns = a.runs().filter(r => r.src === 'loopback').length;
  check('S65a offline, Eigenwärme ungelernt, kühle Nächte: gießt trotzdem (mindestens 2 Läufe in 6 Tagen)', aRuns >= 2 &&
    JSON.parse(a.storage.s).d < 14, aRuns + ' Läufe, Konto ' + JSON.parse(a.storage.s).d);
  // b) Eigenwärme lernt nur, wenn der Fühler dem Tag folgt: drinnen (gleichmäßig 21 °C) nichts, draußen schon
  const wxB = () => ({ et0: 3, rain: 0, prob: 0, tmin: 4, tmax: 16 });
  const b1 = learnedWorld(T(2027, 4, 8, 6, 0), wxB); b1.ambientAt = () => 21;
  const b2 = learnedWorld(T(2027, 4, 8, 6, 0), wxB);
  for (const x of [b1, b2]) { x.powerFail(1000); x.run(T(2027, 4, 11, 13, 0)); }
  const s1 = JSON.parse(b1.storage.s), s2 = JSON.parse(b2.storage.s);
  check('S65b Eigenwärme: drinnen nicht gelernt, draußen gelernt', s1.ob < -50 && s1.oa < -50 && s2.ob > 5 && s2.ob < 25,
    'drinnen ' + s1.ob + '/' + s1.oa + ', draußen ' + s2.ob + '/' + s2.oa);
  // c) ohne Netz wirft jeder Wetterabruf sofort: Tagesprüfung und Läufe gehen weiter, der Verbindungstest kommt alle 15 min
  const c = learnedWorld(T(2027, 6, 1, 6, 0));
  c.storage.s = JSON.stringify(Object.assign(JSON.parse(c.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  c.internet = false; c.ntp = false; c.throwAlways = 'HTTP.GET'; c.powerFail(1000); c.run(T(2027, 6, 5, 13, 0));
  const cEv = c.logs.filter(l => /Tagesprüfung/.test(l.msg)).length, cErr = c.logs.filter(l => /Fehler Plan/.test(l.msg)).length;
  check('S65c Wetterabruf wirft dauernd: täglich geprüft und gegossen, höchstens ein Fehler je 15 min', cEv >= 4 && c.runs().length >= 1 &&
    cErr <= 4.3 * 96 * 1.1,
    cEv + ' Prüfungen, ' + c.runs().length + ' Läufe, ' + cErr + ' „Fehler Plan“');
  // d) Speicher schreibt nicht mehr: einmal gemeldet, LED rot, Statuszeile sagt es
  const d = learnedWorld(T(2027, 6, 1, 6, 0));
  d.storage.s = JSON.stringify(Object.assign(JSON.parse(d.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  d.powerFail(1000); d.runFor(2 * H);
  d.dev.ctx.Script.storage.setItem = () => { throw new Error('storage: Wert > 1024 Byte'); };
  const dt0 = d.t; d.runFor(6 * H);
  const dLog = d.logs.filter(l => l.t >= dt0 && /Speicher schreibt nicht/.test(l.msg)).length;
  check('S65d Speicher schreibt nicht: einmal gemeldet, LED rot, Statuszeile nennt es', dLog === 1 && ledOf(d) === '[100,0,0]' &&
    /Speicher schreibt nicht/.test(d.vcText()), dLog + ' Meldungen, LED ' + ledOf(d) + ', ' + d.vcText());
  // e) Fehler beim Skriptstart (Zeitplan-Abfrage wirft): der Takt läuft trotzdem, eine Handgabe wird überwacht
  const e = learnedWorld(T(2027, 6, 1, 14, 0));
  e.storage.s = JSON.stringify(Object.assign(JSON.parse(e.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 4 }));
  e.powerFail(1000); e.runFor(5 * M); e.throwOnce = 'Schedule.List'; e.restartScript(); e.runFor(30e3);
  e.press(); e.runFor(70e3); e.pump.mode = 'dry'; e.runFor(30e3);
  check('S65e Fehler beim Start: Takt läuft, Handgabe überwacht (Trockenlauf erkannt)', !e.crashed && logHas(e, /Fehler Start/) &&
    logHas(e, /Schutz: unterlast/) && !e.dev.output, runsInfo(e));
  // f) Einschalten dauerhaft abgelehnt: die Meldung steht einmal in den letzten Meldungen, nicht sechsmal
  const f = learnedWorld(T(2027, 6, 1, 6, 30));
  f.storage.s = JSON.stringify(Object.assign(JSON.parse(f.storage.s), { dp: dayNo(T(2027, 5, 31, 12)), d: 14 }));
  f.switchRefuse = 1e9; f.powerFail(1000); f.run(T(2027, 6, 1, 12, 40));
  const fi = f.endpoint('info').body.split('Letzte Meldungen')[1] || '';
  check('S65f Einschalten dauerhaft abgelehnt: in den letzten Meldungen höchstens einmal', (fi.match(/Einschalten abgelehnt/g) || []).length <= 1,
    fi.replace(/\n/g, ' | ').slice(0, 300));
  [a, b1, b2, c, d, e, f].forEach((x, n) => common(x, 'S65-' + n));
  return { a: aRuns, b: s1.ob + '/' + s2.ob, c: cEv + '/' + cErr };
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
