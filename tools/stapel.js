'use strict';
/*
 * Prüft, dass das Skript den Stapelspeicher (Stack) des Shelly nicht überläuft.
 *
 * Hintergrund: Der Shelly führt Skripte mit einem abgewandelten Espruino aus. Der liest den Code beim
 * Ausführen und steigt dabei für jeden Funktionsaufruf, jeden Block, jede Schleife und jede Klammer
 * tiefer in den Stapel. Der ist klein: Wird es eng, endet das Skript mit "Too much recursion - the
 * stack is about to overflow"; try/catch fängt das nicht ab.
 *
 * Gemessen am echten Gerät (Outdoor Plug S Gen3, Firmware 2.0.3, 31.10.2026), in Einheiten:
 * 1 Einheit = ein Funktionsaufruf in einem if ohne Block ("function q(n){if(n<N)q(n+1)}").
 *   Platz:  Zeitgeber 15,75 · Rückruf, HTTP-Antwort, Taster, Diagnose-Seite 14,75 · Skriptstart 13
 *   Kosten: Aufruf 0,75 · if 0,25 · Block 0,25 · for 1,5 · for-in 1,5 · while 1 · try 0,5
 *           Klammer 0,5 · Aufruf als Argument 0,75 · && || rechts 0,5 · + rechts 0,5 · ?: 0,25
 *           Zuweisung, return, var 0,25 · Objekt 0,5 · Firmware-Funktion bis 2
 * Die Prüfung rechnet für jeden Einstieg den teuersten Weg und verlangt höchstens ANTEIL des Platzes.
 * Aufruf: node tools/stapel.js [gerätefassung.js] [quelle.js]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const PLATZ = { start: 13, zeitgeber: 15.75, rueckruf: 14.75 };
const ANTEIL = 0.7;                      // Reserve 30 %: Messung in Viertel-Einheiten, Firmware-Updates
const AUFRUF = 0.75;
// Firmware-Funktionen brauchen mehr Stapel als die eingebauten (am Gerät: Shelly.getUptimeMs ließ ihn mit 1 Einheit
// Rest überlaufen und startete den Shelly neu, Math.floor nicht); beides großzügig angesetzt
const NATIV_FW = 2.5, NATIV_JS = 1.5;
const FW = /^(Shelly|Script|Virtual|HTTPServer|Timer|JSON|MQTT|BLE)\.|^print$|\.(getValue|setValue|getStatus|getConfig|on|off|send)$/;
function nativ(n) { return FW.test(n) ? NATIV_FW : NATIV_JS; }

// Kosten für ein Kind je nach Elternknoten und Rolle
function kosten(eltern, rolle, kind) {
  switch (eltern.type) {
    case 'IfStatement': return 0.25;
    case 'BlockStatement': return 0.25;
    case 'ForStatement': case 'ForInStatement': return 1.5;
    case 'WhileStatement': case 'DoWhileStatement': return 1;
    case 'TryStatement': return 0.5;
    case 'CatchClause': return 0.25;
    case 'ReturnStatement': case 'ThrowStatement': case 'VariableDeclaration': return 0.25;
    case 'SwitchStatement': case 'SwitchCase': return 1;
    case 'AssignmentExpression': return rolle === 'right' ? 0.25 : 0.5;
    case 'LogicalExpression': case 'BinaryExpression': return rolle === 'right' ? 0.5 : 0;
    case 'ConditionalExpression': return 0.25;
    case 'ParenthesizedExpression': return 0.5;
    case 'CallExpression': case 'NewExpression': return rolle === 'arguments' ? 0.75 : 0;
    case 'MemberExpression': return rolle === 'property' && eltern.computed ? 0.5 : 0;
    case 'Property': return 0;
    case 'ObjectExpression': case 'ArrayExpression': return 0.5;
    case 'UnaryExpression': case 'UpdateExpression': case 'SequenceExpression': return 0.25;
    default: return 0;
  }
}

function name(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const o = callee.object, p = callee.computed ? '[]' : callee.property.name;
    return (o.type === 'Identifier' ? o.name : o.type === 'MemberExpression' ? name(o) : '…') + '.' + p;
  }
  return '…';
}

function analysiere(code, quellNamen) {
  const ast = acorn.parse(code, { ecmaVersion: 5, preserveParens: true });
  const fns = {}, liste = [];
  for (const st of ast.body) if (st.type === 'FunctionDeclaration') { fns[st.id.name] = st; liste.push(st.id.name); }
  const lesbar = {};
  liste.forEach((n, i) => { lesbar[n] = quellNamen && quellNamen[i] ? quellNamen[i] : n; });
  const stellen = {};                     // Funktion -> [{ ziel | nativ | dyn, k }]
  const einstiege = [];                   // { fn, art, ueber }
  const fehler = [];

  function rueckrufe(call, imFn, lokal) {
    // Funktionen, die als Wert übergeben werden, sind Einstiege; die Art folgt aus dem Empfänger
    const n = lokal.has(name(call.callee)) ? '…' : name(call.callee);
    call.arguments.forEach((a, i) => {
      if (a.type !== 'Identifier' || !fns[a.name] || lokal.has(a.name)) return;
      let art = 'rueckruf', ueber = null;
      if (n === 'Timer.set') art = 'zeitgeber';
      const huelleAn2 = call.arguments[2] && call.arguments[2].type === 'Identifier' && huellen.has(call.arguments[2].name);
      if (n === 'Shelly.call' && i === 3 && huelleAn2) ueber = call.arguments[2].name;
      if (n === 'Shelly.call' && i === 2 && huelleAn2) return;   // Hülle; der eigentliche Rückruf ist Argument 3
      if (fns[n] && n !== a.name) {
        // eigene Funktion, die den Wert weiterreicht (z. B. z(methode, params, rückruf) -> Shelly.call(…, g, rückruf))
        const inner = fns[n];
        let huelle = null;
        (function such(k) {
          if (!k || typeof k.type !== 'string') return;
          if (k.type === 'CallExpression' && name(k.callee) === 'Shelly.call' && k.arguments[2] && k.arguments[2].type === 'Identifier' && fns[k.arguments[2].name]) huelle = k.arguments[2].name;
          for (const key of Object.keys(k)) { const v = k[key]; if (Array.isArray(v)) v.forEach(such); else if (v && typeof v.type === 'string') such(v); }
        })(inner.body);
        ueber = huelle;
      }
      einstiege.push({ fn: a.name, art: art, ueber: ueber, bei: imFn });
    });
  }

  // Hüllen: Funktionen, die einen ihrer Parameter aufrufen (cbSafe ruft den Rückruf, der als userdata kommt)
  const huellen = new Set();
  for (const n of liste) {
    const ps = new Set(fns[n].params.map((p) => p.name));
    (function such(k) {
      if (!k || typeof k.type !== 'string') return;
      if (k.type === 'CallExpression' && k.callee.type === 'Identifier' && ps.has(k.callee.name)) huellen.add(n);
      for (const key of Object.keys(k)) { const v = k[key]; if (Array.isArray(v)) v.forEach(such); else if (v && typeof v.type === 'string') such(v); }
    })(fns[n].body);
  }
  // Namen, die in einer Funktion lokal sind (Parameter, var): verdecken gleichnamige Funktionen
  function lokaleNamen(fn) {
    const set = new Set(fn.params.map((p) => p.name));
    (function such(k) {
      if (!k || typeof k.type !== 'string') return;
      if (k.type === 'VariableDeclarator') set.add(k.id.name);
      for (const key of Object.keys(k)) { const v = k[key]; if (Array.isArray(v)) v.forEach(such); else if (v && typeof v.type === 'string') such(v); }
    })(fn.body);
    return set;
  }
  function lauf(knoten, acc, imFn, lokal) {
    if (!knoten || typeof knoten.type !== 'string') return;
    if (knoten.type === 'FunctionExpression') fehler.push('anonyme Funktion in ' + (imFn ? lesbar[imFn] : 'Programm'));
    if (knoten.type === 'CatchClause' && knoten.param) { lokal = new Set(lokal); lokal.add(knoten.param.name); }
    if (knoten.type === 'CallExpression') {
      const c = knoten.callee;
      const s = { k: acc };
      if (c.type === 'Identifier' && fns[c.name] && !lokal.has(c.name)) s.ziel = c.name;
      else if (c.type === 'Identifier' && imFn && fns[imFn].params.some((p) => p.name === c.name)) s.dyn = c.name;
      else s.nativ = name(c);
      (stellen[imFn || ''] = stellen[imFn || ''] || []).push(s);
      rueckrufe(knoten, imFn, lokal);
    }
    for (const key of Object.keys(knoten)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const v = knoten[key];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === 'string' && lauf(x, acc + kosten(knoten, key, x), imFn, lokal));
      else if (v && typeof v.type === 'string') lauf(v, acc + kosten(knoten, key, v), imFn, lokal);
    }
  }
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration') {
      const lokal = lokaleNamen(st);
      for (const b of st.body.body) lauf(b, 0, st.id.name, lokal);
    } else lauf(st, 0, null, new Set());
  }

  // dynamische Aufrufe (Hülle g ruft ihren vierten Parameter): Ziel sind alle Rückrufe, die über sie laufen
  const ueberHuelle = {};
  for (const e of einstiege) if (e.ueber) (ueberHuelle[e.ueber] = ueberHuelle[e.ueber] || new Set()).add(e.fn);

  const memo = {}, aktiv = {};
  function teuer(fn) {                    // Kosten ab Eintritt in fn: { k, weg }
    if (memo[fn]) return memo[fn];
    if (aktiv[fn]) { fehler.push('Rekursion: ' + lesbar[fn]); return { k: 99, weg: [lesbar[fn] + ' (Rekursion)'] }; }
    aktiv[fn] = true;
    let best = { k: AUFRUF, weg: [lesbar[fn]] };
    for (const s of (stellen[fn] || [])) {
      let r = null;
      if (s.ziel) { const t = teuer(s.ziel); r = { k: AUFRUF + s.k + t.k, weg: [lesbar[fn]].concat(t.weg) }; }
      else if (s.nativ) r = { k: AUFRUF + s.k + nativ(s.nativ), weg: [lesbar[fn], s.nativ] };
      if (r && r.k > best.k) best = r;
    }
    aktiv[fn] = false;
    return (memo[fn] = best);
  }
  function mitHuelle(huelle, ziel) {      // Hülle g + dynamischer Aufruf + Ziel
    const dyn = (stellen[huelle] || []).filter((s) => s.dyn);
    const k = dyn.length ? Math.max.apply(null, dyn.map((s) => s.k)) : 0;
    const t = teuer(ziel);
    return { k: AUFRUF + k + t.k, weg: [lesbar[huelle]].concat(t.weg) };
  }

  const ergebnis = [];
  // Skriptstart: Aufrufe im Programm selbst
  for (const s of (stellen[''] || [])) {
    if (!s.ziel) continue;
    const t = teuer(s.ziel);
    ergebnis.push({ einstieg: 'Skriptstart', art: 'start', k: s.k + t.k, weg: t.weg });
  }
  const gesehen = new Set();
  for (const e of einstiege) {
    const key = e.fn + '|' + e.art + '|' + e.ueber;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    const t = e.ueber ? mitHuelle(e.ueber, e.fn) : teuer(e.fn);
    ergebnis.push({ einstieg: lesbar[e.fn] + (e.ueber ? ' über ' + lesbar[e.ueber] : ''), art: e.art, k: t.k, weg: t.weg });
  }
  for (const r of ergebnis) { r.platz = PLATZ[r.art]; r.anteil = r.k / r.platz; }
  ergebnis.sort((a, b) => b.anteil - a.anteil);
  const proFunktion = liste.map((n) => ({ fn: lesbar[n], k: teuer(n).k, weg: teuer(n).weg })).sort((a, b) => b.k - a.k);
  return { ergebnis, fehler: Array.from(new Set(fehler)), proFunktion };
}

function quellNamen(src) {
  const ast = acorn.parse(src, { ecmaVersion: 5 });
  return ast.body.filter((st) => st.type === 'FunctionDeclaration').map((st) => st.id.name);
}

if (require.main === module) {
  const pos = process.argv.slice(2).filter((a) => !/^--/.test(a));
  const geraet = pos[0] || path.join(__dirname, '..', 'build', 'bewaesserung.min.js');
  const quelle = pos[1] || path.join(__dirname, '..', 'src', 'bewaesserung.js');
  const r = analysiere(fs.readFileSync(geraet, 'utf8'), fs.existsSync(quelle) ? quellNamen(fs.readFileSync(quelle, 'utf8')) : null);
  let schlecht = 0;
  for (const e of r.ergebnis) {
    const ok = e.anteil <= ANTEIL;
    if (!ok) schlecht++;
    if (!ok || process.argv.includes('--alle')) {
      console.log((ok ? '  ok ' : 'ZU TIEF ') + Math.round(e.anteil * 100) + ' % ' + e.einstieg + ' (' + e.art + ', ' + e.k + ' von ' + e.platz + '): ' + e.weg.join(' > '));
    }
  }
  if (process.argv.includes('--funktionen')) for (const f of r.proFunktion.slice(0, 40)) console.log('  ' + f.k + '  ' + f.weg.join(' > '));
  const max = r.ergebnis.length ? r.ergebnis[0] : null;
  console.log('Stapel: tiefster Weg ' + (max ? Math.round(max.anteil * 100) + ' % (' + max.einstieg + ')' : '-') + ', erlaubt ' + Math.round(ANTEIL * 100) + ' %' + (r.fehler.length ? '; FEHLER: ' + r.fehler.join(', ') : ''));
  process.exit(schlecht || r.fehler.length ? 1 : 0);
}
module.exports = { analysiere, quellNamen, PLATZ, ANTEIL };
