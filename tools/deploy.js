'use strict';
/*
 * Spielt das Bewässerungsskript auf den Shelly Outdoor Plug S Gen3 und prüft das Ergebnis.
 * Ein Ablauf, zwei Wege:
 *   Node (ab 18):   node tools/deploy.js <ip-des-shelly> [build/bewaesserung.min.js] [--passwort <pw>]
 *                   [--neues-passwort <pw>] [--ohne-waechtertest]
 *   Browser:        auf der Weboberfläche des Shelly (http(s)://<ip>/) in der Konsole den Inhalt von
 *                   build/deploy-browser.js einfügen (gleiche Herkunft, kein CORS; ohne Gerätepasswort)
 * Schritte: Gerät prüfen -> neueste stabile Firmware -> Matter aus -> Wächter anhalten -> Skript anlegen/ersetzen
 *           -> Autostart an -> starten, Bedienfeld anlegen lassen, Skript neu starten -> Selbsttest -> prüfen:
 *           Skript läuft fehlerfrei, Einschaltzustand aus, Notabschaltung 9600 s, kein Wiedereinschalten,
 *           Bedienfeld vollständig, Statuszeile da, Wetterdienst erreichbar, Speicherreserve >= 2 KB,
 *           Sicherheit (Passwort, Access Point, Bluetooth), Firmware-Update-Zeitplan, Wächter startet ein angehaltenes
 *           Skript neu; auf Wunsch zuletzt das Gerätepasswort setzen (--neues-passwort).
 * Hat der Shelly ein Passwort (Benutzer admin), meldet er sich per Digest mit SHA-256 an (Shelly-Doku,
 * General/Authentication); im Browserweg ist das nicht vorgesehen.
 */
async function deployShelly(base, code, log, opt) {
  log = log || function (t) { (typeof console !== 'undefined') && console.log(t); };
  opt = opt || {};
  const NAME = 'bewaesserung', WD = '0 */5 * * * *';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let auth = null;                                   // Anmeldung: { realm, nonce, nc, legacy, ha1 }
  async function sha256(t) {                         // Node 18 hat crypto noch nicht global, nur als Modul
    const c = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto :
      (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (!(c && c.subtle)) throw new Error('Passwort nur über https oder Node');
    const b = await c.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(b)).map((x) => ('0' + x.toString(16)).slice(-2)).join('');
  }
  async function challenge(h) {                      // 401: Anmeldedaten aus WWW-Authenticate übernehmen
    const realm = /realm="([^"]*)"/.exec(h), nonce = /nonce="?([^",]*)"?/.exec(h);
    if (!opt.pass) throw new Error('Der Shelly hat ein Passwort: node tools/deploy.js <ip> --passwort <passwort>');
    if (!realm || !nonce) throw new Error('Anmeldung: unbekannte Antwort des Geräts');
    auth = { realm: realm[1], nonce: nonce[1], nc: 0, legacy: /^\d+$/.test(nonce[1]),
      ha1: await sha256('admin:' + realm[1] + ':' + opt.pass) };
  }
  async function authFrame() {                       // vor Firmware 2.0: Zahl als nonce, ha2 aus "dummy_method:dummy_uri"
    const nc = ('0000000' + (++auth.nc).toString(16)).slice(-8), cnonce = Math.floor(Math.random() * 1e9);
    const ha2 = await sha256(auth.legacy ? 'dummy_method:dummy_uri' : 'POST:/rpc');
    return { realm: auth.realm, username: 'admin', nonce: auth.legacy ? Number(auth.nonce) : auth.nonce, cnonce: cnonce,
      nc: nc, response: await sha256(auth.ha1 + ':' + auth.nonce + ':' + nc + ':' + cnonce + ':auth:' + ha2), algorithm: 'SHA-256' };
  }
  async function rpc(method, params) {
    for (let k = 0; k < 4; k++) {
      const f = { id: 1, method: method, params: params || {} };
      if (auth) f.auth = await authFrame();
      const r = await fetch(base + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      if (r.status === 401) { await challenge(r.headers.get('www-authenticate') || ''); continue; }   // auch: nonce abgelaufen
      if (r.status === 429) { await sleep(15000); continue; }                                       // Bremse nach Fehlversuchen
      const j = await r.json();
      if (j.error) throw new Error(method + ': ' + j.error.message);
      return j.result;
    }
    throw new Error(method + ': Anmeldung abgelehnt (Passwort falsch?)');
  }
  async function waitVersion(old, maxS) {            // nach dem Update: bis die neue Firmware antwortet
    let last = null;
    for (let i = 0; i < maxS / 5; i++) {
      await sleep(5000);
      try { last = await rpc('Shelly.GetDeviceInfo'); if (last.ver !== old) return last; } catch (e) { /* lädt oder bootet */ }
    }
    if (last) return last;
    throw new Error('Gerät kommt nicht wieder');
  }
  async function waitOnline(maxS) {
    for (let i = 0; i < maxS / 5; i++) {
      await sleep(5000);
      try { return await rpc('Shelly.GetDeviceInfo'); } catch (e) { /* bootet noch */ }
    }
    throw new Error('Gerät kommt nicht wieder');
  }
  const isWd = (j, id) => (j.calls || []).some((c) => String(c.method).toLowerCase() === 'script.start' && c.params && c.params.id === id);
  const verNum = (v) => (v || '0.0.0').split('-')[0].split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
  const out = { schritte: [], firmwareNeu: false };
  const step = (t) => { out.schritte.push(t); log(t); };

  // 1. Gerät (Shelly.GetDeviceInfo braucht kein Passwort)
  if (/[^\x00-\x7F]/.test(code)) throw new Error('Code enthält Nicht-ASCII – bitte die Gerätefassung (build) nehmen');
  let info = await rpc('Shelly.GetDeviceInfo');
  step('Gerät: ' + info.model + ' (' + info.app + '), Firmware ' + info.ver + ', Gen ' + info.gen + (info.auth_en ? ', Passwort an' : ''));
  if (info.model !== 'S3PL-20112EU') step('WARNUNG: kein Outdoor Plug S Gen3 – Modell ' + info.model);
  if (info.auth_en && !opt.pass) throw new Error('Der Shelly hat ein Passwort: node tools/deploy.js <ip> --passwort <passwort>');

  // 2. Firmware: immer die neueste stabile. Mindestens 1.5.0 (Skriptspeicher); 2.0.1 behebt u. a. Messfehler des
  //    Strommesschips (1.7.4) und einen Pufferüberlauf bei gestückelten HTTP-Antworten, wie sie Open-Meteo schickt
  let up = null;
  try { up = await rpc('Shelly.CheckForUpdate'); } catch (e) { step('Update-Prüfung nicht möglich: ' + e.message); }
  if (up && up.stable && up.stable.version) {
    step('Firmware ' + info.ver + ' -> ' + up.stable.version + ' (neueste stabile) wird installiert');
    try {
      await rpc('Shelly.Update', { stage: 'stable' });
      info = await waitVersion(info.ver, 600);
      step('Firmware jetzt ' + info.ver);
    } catch (e) { step('Update nicht möglich: ' + e.message); }
    out.firmwareNeu = info.ver === up.stable.version;
    if (!out.firmwareNeu) step('WARNUNG: nicht die neueste Firmware – Aufspielen später wiederholen');
  } else if (up) { out.firmwareNeu = true; step('Firmware ' + info.ver + ' ist die neueste stabile'); }
  if (verNum(info.ver) < verNum('1.5.0')) throw new Error('Firmware weiterhin < 1.5.0');
  if (verNum(info.ver) < verNum('2.0.1')) step('WARNUNG: Firmware unter 2.0.1 – läuft, aber bitte aktualisieren');

  // 3. Matter aus (Skripte laufen nur ohne Matter)
  try {
    const m = await rpc('Matter.GetConfig');
    if (m && m.enable) {
      const r = await rpc('Matter.SetConfig', { config: { enable: false } });
      step('Matter abgeschaltet');
      if (r && r.restart_required) { await rpc('Shelly.Reboot'); await waitOnline(120); step('Neustart nach Matter'); }
    } else step('Matter ist aus');
  } catch (e) { step('Matter: ' + e.message); }

  // 4. Skript anlegen oder ersetzen; den Wächter vorher anhalten, sonst startet er ein halb geladenes Skript.
  //    Bricht das Hochladen ab, einmal von vorn; klappt auch das nicht, den Wächter wieder an und klar melden.
  const list = (await rpc('Script.List')).scripts || [];
  let s = list.find((x) => x.name === NAME);
  const angehalten = [];
  if (s) {
    for (const j of ((await rpc('Schedule.List')).jobs || [])) {
      if (isWd(j, s.id) && j.enable) { await rpc('Schedule.Update', { id: j.id, enable: false }); angehalten.push(j.id); step('Wächter angehalten'); }
    }
  }
  try {
    if (s && s.running) { await rpc('Script.Stop', { id: s.id }); step('altes Skript gestoppt'); }
    if (!s) { s = { id: (await rpc('Script.Create', { name: NAME })).id }; step('Skriptplatz angelegt: ' + s.id); }
    for (let versuch = 1; ; versuch++) {
      try {
        let len = 0;
        for (let i = 0; i < code.length; i += 1024) {
          len = (await rpc('Script.PutCode', { id: s.id, code: code.slice(i, i + 1024), append: i > 0 })).len;
        }
        if (len !== code.length) throw new Error('unvollständig: ' + len + ' von ' + code.length + ' Byte');
        break;
      } catch (e) {
        if (versuch >= 2) throw e;
        step('Hochladen abgebrochen (' + e.message + '), zweiter Versuch von vorn');
      }
    }
    step('Code hochgeladen: ' + code.length + ' Byte in ' + Math.ceil(code.length / 1024) + ' Stücken');
    await rpc('Script.SetConfig', { id: s.id, config: { enable: true } });
    step('Autostart an');
    // 5. Starten, Bedienfeld anlegen lassen, einmal neu starten (Handles nach dem Anlegen); das Skript stellt
    //    dabei Relais und Wächter selbst ein
    await rpc('Script.Start', { id: s.id });
  } catch (e) {
    for (const id of angehalten) { try { await rpc('Schedule.Update', { id: id, enable: true }); } catch (e2) { /* Gerät weg */ } }
    throw new Error('Gerät ohne laufendes neues Skript – Aufspielen wiederholen (' + e.message + ')');
  }
  await sleep(15000);
  await rpc('Script.Stop', { id: s.id });
  await rpc('Script.Start', { id: s.id });
  await sleep(20000);
  // Speicher unter Last: das Skript holt einmal die größte Wetterantwort (15 Tage) und liest sie
  let selbst = 'nicht gelaufen';
  try {
    await rpc('Script.Eval', { id: s.id, code: 'selfTest()' });
    await sleep(10000);
    selbst = String((await rpc('Script.Eval', { id: s.id, code: 'selfTest()' })).result).replace(/"/g, '');
  } catch (e) { selbst = 'nicht startbar: ' + e.message; }
  out.selbsttest = selbst;
  step('Selbsttest im Skript (Ort, Wetter 15 Tage): ' + selbst);

  // 6. Prüfen
  const st = await rpc('Script.GetStatus', { id: s.id });
  const reserve = (st.mem_used || 0) + (st.mem_free || 0) - (st.mem_peak || 0);   // frei im engsten Moment
  out.skript = { laeuft: st.running, fehler: st.errors || [], speicher: st.mem_used, spitze: st.mem_peak, frei: st.mem_free, reserve: reserve };
  step('Skript läuft: ' + st.running + (st.errors ? ', FEHLER ' + st.errors.join(',') : '') +
       ', Speicher ' + st.mem_used + ' (Spitze ' + st.mem_peak + ', frei ' + st.mem_free + ', Reserve in der Spitze ' + reserve + ')');
  const cfg = await rpc('Switch.GetConfig', { id: 0 });
  out.relais = { start: cfg.initial_state, auto_off: cfg.auto_off, auto_off_s: cfg.auto_off_delay, auto_on: cfg.auto_on, name: cfg.name };
  step('Relais: Einschaltzustand ' + cfg.initial_state + ', Notabschaltung ' + cfg.auto_off + ' nach ' + cfg.auto_off_delay +
       ' s, selbst wieder ein: ' + (cfg.auto_on === true ? 'JA – muss aus sein' : 'nein'));
  const comps = await rpc('Shelly.GetComponents', { dynamic_only: true });
  out.bedienfeld = (comps.components || []).map((c) => c.key);
  const fehlt = ['text:200', 'number:200', 'boolean:200', 'number:201', 'number:202', 'button:200', 'group:200']
    .filter((k) => out.bedienfeld.indexOf(k) < 0);
  step('Bedienfeld: ' + out.bedienfeld.join(', ') + (fehlt.length ? ' – FEHLT: ' + fehlt.join(', ') : ' – vollständig'));
  try { out.status = (await rpc('Text.GetStatus', { id: 200 })).value; step('Status: ' + out.status); } catch (e) { step('Status nicht lesbar: ' + e.message); }
  const sys = await rpc('Sys.GetStatus');
  out.uhr = sys.unixtime ? new Date(sys.unixtime * 1000).toISOString() : null;
  step('Uhr: ' + (out.uhr || 'nicht gestellt (kein Internet?)') +
       (sys.last_sync_ts === undefined ? ' – Firmware meldet keinen Zeitserver-Stand (last_sync_ts)' : ''));
  // Wetterdienst vom Gerät aus erreichbar (TLS, DNS, Format)? Der Ort ist hier egal; den eingestellten prüft der Selbsttest.
  try {
    const r = await rpc('HTTP.GET', { url: 'https://api.open-meteo.com/v1/forecast?latitude=49.48&longitude=8.45' +
      '&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min' +
      '&timezone=Europe%2FBerlin&forecast_days=1&past_days=2', timeout: 20 });
    const d = JSON.parse(r.body).daily;
    out.wetter = d.time.length === 3 ? 'ok ' + d.time[2] + ': ET0 ' + d.et0_fao_evapotranspiration[1] + ' mm gestern' : 'Format falsch';
  } catch (e) { out.wetter = 'FEHLER ' + e.message; }
  step('Wetterdienst vom Gerät: ' + out.wetter);
  if (reserve < 2048) step('WARNUNG: Speicher knapp (Reserve ' + reserve + ' Byte) – bitte melden');

  // 7. Sicherheit: ein offener Access Point wird abgeschaltet, aber nur, wenn der Shelly im Heim-WLAN eine Adresse
  //    hat (sonst wäre er nicht mehr erreichbar); der Rest wird gemeldet (das Passwort setzt du in der App)
  try {
    const wifi = await rpc('WiFi.GetConfig'), ap = wifi.ap || {};
    let staIp = null;
    try { staIp = (await rpc('WiFi.GetStatus')).sta_ip || null; } catch (e) { /* ohne Angabe: nichts abschalten */ }
    if (ap.enable && ap.is_open !== false && staIp) {
      await rpc('WiFi.SetConfig', { config: { ap: { enable: false } } }); ap.enable = false; step('offenen Access Point abgeschaltet');
    } else if (ap.enable && ap.is_open !== false) step('WARNUNG: offener Access Point bleibt an, der Shelly hat noch keine Adresse im Heim-WLAN');
    let ble = {};
    try { ble = await rpc('BLE.GetConfig'); } catch (e) { /* ohne Bluetooth */ }
    out.sicherheit = { passwort: !!info.auth_en, accessPoint: !!ap.enable, bluetoothSteuerung: !!(ble.rpc && ble.rpc.enable) };
    step('Sicherheit: Gerätepasswort ' + (info.auth_en ? 'an' : opt.neuesPasswort ? 'wird zum Schluss gesetzt' :
      'AUS – Empfehlung: --neues-passwort <pw> oder in der App setzen') + ', Access Point ' +
      (ap.enable ? 'an (mit Passwort)' : 'aus') + ', Steuerung über Bluetooth ' + (out.sicherheit.bluetoothSteuerung ? 'an (ab Firmware 2.0 nur gekoppelt)' : 'aus'));
  } catch (e) { step('Sicherheit nicht lesbar: ' + e.message); }

  // 8. Zeitpläne, die das Skript anlegt: Wächter und automatisches Firmware-Update. Danach das Skript anhalten;
  //    der Wächter muss es binnen 5 min neu starten
  const jobs = (await rpc('Schedule.List')).jobs || [];
  const wd = jobs.filter((j) => isWd(j, s.id));
  out.waechterPlan = wd.length === 1 && wd[0].enable === true && wd[0].timespec === WD;
  step('Wächter-Zeitplan: ' + (out.waechterPlan ? 'alle 5 min, aktiv' : 'FEHLT oder falsch: ' + JSON.stringify(wd)));
  const upd = jobs.filter((j) => (j.calls || []).some((c) => String(c.method).toLowerCase() === 'shelly.update'));
  const updAn = upd.filter((j) => j.enable === true);
  out.updatePlan = upd.length > 0;                   // in der App abgeschaltet ist eine Entscheidung, kein Fehler
  step('Firmware automatisch aktualisieren: ' + (updAn.length ? 'an (' + updAn[0].timespec + ')' :
    (upd.length ? 'aus (in der App abgeschaltet)' : 'FEHLT')));
  out.waechter = !!opt.ohneWaechter;
  if (!opt.ohneWaechter && out.waechterPlan && out.uhr) {
    await rpc('Script.Stop', { id: s.id });
    step('Wächtertest: Skript angehalten, warte bis zu 5,5 min');
    const t0 = Date.now();
    for (let i = 0; i < 66 && !out.waechter; i++) { await sleep(5000); out.waechter = (await rpc('Script.GetStatus', { id: s.id })).running; }
    step(out.waechter ? 'Wächter: Skript nach ' + Math.round((Date.now() - t0) / 1000) + ' s wieder gestartet' : 'FEHLER: Wächter startet das Skript nicht');
    if (!out.waechter) await rpc('Script.Start', { id: s.id });
  } else if (!opt.ohneWaechter) step('Wächtertest übersprungen (Zeitplan oder Uhr fehlt)');

  // 9. Gerätepasswort setzen, wenn gewünscht (Benutzer admin; ha1 = SHA256("admin:<Geräte-ID>:<Passwort>") laut
  //    Shelly-Doku). Danach mit dem neuen Passwort anmelden: Erst wenn das klappt, gilt es als gesetzt.
  out.passwortNeu = !opt.neuesPasswort;
  if (opt.neuesPasswort) {
    let fehler = '';
    try {
      await rpc('Shelly.SetAuth', { user: 'admin', realm: info.id, ha1: await sha256('admin:' + info.id + ':' + opt.neuesPasswort) });
    } catch (e) { fehler = e.message; }              // auch ohne Antwort kann es gesetzt sein: unten mit dem neuen prüfen
    opt.pass = opt.neuesPasswort; auth = null;
    for (let i = 0; i < 3 && !out.passwortNeu; i++) {
      try { await rpc('Sys.GetStatus'); out.passwortNeu = true; } catch (e) { fehler = fehler || e.message; await sleep(3000); }
    }
    if (out.passwortNeu && out.sicherheit) out.sicherheit.passwort = true;
    step(out.passwortNeu ? 'Gerätepasswort gesetzt, Anmeldung damit geprüft' :
      'FEHLER: Anmeldung mit dem neuen Passwort klappt nicht (' + fehler + '). Mit --passwort <neues> nochmal aufrufen, dann mit ' +
      '--passwort <altes>; geht beides nicht: Shelly zurücksetzen (Taster 10 s halten) und neu aufspielen');
  }

  out.ok = st.running && !st.errors && cfg.initial_state === 'off' && cfg.auto_off === true &&
    cfg.auto_off_delay === 9600 && cfg.auto_on !== true && fehlt.length === 0 && !!out.status && /^ok/.test(out.wetter) && reserve >= 2048 &&
    /^ok/.test(selbst) && out.waechterPlan && out.waechter && out.firmwareNeu && out.updatePlan && out.passwortNeu;
  step(out.ok ? 'FERTIG – alles in Ordnung' : 'PRÜFEN – siehe oben');
  return out;
}

// Node: ab Firmware 2.0 (ab Werk) leitet der Shelly http auf https um, mit einem Zertifikat aus Shellys eigener CA.
// Das wird im Heimnetz hingenommen (nur für diesen Aufruf).
async function shellyBasis(ip) {
  try {
    const r = await fetch('http://' + ip + '/shelly', { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    if (r.status >= 300 && r.status < 400 && /^https:/.test(loc)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      return new URL(loc).origin;
    }
  } catch (e) { /* nicht erreichbar: der erste Aufruf meldet es */ }
  return 'http://' + ip;
}

if (typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2), opt = {};
  const pw = args.indexOf('--passwort');
  if (pw >= 0) {
    opt.pass = args[pw + 1]; args.splice(pw, 2);
    if (!opt.pass || /^--/.test(opt.pass)) { console.log('--passwort braucht ein Passwort'); process.exit(2); }
  }
  const np = args.indexOf('--neues-passwort');
  if (np >= 0) {
    opt.neuesPasswort = args[np + 1]; args.splice(np, 2);
    if (!opt.neuesPasswort || /^--/.test(opt.neuesPasswort)) { console.log('--neues-passwort braucht ein Passwort'); process.exit(2); }
  }
  const ow = args.indexOf('--ohne-waechtertest');
  if (ow >= 0) { opt.ohneWaechter = true; args.splice(ow, 1); }
  if (!args[0]) {
    console.log('Aufruf: node tools/deploy.js <ip> [gerätefassung.js] [--passwort <pw>] [--neues-passwort <pw>] [--ohne-waechtertest]');
    process.exit(2);
  }
  const file = args[1] || path.join(__dirname, '..', 'build', 'bewaesserung.min.js');
  shellyBasis(args[0])
    .then((base) => deployShelly(base, fs.readFileSync(file, 'utf8'), null, opt))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error('ABBRUCH: ' + e.message); process.exit(1); });
}
if (typeof module !== 'undefined') module.exports = { deployShelly, shellyBasis };
