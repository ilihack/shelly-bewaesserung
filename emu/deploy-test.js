'use strict';
/*
 * Prüft tools/deploy.js (Node-Weg) gegen den nachgebauten Shelly (emu/mock-device.js):
 *   a) Gerät mit Firmware 1.7.1, offener Access Point, ohne Passwort, http
 *   b) Gerät wie ab Werk mit Firmware 2.x: http leitet auf https um, Gerätepasswort (Digest SHA-256)
 *   c) falsches Passwort: sauberer Abbruch
 *      dazu: Hochladen bricht einmal ab (zweiter Versuch), zweimal ab (Meldung, Wächter wieder an)
 *   d) Firmware-Update scheitert, nur Access Point: Skript läuft, Ergebnis nicht „FERTIG“, Access Point bleibt an
 *   e) --neues-passwort: ohne und mit altem Passwort; danach gilt nur das neue
 * Aufruf: node emu/deploy-test.js
 */
const fs = require('fs');
const path = require('path');
const { startMock } = require('./mock-device');
const { deployShelly, shellyBasis } = require('../tools/deploy');

const code = fs.readFileSync(path.join(__dirname, '..', 'build', 'bewaesserung.min.js'), 'utf8');
const mock = (opt) => new Promise((res) => startMock(res, opt));

(async () => {
  let ok = true;
  const pruefe = (name, cond, detail) => { console.log((cond ? '  ok   ' : '  FEHLER ') + name + (cond ? '' : ' -- ' + detail)); ok = ok && cond; };

  // a) http, ohne Passwort
  let m = await mock({});
  try {
    const r = await deployShelly('http://127.0.0.1:' + m.port, code, (t) => console.log('    ' + t));
    pruefe('a) Aufspielen ok', r.ok, JSON.stringify(r.schritte));
    pruefe('a) Matter aus, Code vollständig, Bedienfeld 7', !m.state.matter && m.state.putCount === Math.ceil(code.length / 1024) &&
      r.bedienfeld.length === 7 && /Bereit|Heute/.test(r.status || ''), JSON.stringify(m.state));
    pruefe('a) Firmware auf die neueste gebracht', m.state.updates === 1 && m.state.ver === '2.1.0', m.state.ver);
    pruefe('a) Selbsttest im Skript ok', m.state.evals === 2 && m.world.logs.some((l) => /Selbsttest Wetter: ok/.test(l.msg)), '');
    pruefe('a) IP-Ortung vom Gerät geprüft', r.schritte.some((t) => /IP-Ortung vom Gerät: ok Mannheim/.test(t)), JSON.stringify(r.schritte));
    pruefe('a) offener Access Point abgeschaltet', m.state.ap === false, String(m.state.ap));
    pruefe('a) Wächter startet ein angehaltenes Skript', r.waechterPlan && r.waechter && m.state.cron >= 1, JSON.stringify({ plan: r.waechterPlan, w: r.waechter, cron: m.state.cron }));
    const upd = m.world.jobs.filter((j) => j.calls.some((c) => c.method === 'Shelly.Update' && c.params.stage === 'stable'));
    pruefe('a) Firmware-Update automatisch, täglich 03:23', r.updatePlan && upd.length === 1 && upd[0].enable === true &&
      upd[0].timespec === '0 23 3 * * *' && m.world.jobs.length === 2, JSON.stringify(m.world.jobs));
    // erneutes Aufspielen: Wächter wird angehalten, Firmware ist aktuell
    const r2 = await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { ohneWaechter: true });
    pruefe('a) zweites Aufspielen ok, kein weiteres Update', r2.ok && m.state.updates === 1 &&
      r2.schritte.some((t) => /Wächter angehalten/.test(t)), JSON.stringify(r2.schritte));
    // Hochladen bricht einmal ab: zweiter Versuch von vorn
    m.state.putFehler = 1;
    const r3 = await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { ohneWaechter: true });
    pruefe('a) Abbruch beim Hochladen: zweiter Versuch, danach ok', r3.ok && r3.schritte.some((t) => /zweiter Versuch/.test(t)) &&
      m.world.code === code, JSON.stringify(r3.schritte));
    // bricht zweimal ab: klare Meldung, Wächter wieder an
    m.state.putFehler = 2;
    let fehler = '';
    try { await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { ohneWaechter: true }); } catch (e) { fehler = e.message; }
    const wdJobs = m.world.jobs.filter((j) => j.calls.some((c) => c.method.toLowerCase() === 'script.start'));
    pruefe('a) Abbruch zweimal: Meldung, Wächter wieder an', /ohne laufendes neues Skript/.test(fehler) &&
      wdJobs.length === 1 && wdJobs[0].enable === true, fehler + ' ' + JSON.stringify(m.world.jobs));
  } catch (e) { pruefe('a) ohne Abbruch', false, e.stack); }
  m.close();

  // b) https mit Passwort
  m = await mock({ https: true, pass: 'geheim' });
  try {
    const base = await shellyBasis('127.0.0.1:' + m.port);
    pruefe('b) Umleitung auf https erkannt', base === 'https://127.0.0.1:' + m.tlsPort, base);
    const r = await deployShelly(base, code, (t) => console.log('    ' + t), { pass: 'geheim' });
    pruefe('b) Aufspielen mit Passwort über https ok', r.ok && m.state.authFehler === 0, JSON.stringify({ s: r.schritte, f: m.state.authFehler }));
    let fehler = '';
    try { await deployShelly(base, code, () => {}, { pass: 'falsch' }); } catch (e) { fehler = e.message; }
    pruefe('c) falsches Passwort: Abbruch mit Meldung', /Anmeldung abgelehnt/.test(fehler), fehler);
    fehler = '';
    try { await deployShelly(base, code, () => {}); } catch (e) { fehler = e.message; }
    pruefe('c) Passwort fehlt: Abbruch mit Hinweis', /--passwort/.test(fehler), fehler);
  } catch (e) { pruefe('b) ohne Abbruch', false, e.stack); }
  m.close();

  // d) Update scheitert, Shelly nur über seinen Access Point erreichbar: Skript läuft, aber kein „FERTIG“, AP bleibt an
  m = await mock({ updateFehler: true, ohneWlan: true });
  try {
    const r = await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { ohneWaechter: true });
    pruefe('d) Update gescheitert: Warnung, nicht fertig, Skript läuft', !r.ok && !r.firmwareNeu && r.skript.laeuft &&
      r.schritte.some((t) => /WARNUNG: nicht die neueste Firmware/.test(t)), JSON.stringify(r.schritte));
    pruefe('d) ohne Heim-WLAN bleibt der Access Point an', m.state.ap === true &&
      r.schritte.some((t) => /Access Point bleibt an/.test(t)), JSON.stringify(r.schritte));
  } catch (e) { pruefe('d) ohne Abbruch', false, e.stack); }
  m.close();

  // e) neues Gerätepasswort setzen (ohne und mit altem Passwort): danach gilt nur noch das neue
  for (const alt of [null, 'alt-test']) {
    m = await mock(alt ? { pass: alt } : {});
    const tag = 'e' + (alt ? '2' : '1') + ') ';
    try {
      const r = await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { pass: alt || undefined, neuesPasswort: 'neu-test', ohneWaechter: true });
      pruefe(tag + 'Passwort gesetzt und mit ihm angemeldet', r.ok && r.passwortNeu && m.state.setAuth === 1 &&
        r.schritte.some((t) => /Gerätepasswort gesetzt, Anmeldung damit geprüft/.test(t)), JSON.stringify(r.schritte));
      const upd = m.world.jobs.find((j) => j.calls.some((c) => c.method === 'Shelly.Update'));
      if (!alt) upd.enable = false;               // e1: Update in der App abgeschaltet – keine Fehlermeldung, bleibt aus
      const r2 = await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { pass: 'neu-test', ohneWaechter: true });
      pruefe(tag + 'erneutes Aufspielen mit dem neuen Passwort ok', r2.ok, JSON.stringify(r2.schritte));
      if (!alt) pruefe(tag + 'abgeschaltetes Update: gemeldet, kein Fehler, bleibt aus', r2.ok && upd.enable === false &&
        r2.schritte.some((t) => /aus \(in der App abgeschaltet\)/.test(t)), JSON.stringify(r2.schritte));
      let fehler = '';
      try { await deployShelly('http://127.0.0.1:' + m.port, code, () => {}, { pass: alt || 'leer', ohneWaechter: true }); } catch (e) { fehler = e.message; }
      pruefe(tag + 'altes Passwort gilt nicht mehr', /Anmeldung abgelehnt/.test(fehler), fehler);
    } catch (e) { pruefe(tag + 'ohne Abbruch', false, e.stack); }
    m.close();
  }

  console.log(ok ? '\nAUFSPIELEN: bestanden' : '\nAUFSPIELEN: FEHLER');
  process.exit(ok ? 0 : 1);
})();
