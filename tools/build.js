'use strict';
/*
 * Baut die Gerätefassung des Skripts:
 *  1. verkleinern (Kommentare und Leerraum weg, lokale Namen kurz) – Shelly-Firmwares hatten
 *     zeitweise ~15 000 Byte Grenze, kleiner Code spart außerdem Arbeitsspeicher
 *  2. Umlaute und andere Nicht-ASCII-Zeichen in Zeichenketten als \xHH (UTF-8-Bytes) schreiben –
 *     die Shelly-Firmware kennt kein \u, und manche Fassungen lehnen Nicht-ASCII beim Hochladen ab
 *  3. prüfen: reines ASCII, nur ES5-Syntax, keine verbotenen Sprachmittel
 * Vor 1.: Zahlen und Wahrheitswerte aus Block C an ihren Stellen einsetzen. Jede Eigenschaft eines Objekts belegt am
 * Shelly Arbeitsspeicher (der Code selbst liegt im Flash); C wird nie geändert, das prüft der Bau.
 * Aufruf: node tools/build.js [quelle] [ziel]
 */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const acorn = require('acorn');

const SRC = process.argv[2] || path.join(__dirname, '..', 'src', 'bewaesserung.js');
const OUT = process.argv[3] || path.join(__dirname, '..', 'build', 'bewaesserung.min.js');

function toByteEscapes(code) {
  let out = '';
  for (const ch of code) {
    const cp = ch.codePointAt(0);
    if (cp < 128) { out += ch; continue; }
    for (const b of Buffer.from(ch, 'utf8')) out += '\\x' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Namen der Einstellwerte (Block C) für die Gerätefassung kürzen: spart Code und Arbeitsspeicher
// (Shelly: Namen ab 5 Zeichen kosten doppelt). Nur genau diese Namen, damit keine Firmware-Eigenschaft leidet.
function cKeys(src) {
  const ast = acorn.parse(src, { ecmaVersion: 5 });
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.id.name === 'C' && d.init && d.init.type === 'ObjectExpression') return d.init.properties.map((p) => p.key.name || p.key.value);
    }
  }
  throw new Error('Block C nicht gefunden');
}

// Zahlen und Wahrheitswerte aus Block C einsetzen; C muss dafür nur gelesen werden (keine Zuweisung, kein C[x])
function cInline(src) {
  const ast = acorn.parse(src, { ecmaVersion: 5, ranges: true });
  let cObj = null;
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) if (d.id.name === 'C' && d.init && d.init.type === 'ObjectExpression') cObj = d.init;
  }
  if (!cObj) throw new Error('Block C nicht gefunden');
  const vals = {}, keep = [], reps = [];
  for (const p of cObj.properties) {
    const k = p.key.name || p.key.value, v = p.value;
    if (v.type === 'Literal' && (typeof v.value === 'number' || typeof v.value === 'boolean')) vals[k] = v.raw;
    else if (v.type === 'UnaryExpression' && v.operator === '-' && v.argument.type === 'Literal' && typeof v.argument.value === 'number') vals[k] = '(-' + v.argument.raw + ')';
    else keep.push(src.slice(p.range[0], p.range[1]));
  }
  (function walk(n, parent, role) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier' && n.name === 'C' && n !== cObj && !(parent && parent.type === 'VariableDeclarator' && role === 'id')) {
      const ok = parent && parent.type === 'MemberExpression' && role === 'object' && !parent.computed;
      if (!ok) throw new Error('C anders als lesend benutzt (Zeichen ' + n.range[0] + ')');
    }
    if ((n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.name === 'C') ||
        (n.type === 'UpdateExpression' && n.argument.type === 'MemberExpression' && n.argument.object.name === 'C')) {
      throw new Error('C wird geändert (Zeichen ' + n.range[0] + ')');
    }
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'C') {
      if (vals[n.property.name] !== undefined) reps.push([n.range[0], n.range[1], vals[n.property.name]]);
      else if (!keep.some((k) => k.indexOf(n.property.name + ':') === 0)) throw new Error('C.' + n.property.name + ' fehlt');
    }
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) v.forEach((x) => walk(x, n, key)); else if (v && typeof v.type === 'string') walk(v, n, key);
    }
  })(ast, null, null);
  reps.push([cObj.range[0], cObj.range[1], '{' + keep.join(', ') + '}']);
  reps.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [a, b, r] of reps) out = out.slice(0, a) + r + out.slice(b);
  return { code: out, n: Object.keys(vals).length };
}

(async () => {
  const src0 = fs.readFileSync(SRC, 'utf8');
  const inl = cInline(src0), src = inl.code;
  // dazu lange Namen im Laufzeitzustand R, die nirgends sonst (Firmware, Speicher, Textschlüssel) vorkommen
  const keys = cKeys(src).concat(['lastStop', 'fault', 'noStore', 'paShown', 'lastTxt', 'lastD', 'noteU', 'defAt',
    'pbNext', 'ledWant', 'ledSince', 'tries', 'until']);
  const res = await minify(src, {
    ecma: 5,
    toplevel: true,
    compress: false,                      // keine Umformungen: Inlining erzeugt tiefe anonyme Funktionen
    mangle: { toplevel: true, reserved: ['selfTest', 'info'],   // ruft das Aufspielwerkzeug per Script.Eval
      properties: { regex: new RegExp('^(' + keys.join('|') + ')$') } },
    format: { ascii_only: false, comments: false, beautify: false, semicolons: true }
  });
  let code = toByteEscapes(res.code);
  // Prüfungen
  const errs = [];
  if (/[^\x00-\x7F]/.test(code)) errs.push('Nicht-ASCII übrig');
  if (/\\u[0-9a-fA-F]{4}/.test(code)) errs.push('\\u-Escape gefunden');
  try { acorn.parse(code, { ecmaVersion: 5 }); } catch (e) { errs.push('kein ES5: ' + e.message); }
  if (/=>|`|\bconst\b|\bclass\b|\blet\b/.test(code)) errs.push('verbotenes Sprachmittel');
  // Verschachtelungstiefe anonymer Funktionen (Firmware verträgt nur 2-3 Ebenen)
  let depth = 0, maxDepth = 0;
  acorn.full ? null : null;
  const ast = acorn.parse(code, { ecmaVersion: 5 });
  (function walk(node, d) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration';
    const nd = isFn ? d + 1 : d;
    if (nd > maxDepth) maxDepth = nd;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => walk(x, nd)); else if (v && typeof v.type === 'string') walk(v, nd);
    }
  })(ast, 0);
  if (maxDepth > 2) errs.push('Funktionen ' + maxDepth + ' Ebenen tief');
  // Stapelspeicher: der teuerste Weg je Einstieg höchstens ANTEIL des am Gerät gemessenen Platzes (tools/stapel.js)
  const stapel = require('./stapel');
  const st = stapel.analysiere(code, stapel.quellNamen(src));
  const tief = st.ergebnis[0];
  for (const e of st.ergebnis) if (e.anteil > stapel.ANTEIL) errs.push('Stapel ' + Math.round(e.anteil * 100) + ' % ' + e.einstieg + ': ' + e.weg.join(' > '));
  for (const f of st.fehler) errs.push('Stapel: ' + f);
  // Eingebaute Methoden nur, wenn am Gerät nachgewiesen: Der Shelly hat ein abgespecktes Espruino. Was fehlt, fällt
  // erst beim Aufruf auf und hält das Skript an (so geschehen mit Array.shift: "Function "shift" not found!").
  // Am Gerät geprüft (Firmware 2.0.3): alle hier eingetragenen da; shift und unshift fehlen. Neue Methode: erst am Gerät
  // per Script.Eval mit typeof prüfen, dann hier eintragen.
  const AM_GERAET = new Set(['floor', 'round', 'abs', 'min', 'max', 'cos', 'sin', 'tan', 'acos',   // Math
    'parse', 'stringify', 'push', 'join', 'charAt', 'charCodeAt', 'slice', 'indexOf', 'lastIndexOf', 'replace', 'toLowerCase',
    'call', 'getUptimeMs', 'getComponentStatus', 'getComponentConfig', 'getDeviceInfo', 'addStatusHandler',   // Shelly
    'removeStatusHandler',
    'getItem', 'setItem', 'set', 'getHandle', 'getValue', 'setValue', 'getStatus', 'on', 'off', 'registerEndpoint', 'send']);
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    const c = node.callee;
    if (node.type === 'CallExpression' && c.type === 'MemberExpression' && !c.computed && !AM_GERAET.has(c.property.name))
      errs.push('Methode ' + c.property.name + '() am Gerät nicht nachgewiesen (Zeile ' + node.loc.start.line + ')');
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
    }
  })(acorn.parse(src, { ecmaVersion: 5, locations: true }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code);
  console.log(JSON.stringify({ quelle: src0.length, geraet: code.length, eingesetzt: inl.n, funktionsTiefe: maxDepth,
    stapel: tief ? Math.round(tief.anteil * 100) + ' % (' + tief.einstieg + ')' : '-', fehler: errs }, null, 1));
  if (errs.length) process.exit(1);
})();
