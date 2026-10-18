'use strict';
/*
 * Lässt das Skript im Emulator eine ganze Saison mit echtem Wetter laufen (DWD Mannheim, siehe
 * tools/jahr_wetter.py) und schreibt die Gießläufe als JSON.
 * Aufruf: node emu/jahreslauf.js <skript> <jahr> <mit|ohne|offline> <ausgabe.json>
 *   mit  = Regenprognose für heute ist der tatsächliche Regen (bestmögliche Prognose)
 *   ohne = keine Regenprognose (schlechtester Fall)
 *   offline = ab dem 4. März kein Wetterdienst (Uhr per Zeitserver da): Gerätetemperatur und Monatsmittel
 * Mit FROSTFREI=1 liefert das Wetter nie Frost (Tiefstwert mind. 10 °C): zeigt, was die Frostsperre kostet.
 */
const fs = require('fs');
const path = require('path');
const { World, berlinToUnixMs, berlinParts } = require('./shelly-emu');

const [file, jahr, variante, ziel] = process.argv.slice(2);
const CODE = fs.readFileSync(file, 'utf8');
const WX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-out', 'wetter_mannheim.json'), 'utf8'));
const RATE = 8.6;

// Das Skript nimmt Uhrzeiten vor 2026 als ungültig. Darum läuft das Wetter von 2022 bis 2026 im Emulator
// in den Jahren 2027 bis 2031 ab, Tag für Tag gleich (die Saison beginnt erst am 1. März).
const simJahr = 2027 + (+jahr - 2022);
const weather = (ds) => {
  const v = WX[jahr + ds.slice(4)] || {};
  const rain = v.rain == null ? 0 : v.rain;
  const tmin = v.tmin == null ? 10 : v.tmin, tmax = v.tmax == null ? tmin + 10 : v.tmax;
  return { et0: v.et0 == null ? 2 : v.et0, rain, prob: variante === 'mit' ? (rain >= 1 ? 90 : 10) : 0,
    tmin: process.env.FROSTFREI ? Math.max(10, tmin) : tmin, tmax };
};
const start = berlinToUnixMs(simJahr, 3, 1, 0, 0);
const ende = +jahr === 2026 ? berlinToUnixMs(simJahr, 10, 16, 23, 0) : berlinToUnixMs(simJahr, 11, 30, 23, 0);
const w = new World({ code: CODE, start, weather });
if (variante === 'offline') { w.run(start + 3 * 86400e3); w.httpFail = true; }   // nach 3 Tagen kein Wetterdienst mehr
w.run(ende);
const laeufe = w.runs().map((r) => ({ tag: jahr + berlinParts(r.on).date.slice(4), uhr: berlinParts(r.on).hh, min: r.min || 0, mm: (r.min || 0) / 60 * RATE }));
const pruef = w.logs.filter((l) => /Tagesprüfung/.test(l.msg))
  .map((l) => ({ tag: jahr + berlinParts(l.t).date.slice(4), text: l.msg.replace(/^\[BW\] Tagesprüfung: /, '') }));
fs.writeFileSync(ziel, JSON.stringify({ jahr: +jahr, variante, laeufe, pruef, absturz: w.crashed, schreib: w.storageWrites.length,
  led: w.ledWrites.length, tage: (ende - start) / 86400e3 }));
console.log(jahr, variante, laeufe.length, 'Läufe', laeufe.reduce((a, r) => a + r.mm, 0).toFixed(0), 'mm', w.crashed ? 'ABSTURZ' : '');
