'use strict';
/*
 * Baut build/deploy-browser.js: Aufspielwerkzeug und Gerätefassung in einem Stück, zum Einfügen in die
 * Browser-Konsole (oder per Browser-Werkzeug) auf der Weboberfläche des Shelly, http://<ip>/.
 * Gleiche Herkunft, daher kein CORS. Der Ablauf meldet sich in der Konsole; das Ergebnis steht danach
 * in window.__bw ({ fertig, ergebnis | fehler, log }).
 * Aufruf: node tools/browser-snippet.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tool = fs.readFileSync(path.join(root, 'tools', 'deploy.js'), 'utf8');
const code = fs.readFileSync(path.join(root, 'build', 'bewaesserung.min.js'), 'utf8');
if (/[^\x00-\x7F]/.test(code)) throw new Error('Gerätefassung enthält Nicht-ASCII');

const out = [
  '(function () {',
  tool,
  'var CODE = ' + JSON.stringify(code) + ';',
  'window.__bw = { fertig: false, log: [] };',
  'deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })',
  '  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })',
  '  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });',
  'return "Aufspielen gestartet, ' + code.length + ' Byte";',
  '})();',
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'build', 'deploy-browser.js'), out);
console.log('build/deploy-browser.js: ' + out.length + ' Byte (Skript ' + code.length + ' Byte)');
