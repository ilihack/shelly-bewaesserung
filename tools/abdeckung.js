'use strict';
/*
 * Welche Zweige des Skripts haben die Tests durchlaufen? Wertet die Abdeckungsdaten von V8 aus (Blöcke: if/else, ?:,
 * &&, ||, Schleifen, catch) und listet jede Stelle, die kein Test erreicht hat.
 * Aufruf:
 *   NODE_V8_COVERAGE=/tmp/abd node emu/scenarios.js src/bewaesserung.js
 *   NODE_V8_COVERAGE=/tmp/abd node emu/zufall.js src/bewaesserung.js 16 45
 *   NODE_V8_COVERAGE=/tmp/abd node emu/fuzz.js
 *   node tools/abdeckung.js /tmp/abd [src/bewaesserung.js]
 * Der Emulator lädt das Skript unter dem Namen "bewaesserung.js"; gezählt werden nur Welten, deren Quelltext genau die
 * angegebene Datei ist (Szenarien mit abgewandeltem Quelltext, etwa eingetragenen Koordinaten, zählen nicht mit).
 */
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const file = process.argv[3] || path.join(__dirname, '..', 'src', 'bewaesserung.js');
if (!dir) { console.log('Aufruf: node tools/abdeckung.js <NODE_V8_COVERAGE-Ordner> [skript]'); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');
const L = src.length;
const hit = new Uint8Array(L);            // 1 = in mindestens einer Welt ausgeführt
let worlds = 0;
for (const f of fs.readdirSync(dir)) {
  if (!/\.json$/.test(f)) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  for (const s of j.result || []) {
    if (s.url !== 'bewaesserung.js' || !s.functions || !s.functions.length) continue;
    const top = s.functions[0].ranges[0];
    if (top.startOffset !== 0 || top.endOffset !== L) continue;   // andere Fassung des Skripts
    const rs = [];
    for (const fn of s.functions) for (const r of fn.ranges) rs.push(r);
    rs.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);   // außen zuerst, innen überschreibt
    const c = new Uint8Array(L);
    for (const r of rs) c.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    for (let i = 0; i < L; i++) if (c[i]) hit[i] = 1;
    worlds++;
  }
}
// Kommentare und Leerraum zählen nicht mit
const skip = new Uint8Array(L);
for (let i = 0, st = 0; i < L; i++) {
  const ch = src[i], nx = src[i + 1];
  if (st === 0) {
    if (ch === '/' && nx === '/') { st = 1; skip[i] = 1; }
    else if (ch === '/' && nx === '*') { st = 2; skip[i] = 1; }
    else if (ch === '"' || ch === "'") { st = ch; }
    else if (/\s/.test(ch)) skip[i] = 1;
  } else if (st === 1) { skip[i] = 1; if (ch === '\n') st = 0; }
  else if (st === 2) { skip[i] = 1; if (ch === '*' && nx === '/') { skip[i + 1] = 1; i++; st = 0; } }
  else { if (ch === '\\') i++; else if (ch === st) st = 0; }
}
const lineOf = (off) => { let n = 1; for (let i = 0; i < off; i++) if (src.charCodeAt(i) === 10) n++; return n; };
let code = 0, cov = 0;
for (let i = 0; i < L; i++) if (!skip[i]) { code++; if (hit[i]) cov++; }
const runs = [];
for (let i = 0; i < L; i++) {
  if (skip[i] || hit[i]) continue;
  let j = i, last = i;
  while (j < L && (skip[j] || !hit[j])) { if (!skip[j]) last = j; j++; }
  runs.push([i, last + 1]);
  i = j;
}
console.log('Prozesse ausgewertet: ' + worlds + ' (V8 fasst je Prozess alle Welten mit diesem Quelltext zusammen); Code erreicht: ' + (100 * cov / code).toFixed(1) + ' %; nie erreichte Stellen: ' + runs.length);
for (const [a, b] of runs) {
  const t = src.slice(a, b).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  console.log('Zeile ' + lineOf(a) + ': ' + (t.length > 110 ? t.slice(0, 110) + ' …' : t));
}
