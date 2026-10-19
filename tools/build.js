'use strict';
/*
 * Baut die Gerätefassung des Skripts:
 *  1. verkleinern (Kommentare und Leerraum weg, lokale Namen kurz) – Shelly-Firmwares hatten
 *     zeitweise ~15 000 Byte Grenze, kleiner Code spart außerdem Arbeitsspeicher
 *  2. Umlaute und andere Nicht-ASCII-Zeichen in Zeichenketten als \xHH (UTF-8-Bytes) schreiben –
 *     die Shelly-Firmware kennt kein \u, und manche Fassungen lehnen Nicht-ASCII beim Hochladen ab
 *  3. prüfen: reines ASCII, nur ES5-Syntax, keine verbotenen Sprachmittel
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

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
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
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code);
  console.log(JSON.stringify({ quelle: src.length, geraet: code.length, funktionsTiefe: maxDepth, fehler: errs }, null, 1));
  if (errs.length) process.exit(1);
})();
