'use strict';
/*
 * Zufallstest: das Skript wochenlang mit zufälligen Störungen laufen lassen und Regeln prüfen, die immer gelten müssen.
 * Aufruf: node emu/zufall.js [skript] [anzahl_läufe] [tage]     (Standard: src/bewaesserung.js 10 45)
 * Störungen je Stunde: Stromausfall (1 min bis 14 h), Internet, Zeitserver, Wetterdienst weg, kaputte oder lückenhafte
 * Wetterantworten, Pumpe trocken/Hahn zu/blockiert/Luft/ohne Last/Abschaltung beim Anlauf, Tastendruck, Bedienfeld-Werte, Skript-Neustart
 * und -Absturz (der Wächter startet neu). Wetter zufällig, auch Frost und Starkregen.
 * Regeln: kein Absturz, Grenzen der Firmware, Statustext <= 255 Byte, Speicher gültig und <= 1024 Byte,
 * Konto 0..25 mm, kein Lauf länger als 131 min, ein vom Skript gestarteter oder gesehener Lauf höchstens 120 min, LED höchstens
 * 12 Wechsel in 24 h (je Skriptstart einer mehr); bei richtiger Uhr: Automatik nur 10:00 bis 12:30, nicht bei
 * Automatik aus, Pause oder Winterpause.
 */
const fs = require('fs');
const path = require('path');
const { World, berlinParts, berlinToUnixMs } = require('./shelly-emu');

const FILE = process.argv[2] || path.join(__dirname, '..', 'src', 'bewaesserung.js');
const N = +(process.argv[3] || 10), TAGE = +(process.argv[4] || 45);
const CODE = fs.readFileSync(FILE, 'utf8');
const H = 3600e3, M = 60e3;

function rng(seed) {                      // mulberry32
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function lauf(seed) {
  const r = rng(seed), fehler = [];
  const monat = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11][Math.floor(r() * 10)];
  const start = berlinToUnixMs(2027, monat, 1, 6, 0), ende = start + TAGE * 24 * H;
  const wx = {};
  const weather = (ds) => wx[ds] || (wx[ds] = (() => {
    const kalt = r() < 0.05, nass = r() < 0.25;
    return { et0: 2 + r() * 5, rain: nass ? r() * (r() < 0.1 ? 40 : 12) : 0, prob: Math.floor(r() * 101),
      tmin: kalt ? -6 + r() * 8 : 2 + r() * 16, tmax: 8 + r() * 28 };
  })());
  const w = new World({ code: CODE, start, weather, seed: seed * 7919 + 1 });
  w.storage.s = JSON.stringify({ v: 1, t: Math.floor(start / 1000), d: 10, dp: -1, pi: 0, ev: -1, pn: 1320, ln: 3, pu: 0, fd: -1,
    fc: 0, rt: 0, rm: 0, lr: '', la: 49.48, lo: 8.45, pz: 'DELudwigshafen am Rhein' });
  const orig = w.weatherBody.bind(w);
  w.weatherBody = (url) => {              // kaputte, falsche und lückenhafte Antworten
    const x = r();
    if (x < 0.03) return '{"daily": {"time": [';
    if (x < 0.05) return '{"daily":{"time":["1999-01-01"]}}';
    if (x < 0.10) return orig(url).replace(/\[[0-9.,-]+\]/, (m) => m.replace(/[0-9.-]+/g, 'null'));
    return orig(url);
  };
  w.powerFail(1000);
  const vcHist = [];                      // (Zeit, Automatik, Pause) für die Regelprüfung
  const uhrOk = new Map();                // Zehn-Minuten-Raster: Geräteuhr auf 2 min richtig?
  let pumpeBis = 0;
  for (let t = start; t < ende; t += 10 * M) {
    w.run(t);
    if (w.dev && w.dev.ctx) {
      const u = w.devUnix();
      uhrOk.set(Math.floor(t / (10 * M)), u !== null && Math.abs(u * 1000 - t) < 2 * M);
    }
    const s = w.storage.s;
    if (s) {
      let st = null;
      try { st = JSON.parse(s); } catch (e) { fehler.push('Speicher kein JSON'); }
      if (Buffer.byteLength(s, 'utf8') > 1024) fehler.push('Speicher > 1024 Byte: ' + s.length);
      if (st && (st.d < 0 || st.d > 25 || typeof st.d !== 'number')) fehler.push('Konto außerhalb: ' + st.d);
    }
    if (t >= pumpeBis && w.pump.mode !== 'normal') w.pump.mode = 'normal';
    if (w.dev && w.dev.output && w.pump.mode === 'normal' && r() < 0.05) {   // Störung mitten im Lauf
      w.pump.mode = ['dry', 'closed', 'blocked', 'airmix', 'noload', 'burst'][Math.floor(r() * 6)]; pumpeBis = t + 30 * M;
    }
    if ((t - start) % H !== 0) continue;
    // stündliche Störungen
    if (r() < 0.006) w.powerFail(Math.max(M, Math.floor(r() * r() * 14 * H)));
    if (r() < (w.internet ? 0.01 : 0.12)) w.internet = !w.internet;
    if (r() < (w.ntp ? 0.004 : 0.15)) w.ntp = !w.ntp;
    if (r() < (w.httpFail ? 0.2 : 0.01)) w.httpFail = !w.httpFail;
    if (r() < 0.01) { w.pump.mode = ['dry', 'closed', 'blocked', 'airmix', 'noload', 'anlauf'][Math.floor(r() * 6)]; pumpeBis = t + Math.floor(r() * 6) * H; }
    if (r() < 0.004) w.press();
    const an = !w.vc['boolean:200'] || w.vc['boolean:200'].value;
    if (r() < (an ? 0.001 : 0.05)) w.setVc('boolean:200', !an);
    if (r() < 0.0005) w.setVc('number:201', Math.floor(r() * 4));
    if (r() < 0.001) w.setVc('number:202', Math.round((1 + r() * 39) * 10) / 10);
    if (r() < 0.003 && w.dev) w.restartScript();
    if (r() < 0.001 && w.dev) w.stopScript();
    if (r() < 0.05 && w.dev) w.fireSchedules();
    vcHist.push({ t, au: w.vc['boolean:200'] ? w.vc['boolean:200'].value : true });
  }
  w.run(ende);
  if (w.crashed) fehler.push('Absturz: ' + w.crashed.err.split('\n')[0]);
  if (w.limits.timers > 5 || w.limits.rpc > 5 || w.limits.handlers > 5) fehler.push('Grenzen: ' + JSON.stringify(w.limits));
  if ((w.maxText || 0) > 255) fehler.push('Statustext ' + w.maxText + ' Byte');
  for (const x of w.runs()) if (x.min > 131) fehler.push('Lauf ' + x.min.toFixed(0) + ' min');
  // Jeder Lauf höchstens 120 min: eigene Läufe per Timer; eine Handgabe, wenn das Skript sie beim Einschalten sah. Stand das
  // Skript, übernimmt sie der nächste Skriptstart und kürzt sie auf 120 min ab Beginn, oder schaltet gleich ab, wenn die um sind
  const handAn = w.logs.filter((l) => /Pumpe an \(hand\)/.test(l.msg)).map((l) => l.t);
  const starts0 = w.logs.filter((l) => /gestartet, Bodenkonto/.test(l.msg)).map((l) => l.t);
  for (const x of w.runs()) {
    if (x.src === 'loopback' && x.off && x.min > 120.5) fehler.push('eigener Lauf ' + x.min.toFixed(1) + ' min');
    if (x.src !== 'button' || !x.off) continue;
    const gesehen = handAn.some((t) => Math.abs(t - x.on) <= 2000), st1 = starts0.find((t) => t > x.on + 2000);
    let grenze;
    if (gesehen) grenze = 120.5;
    else if (st1 !== undefined && st1 < x.off) grenze = Math.max(120.5, (st1 - x.on) / M + 0.5);
    else continue;                        // während des ganzen Laufs kein Skript: es bleibt die Notabschaltung (130 min)
    hand++;
    if (x.min > grenze) fehler.push('Handgabe ' + x.min.toFixed(1) + ' min' + (gesehen ? '' : ' (übernommen)'));
  }
  // LED: höchstens 12 Wechsel in 24 h; ein Skriptstart vergisst die Zählung (nur RAM), darf also einen mehr
  const starts = w.logs.filter((l) => /gestartet, Bodenkonto/.test(l.msg)).map((l) => l.t);
  for (let i = 0; i < w.ledWrites.length; i++) {
    const t0 = w.ledWrites[i], n = w.ledWrites.filter((t) => t >= t0 && t < t0 + 24 * H).length;
    const ns = starts.filter((t) => t > t0 && t < t0 + 24 * H).length;
    ledMax = Math.max(ledMax, n);
    if (n > 12 + ns) fehler.push('LED ' + n + ' Wechsel in 24 h bei ' + ns + ' Skriptstarts');
  }
  // Automatikstarts bei richtiger Uhr: nur 10:00 bis 12:30, nicht bei Automatik aus, nicht im Winter
  const au = (t) => { let v = true; for (const h of vcHist) { if (h.t > t) break; v = h.au; } return v; };
  let auto = 0;
  for (const l of w.logs) {
    const m = /Pumpe an \((auto|retry)\)/.exec(l.msg);
    if (!m) continue;
    auto++;
    const k = Math.floor(l.t / (10 * M));
    if (!uhrOk.get(k) || !uhrOk.get(k - 1)) continue;   // Uhr nicht sicher richtig
    const p = berlinParts(l.t), mn = p.hh * 60 + p.mm;
    if (mn < 598 || mn >= 752) fehler.push('Automatik um ' + p.date + ' ' + p.hh + ':' + p.mm);
    if (p.m === 12 || p.m <= 2) fehler.push('Automatik im Winter ' + p.date);
    if (!au(l.t)) fehler.push('Automatik trotz Schalter aus ' + p.date + ' ' + p.hh + ':' + p.mm);
  }
  if (process.env.ZUFALL_LOG) for (const l of w.logs) if (/Tagesprüfung|Pumpe an|Pumpe aus|##|Uhr|Ort|Fehler/.test(l.msg)) console.log(w.fmt(l.t), l.msg);
  for (const l of w.logs) { const m = /Pumpe aus: ([^,]+),/.exec(l.msg); if (m) gruende[m[1]] = (gruende[m[1]] || 0) + 1; }
  return { seed, monat, laeufe: w.runs().length, auto, fehler };
}
const gruende = {};                       // Abschaltgründe über alle Läufe: zeigt, welche Wege der Test berührt hat
let hand = 0, ledMax = 0;                 // geprüfte Handgaben; meiste LED-Wechsel in 24 h

let schlecht = 0, gelaufen = 0;
for (let i = 1; i <= N; i++) {
  if (process.env.ZUFALL_NR && +process.env.ZUFALL_NR !== i) continue;
  gelaufen++;
  const e = lauf(i * 7919);
  const ok = e.fehler.length === 0;
  if (!ok) schlecht++;
  console.log((ok ? '  ok  ' : '  FEHLER ') + 'Lauf ' + i + ' (Start Monat ' + e.monat + ', ' + e.laeufe + ' Läufe, davon ' + e.auto +
    ' automatisch)' + (ok ? '' : ': ' + [...new Set(e.fehler)].slice(0, 6).join(' | ')));
}
console.log('Abschaltgründe: ' + Object.keys(gruende).sort().map((k) => k + ' ' + gruende[k]).join(', '));
console.log('Handgaben geprüft: ' + hand + ', meiste LED-Wechsel in 24 h: ' + ledMax);
console.log(`\n${gelaufen - schlecht} von ${gelaufen} Zufallsläufen ohne Regelverstoß [${path.basename(FILE)}]`);
process.exit(schlecht ? 1 : 0);
