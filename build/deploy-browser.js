(function () {
'use strict';
/*
 * Spielt das Bewässerungsskript auf den Shelly Outdoor Plug S Gen3 und prüft das Ergebnis.
 * Ein Ablauf, zwei Wege:
 *   Node (ab 18):   node tools/deploy.js <ip-des-shelly> [build/bewaesserung.min.js] [--passwort <pw>]
 *                   [--neues-passwort <pw>] [--ohne-waechtertest]
 *   Browser:        auf der Weboberfläche des Shelly (http(s)://<ip>/) in der Konsole den Inhalt von
 *                   build/deploy-browser.js einfügen (gleiche Herkunft, kein CORS; ohne Gerätepasswort)
 * Schritte: Gerät prüfen -> neueste stabile Firmware -> Matter aus -> Wächter anhalten -> Skript anlegen/ersetzen
 *           -> Autostart an -> starten, Bedienfeld anlegen lassen, Skript neu starten -> Selbsttest und Diagnose-Seite
 *           (Speicher unter Last) -> prüfen:
 *           Skript läuft fehlerfrei, Einschaltzustand aus, Notabschaltung 9600 s, kein Wiedereinschalten,
 *           Bedienfeld vollständig, Statuszeile da, Wetterdienst erreichbar, Speicherreserve >= 2 KB, Diagnose-Seite,
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
  async function start(id) {                         // scheitert der Start, die Meldung des Skripts zeigen (etwa Stapel)
    try { await rpc('Script.Start', { id: id }); }
    catch (e) {
      let m = '';
      try { const st = await rpc('Script.GetStatus', { id: id }); m = String(st.error_msg || (st.errors || []).join(',')).split('\n')[0]; }
      catch (e2) { /* Gerät weg */ }
      throw new Error(e.message + (m ? ' – ' + m : ''));
    }
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
    await start(s.id);
  } catch (e) {
    for (const id of angehalten) { try { await rpc('Schedule.Update', { id: id, enable: true }); } catch (e2) { /* Gerät weg */ } }
    throw new Error('Gerät ohne laufendes neues Skript – Aufspielen wiederholen (' + e.message + ')');
  }
  await sleep(15000);
  await rpc('Script.Stop', { id: s.id });
  await start(s.id);                                 // zweiter Start: Bedienfeld schon da (so wie nach jedem Stromausfall)
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
  // Diagnose-Seite einmal aufbauen lassen (dieselbe Seite wie im Browser), damit ihr Speicherbedarf in der Spitze steckt
  try { out.diagnose = String((await rpc('Script.Eval', { id: s.id, code: 'info()' })).result); }
  catch (e) { out.diagnose = 'nicht lesbar: ' + e.message; }

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
  step('Diagnose-Seite: ' + (base || (typeof location !== 'undefined' ? location.origin : '')) + '/script/' + s.id + '/info' +
       (opt.pass || opt.neuesPasswort ? ' (Anmeldung: admin und Gerätepasswort)' : ''));
  log(out.diagnose.split('\n').map((l) => '    | ' + l).join('\n'));
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

var CODE = "var e={l:\"Ludwigshafen am Rhein\",p:\"DE\",S:null,_:null,M:1,T:600,A:750,N:3,R:11,O:8.6,F:.85,P:8,I:5,D:15,U:25,W:6,C:90,H:60,B:1,G:5,J:5,V:5,K:1.1,Z:900,X:1900,Y:600,j:2100,$:10.5,ee:150,te:9600,ne:10,fe:.75,ue:1.3,le:.3,ae:50,oe:40,se:8,he:5,me:5,pe:2,Se:120,ge:60,ye:6,be:2,ve:15,de:10,_e:.06,Me:5400,Te:3600,we:600,Ae:21600,Ne:48,ke:30,Ee:3600,Re:1767225600};var t=[.6,.9,1.6,2.6,3.5,4.5,4.4,3.8,2.4,1.1,.5,.5];var n=[6.1,9.3,13,17,21.1,26.3,27.4,27.4,22.8,16.7,9.6,6.8];var r={ok:[0,100,0],warn:[100,70,0],err:[100,0,100],run:[0,0,100]};var i=null;var f={k:0,u:0,sw:{output:false,apower:0,tC:null},ra:0,au:true,oq:\"\",eb:0,eu:0,est:false,run:null,ps:null,want:null,starts:[],Oe:0,wc:0,weld:false,wx:{busy:false,next:0,ze:0,L:null,n:0,rc:false,t:0,q:0,cg:0},off:false,oa:0,ie:false,sv:-1e9,sd:false,wn:0,w24:0,cn:0,c24:0,why:\"\",note:\"\",Fe:0,Le:false,h:null,Pe:-1,Ie:\"\",De:-1,boot:true,def:false,Ue:0,We:0,cfgAt:0,sn:0,cg:0,hb:0,hn:0,hr:0,hl:0,led:\"\",Ce:\"\",He:0,ledN:[],td:null,ty:null,ts:-1e9,z:null,zf:-1e9,zl:0,zn:0,cp:0,co:0,rh:0,nf:false,la:null,lo:null,gn:0,gx:false,st:\"\",lg:[],li:0,t0:0,s0:0,nw:0,nc:0,nl:0};function u(){return Shelly.getUptimeMs()/1e3}function l(e){return Math.round(e)}function a(e){return Math.round(e*10)/10}function o(e){return Math.round(e*100)/100}function s(e){var t=Math.round(e*10)/10;return String(t).replace(\".\",\",\")}function c(e,t,n){return e<t?t:e>n?n:e}function h(e){return(e<10?\"0\":\"\")+e}function m(e){var t=f.u>1e9?Math.floor(f.u):0;e=String(e);print(\"[BW] \"+e);t=(t?String(t):\"0000000000\")+(f.est?\"~\":\" \")+e.slice(0,80);if(f.lg.length<10)f.lg.push(t);else f.lg[f.li]=t;f.li=(f.li+1)%10}function p(){return Shelly.getComponentStatus(\"switch\",0)||{}}function S(e){var t=e.temperature;f.sw.output=!!e.output;f.sw.apower=e.apower||0;f.sw.tC=t&&typeof t.tC===\"number\"?t.tC:null}function g(e,t,n){if(t)m(\"RPC-Fehler \"+t+\" \"+n)}function y(e,t,n,r){try{r(e,t,n)}catch(e){m(\"Fehler im R\\xC3\\xBCckruf: \"+e)}}function b(e,t,n){e-=t<=2?1:0;var r=e/400|0,i=e-r*400;var f=((153*(t+(t>2?-3:9))+2)/5|0)+n-1;var u=i*365+(i/4|0)-(i/100|0)+f;return r*146097+u-719468}function v(e){e+=719468;var t=e/146097|0,n=e-t*146097;var r=(n-(n/1460|0)+(n/36524|0)-(n/146096|0))/365|0;var i=n-(365*r+(r/4|0)-(r/100|0));var f=(5*i+2)/153|0;var u=f<10?f+3:f-9;return{y:r+t*400+(u<=2?1:0),m:u,d:i-((153*f+2)/5|0)+1}}function d(t){var n=1970+(t/31556952|0),r=b(n,4,1)-1,i=b(n,11,1)-1;r=(r-(r+4)%7)*86400+3600;i=(i-(i+4)%7)*86400+3600;return(e.M+(t>=r&&t<i?1:0))*3600}function _(e){var t=e+d(e),n=t/86400|0,r=v(n);return{day:n,min:(t-n*86400)/60|0,y:r.y,m:r.m,d:r.d}}function M(e){return e.y+\"-\"+h(e.m)+\"-\"+h(e.d)}function T(e){return h(e/60|0)+\":\"+h(e%60)}function w(e){var t=v(e);return h(t.d)+\".\"+h(t.m)+\".\"}function A(t){var n=v(t),r=b(n.y,1,1),i=2*Math.PI/365*(t-r);var u=Math.cos(i),l=Math.sin(i),a=Math.cos(2*i),o=Math.sin(2*i);var s=229.18*(75e-6+.001868*u-.032077*l-.014615*a-.040849*o);var c=.006918-.399912*u+.070257*l-.006758*a+907e-6*o;var h=(f.la===null?50:f.la)*Math.PI/180;var m=Math.cos(h),p=Math.cos(c),S=Math.tan(h),g=Math.tan(c),y=Math.cos(1.58534);var d=Math.acos(y/(m*p)-S*g);return 720-4*((f.lo===null?15*e.M:f.lo)+d*180/Math.PI)-s}function N(){var t=Shelly.getComponentStatus(\"sys\"),n=Shelly.getUptimeMs();if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Re)return t.unixtime;return f.eb?f.eb+n/1e3-f.eu:null}function k(){var e=Shelly.getComponentStatus(\"sys\");return!!e&&typeof e.last_sync_ts===\"number\"&&Math.abs(e.last_sync_ts-i.cs)>5}function E(){var t=null;try{t=JSON.parse(Script.storage.getItem(\"s\"))}catch(e){t=null}if(!t||t.v!==1)t={v:1};if(typeof t.t!==\"number\")t.t=0;if(typeof t.d!==\"number\"||!(t.d>=0&&t.d<=e.U))t.d=0;if(typeof t.dp!==\"number\")t.dp=-1;if(typeof t.pi!==\"number\"||!(t.pi>=0))t.pi=0;if(typeof t.ev!==\"number\")t.ev=-1;if(typeof t.pn!==\"number\")t.pn=0;if(typeof t.ln!==\"number\")t.ln=0;if(typeof t.pu!==\"number\")t.pu=0;if(typeof t.fd!==\"number\")t.fd=-1;if(typeof t.fc!==\"number\")t.fc=0;if(typeof t.rt!==\"number\")t.rt=0;if(typeof t.rm!==\"number\")t.rm=0;if(typeof t.lr!==\"string\")t.lr=\"\";if(typeof t.xa!==\"number\")t.xa=-1;if(!t.xe||typeof t.xe.length!==\"number\")t.xe=[];if(!t.xw||typeof t.xw.length!==\"number\"||t.xw.length!==t.xe.length){t.xw=[];t.xe=[];t.xa=-1}if(typeof t.xd!==\"number\")t.xd=0;if(typeof t.ob!==\"number\")t.ob=-99;if(typeof t.oa!==\"number\")t.oa=-99;if(typeof t.df!==\"number\")t.df=0;if(typeof t.rd!==\"number\")t.rd=-1;if(typeof t.rx!==\"number\")t.rx=0;if(typeof t.rc!==\"number\")t.rc=-1;if(typeof t.rk!==\"number\")t.rk=0;if(typeof t.rf!==\"number\")t.rf=0;if(typeof t.tu!==\"number\")t.tu=0;if(typeof t.ce!==\"number\")t.ce=0;if(typeof t.cs!==\"number\")t.cs=0;if(typeof t.fu!==\"number\")t.fu=0;if(typeof t.ft!==\"string\")t.ft=\"\";if(typeof t.fo!==\"number\")t.fo=t.fu?1:0;if(typeof t.s0!==\"number\")t.s0=0;if(typeof t.sa!==\"number\")t.sa=0;if(typeof t.sh!==\"number\")t.sh=0;if(typeof t.sm!==\"number\")t.sm=0;if(typeof t.sf!==\"number\")t.sf=0;if(typeof t.io!==\"number\")t.io=0;if(typeof t.id!==\"number\")t.id=0;if(typeof t.os!==\"number\")t.os=0;if(typeof t.wu!==\"number\")t.wu=0;if(typeof t.wn!==\"number\")t.wn=0;if(typeof t.wb!==\"number\")t.wb=0;if(t.pz!==e.p+e.l||typeof t.la!==\"number\"||typeof t.lo!==\"number\"){t.la=null;t.lo=null;t.pz=\"\"}i=t}function R(){f.sd=true}function O(){var t=u(),n;if(!f.sd)return;if(t-f.w24>=86400){f.w24=t;f.wn=0}if(t-f.sv<(f.wn>=e.Ne?3600:60))return;n=N();if(n){i.t=Math.floor(n);i.tu=Math.floor(t)}i.d=o(i.d);i.pi=o(i.pi);i.wu=Math.floor(t);i.wn=f.wn+1;i.wb=Math.floor(f.w24);try{Script.storage.setItem(\"s\",JSON.stringify(i));f.Le=false;f.sd=false;f.nw++}catch(e){f.Le=true}f.sv=t;f.wn++}function z(t,n,r){var i=Shelly.getUptimeMs()/1e3;if(i-f.c24>=86400){f.c24=i;f.cn=0}if(f.cn===e.ke)m(\"Schreibbremse Einstellungen: \"+t);if(f.cn>=e.ke){f.cn++;return false}Shelly.call(t,n,y,r);f.cn++;f.nc++;return true}var F=[[\"text\",200,\"st\"],[\"number\",200,\"bk\"],[\"boolean\",200,\"au\"],[\"number\",201,\"pa\"],[\"number\",202,\"ra\"],[\"button\",200,\"re\"]];function L(t){if(t===0)return{name:\"Status\",default_value:\"\",persisted:false,max_len:255,meta:{ui:{view:\"label\"}}};if(t===1)return{name:\"Wasserdefizit\",default_value:0,persisted:false,min:0,max:25,meta:{ui:{view:\"progressbar\",unit:\"mm\",step:.1}}};if(t===2)return{name:\"Automatik\",default_value:true,persisted:true,meta:{ui:{view:\"toggle\",titles:[\"Aus\",\"An\"]}}};if(t===3)return{name:\"Pause\",default_value:0,persisted:false,min:0,max:14,meta:{ui:{view:\"field\",unit:\"Tage\",step:1}}};if(t===4)return{name:\"Regenrate\",default_value:e.O,persisted:true,min:1,max:40,meta:{ui:{view:\"field\",unit:\"mm/h\",step:.1}}};return{name:\"Pumpe neu einlernen\",meta:{ui:{view:\"button\"}}}}var P=0;function I(){var e;while(P<F.length&&Shelly.getComponentConfig(F[P][0],F[P][1]))P++;if(P<F.length){e=L(P);z(\"Virtual.Add\",{type:F[P][0],id:F[P][1],config:e},U);return}if(!Shelly.getComponentConfig(\"group\",200)){z(\"Virtual.Add\",{type:\"group\",id:200,config:{name:\"Bew\\xC3\\xA4sserung\",meta:{ui:{view:\"group\"}}}},W);return}C();H()}function D(){f.hb=u();f.hn++;P=0;I()}function U(e,t,n){if(t)m(\"Bedienfeld \"+F[P][2]+\": \"+n);P++;I()}function W(e,t,n){C();H()}function C(){var e=[],t,n=Shelly.getComponentStatus(\"group\",200),r,i;for(t=0;t<F.length;t++)e.push(F[t][0]+\":\"+F[t][1]);r=n?JSON.stringify(n.value):\"\";i=JSON.stringify(e);if(r!==i)z(\"Group.Set\",{id:200,value:e},g)}function H(){var e={},t,n=true;if(f.h)return;try{t=0;while(t<F.length){e[F[t][2]]=Virtual.getHandle(F[t][0]+\":\"+F[t][1]);if(!e[F[t][2]])n=false;t++}if(n)f.hr=e.re.on(\"single_push\",x)}catch(e){n=false}if(!n){if(f.hn===1)m(\"Bedienfeld unvollst\\xC3\\xA4ndig \\xE2\\x80\\x93 ohne Anzeige weiter\");return}f.h=e;J();if(f.hn>1)m(\"Bedienfeld verbunden\")}function x(e){try{i.pn=0;i.ln=0;R();me(\"Pumpe wird beim n\\xC3\\xA4chsten Lauf neu eingelernt\")}catch(e){m(\"Fehler Taster: \"+e)}}function B(){return f.ra>0?f.ra:e.O}function G(){return f.au}function J(){var e=f.h?f.h.ra.getValue():null;f.ra=typeof e===\"number\"&&e>=1&&e<=40?e:0;f.au=!f.h||f.h.au.getValue()!==false}function V(e){return i.pu&&e.day<=i.pu}function K(e){return t[e-1]}function Z(t){var n=e.N,r=e.R;return n<=r?t.m>=n&&t.m<=r:t.m>=n||t.m<=r}function X(n){var r=i.dp<0?0:c(n.day-1-i.dp,0,14),f=c(i.d-i.pi,0,e.U);return c(f+r*t[n.m-1]*e.F,0,e.U)}function Y(t){var n=B(),r=Math.round(t/n*3600),i=e.ee*60;return r<i?r:i}function q(t){var n=t?i.oa:i.ob;return n>-50?n:t?e.de:e.ve}function j(r){var i=v(r).m,u=f.ty,l=1,a;if(u&&u.d===r&&u.n>=100){a=q(1);l=c(1+e._e*(u.mx-a-n[i-1]),.5,1.6)}return t[i-1]*l*e.K}function Q(){var t=[],n=[],r;i.xd=c(i.xd-i.xw[0],0,e.U)+i.xe[0];for(r=1;r<i.xe.length;r++){t.push(i.xe[r]);n.push(i.xw[r])}i.xe=t;i.xw=n;i.xa++}function $(t){var n,r,f,u=i.pi;if(i.xa<0&&i.dp+1<t.day){i.xd=i.d;i.xe=[];i.xw=[]}i.d=c(i.d-i.pi,0,e.U);i.pi=0;for(n=i.dp+1;n<t.day;n++){r=i.d;f=j(n);f=a(f*e.F);i.d=c(i.d+f,0,e.U);if(i.xa<0)i.xa=n;f=a(i.d-r);i.xe.push(f);f=a(u);i.xw.push(f);u=0}while(i.xe.length>14)Q();i.dp=t.day-1}function ee(e,t){var n,r,i,u;if(t-f.ts<600)return;f.ts=t;n=f.sw;if(n.output||f.run||t-f.Oe<1800||n.tC===null)return;i=n.tC;u=f.td;if(!u||u.d!==e.day){f.ty=u&&u.d===e.day-1?u:null;u=f.td={d:e.day,n:0,mn:i,mx:i}}u.n++;if(f.est)u.x=1;if(i<u.mn)u.mn=i;if(i>u.mx)u.mx=i;if(f.est)ie(i,t);else f.z=null}function te(e,t,n){var r=f.ty;var u,l;if(!r||r.x||r.d!==e.day-1||r.n<100||t===null||n===null)return;u=r.mn-t;l=r.mx-n;if(u>-5&&u<50)i.ob=i.ob>-50?a(i.ob+(u-i.ob)*.3):a(u);if(l>-5&&l<50)i.oa=i.oa>-50?a(i.oa+(l-i.oa)*.3):a(l)}function ne(){var e=f.td,t=null;if(e&&e.n)t=e.mn;else if(f.sw.tC!==null)t=f.sw.tC;if(t===null)return null;return t-q(0)-(e&&e.n>=36?0:5)}function re(){var e=f.sw,t=Shelly.getUptimeMs()/1e3,n,r;if(i.oa<-50||e.output||f.run||t-f.Oe<1800||e.tC===null)return null;n=q(0);r=q(1);return e.tC-Math.max(n,r)}function ie(e,t){var n=f.z;if(!n){f.z={s:-1,v:e,t:t,mv:e,mt:t,e:null};return}if(n.e&&t-n.e.t>10800)n.e=null;if(n.e&&e>=n.e.v+5){fe(n.e.t);n.e=null}if(n.s<0){if(e<n.v){n.v=e;n.t=t}else if(e>n.v+3){if(n.mv-n.v>=6&&n.t-n.mt>=21600)n.e={t:n.t,v:n.v};n.s=1;n.v=e;n.t=t}}else if(e>n.v){n.v=e;n.t=t}else if(e<n.v-3){n.mv=n.v;n.mt=n.t;n.s=-1;n.v=e;n.t=t}}function fe(t){var n=f.eb+t-f.eu,r=Math.floor(n/86400),u,l,a,o=null,s=Shelly.getUptimeMs()/1e3,c=[];if(!f.est||s-f.zf<72e3)return;c[0]=A(r-1);c[1]=A(r);c[2]=A(r+1);for(u=-1;u<=1;u++){l=(r+u)*86400+c[u+1]*60+600-n;if(f.def?l>-43200&&l<=43200:l>=-10800&&l<75600)o=l}if(o===null)return;l=o-e.Te;if((f.zn?Math.abs(l):f.def?Math.abs(o):o)<e.Me)return;a=Math.floor(f.eb+l+s-f.eu);Shelly.call(\"Sys.SetTime\",{unixtime:a},y,le);f.zf=s;f.zl=l;f.co=i.cs;f.cp=s;i.cs=a}function ue(e){if(f.oa){f.oa+=e;if(i.os>1)i.os=Math.floor(f.oa)}if(f.ie&&i.io)i.io=Math.floor(i.io+e)}function le(e,t,n){f.cp=0;if(t){i.cs=f.co;m(\"Uhr nicht stellbar: \"+n);return}f.eb+=f.zl;f.zn=1;f.cg++;ue(f.zl);R();m(\"Uhr nach Tagesgang um \"+s(f.zl/3600)+\" h gestellt\")}function ae(e,t){if(f.def&&t)De(_(e).day-_(t).day);if(!(Math.abs(e-t)<=60))f.cg++;if(t)ue(e-t);f.eb=e;f.eu=u();f.est=false;f.def=false;f.ie=false;i.ce=0;f.td=null;f.ty=null;R()}function oe(e){var t=[],n;for(n=0;n<f.starts.length;n++)if(e-f.starts[n]<3600)t.push(f.starts[n]);f.starts=t;return t.length}function se(e){if(f.run&&!f.run.why)f.run.why=e;Shelly.call(\"Switch.Set\",{id:0,on:false},g)}function ce(e,t,n){var r=f.ps,u,l;if(!t)return;u=N();l=(\"Einschalten abgelehnt: \"+n).slice(0,60);f.ps=null;m(l);if(r&&r.k!==\"hand\")f.want={k:r.k,mm:r.mm,exp:(u||0)+1800};if(i.ft!==l||!i.fo||!(u&&i.fu>1&&_(i.fu).day===_(u).day)){i.fu=u?Math.floor(u):1;i.ft=l;i.fo=1;R()}}function he(t,n){var r=u(),i=f.sw;if(f.ps&&r>f.ps.Be)f.ps=null;if(f.run||i.output||f.ps)return\"l\\xC3\\xA4uft\";if(f.weld)return\"Relais\";if(f.Oe&&r-f.Oe<e.Se)return\"Pause\";if(oe(r)>=e.ne)return\"Starts\";var l=Y(n);if(l<60)return\"kurz\";Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:l},y,ce);f.ps={k:t,mm:n,sec:l,Be:r+15};return null}function me(e){f.note=e;f.Fe=Shelly.getUptimeMs()/1e3;m(e)}function pe(t,n){var r=u(),o=f.ps,s=N(),h,p,S,y=0,b;f.ps=null;if(o&&(n||r<=o.Be)){h=o.k;p=o.mm;S=o.sec}else{h=\"hand\";if(oe(r)>=e.ne){me(\"Zu viele Starts in einer Stunde \\xE2\\x80\\x93 Pumpe gesch\\xC3\\xBCtzt\");f.starts.push(r);se(\"starts\");return}if(f.boot&&t.timer_duration){b=s&&t.timer_started_at?c(s-t.timer_started_at,0,t.timer_duration):0;y=t.timer_duration-b;S=t.timer_duration>e.ee*60?Math.min(y,e.C*60-b):y;S=l(c(S,1,t.timer_duration));if(S<y-5)Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:S},g);p=S*B()/3600}else{p=c(s?X(_(s)):e.W,e.W,e.D);S=Math.min(Y(p),e.C*60);p=S*B()/3600;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:S},g)}f.want=null;if(i.rt){i.rt=0;R()}}f.starts.push(r);f.run={k:h,t0:r,lt:r,u0:s||0,sec:S,mm:p,ps:0,cr:0,ck:r,sp:0,np:0,pf:-1,u:0,o:0,n:0,i:0,why:\"\",det:\"\"};m(\"Pumpe an (\"+h+\"), Ziel \"+a(p)+\" mm in \"+l(S/60)+\" min\")}function Se(e){var t=e.ps*B()/3600,n=t-e.cr;if(n>0){i.pi=i.pi+n;e.cr=t}}function ge(e,t){f.run.why=e;f.run.det=t;m(\"Schutz: \"+e+\" (\"+t+\")\");se(e)}function ye(t){var n=f.run,r=u(),a=r-n.t0,o=c(r-n.lt,0,5);var h=t.apower||0,m=t.current||0;var p=i.pn?i.pn*e.fe:e.Y;var S=i.pn?i.pn*e.ue:e.j;n.lt=r;if(n.why)return;if(a>n.sec+60){se(\"ende\");return}n.pf=n.pf<0?h:n.pf+(h-n.pf)*.3;n.i=a>=2&&m>e.$?n.i+1:0;if(n.i>=e.pe){ge(\"blockiert\",s(m)+\" A\");return}n.n=a>=3&&h<e.ae?n.n+1:0;if(n.n>=e.me){ge(\"keinStrom\",l(h)+\" W\");return}n.o=a>=e.oe&&n.pf>S?n.o+1:0;if(n.o>=e.he){ge(\"ueberlast\",l(n.pf)+\" W > \"+l(S)+\" W\");return}n.u=a>=e.oe&&h>=e.ae&&n.pf<p?n.u+1:0;if(n.u>=e.se){ge(\"unterlast\",l(n.pf)+\" W < \"+l(p)+\" W\");return}if(n.pf>=p)n.ps+=o;if(a>=60&&a<300){n.sp+=h;n.np++}if(r-n.ck>=e.Ee){Se(n);R();n.ck=r}}function be(t){if(!i.pn){if(t>=e.Z&&t<=e.X){i.pn=l(t);i.ln=1;me(\"Normalleistung eingelernt: \"+i.pn+\" W\")}else{me(\"Leistung \"+l(t)+\" W unplausibel \\xE2\\x80\\x93 nicht eingelernt (Hahn zu?)\")}}else if(Math.abs(t/i.pn-1)<=e.le){i.pn=l(i.pn*.8+t*.2);i.ln++}}var ve={unterlast:\"Trockenlauf oder Hahn zu\",ueberlast:\"\\xC3\\x9Cberlast\",blockiert:\"Pumpe blockiert\",keinStrom:\"Pumpe zieht keinen Strom\",start:\"Pumpe lief nicht an\"};function de(t){var n=f.run,r=u(),l=N(),o=n.why,c=t.errors&&t.errors.length;f.run=null;f.Oe=r;Se(n);if((!o||o===\"start\")&&c)o=\"fw\";var h=o===\"fw\"||!!ve[o];if(!h&&n.np>=30)be(n.sp/n.np);var p=h?o===\"fw\"?\"Firmware-Schutz: \"+t.errors.join(\",\"):ve[o]+(n.det?\" (\"+n.det+\")\":\"\"):\"\";if(h){i.fu=l?Math.floor(l):1;i.ft=p.slice(0,60);i.fo=1}else if(n.ps>=60)i.fo=0;if(n.k===\"hand\")i.sh++;else i.sa++;i.sm=a(i.sm+n.cr);if(h)i.sf++;if(l){var S=_(l),g=_(n.u0||l);i.lr=w(g.day)+\" \"+T(g.min)+\" \"+(n.k===\"hand\"?\"Hand\":n.k===\"retry\"?\"Nachlauf\":\"Automatik\")+\" \"+s(n.cr)+\" mm\"+(h?\" \\xE2\\x80\\x93 abgebrochen\":\"\");if(h){if(i.fd!==S.day){i.fd=S.day;i.fc=0}i.fc++;var y=n.mm-n.cr,b=o===\"unterlast\"?e.be:1;i.rt=0;if((n.k===\"auto\"||n.k===\"retry\")&&y>=2&&i.fc<=b){i.rt=Math.floor(l)+(r-n.t0<10?e.ye:e.ge)*60;i.rm=a(y)}}}m(\"Pumpe aus: \"+(o||\"Ende/Stopp\")+\", \"+a(n.cr)+\" mm gegeben\");R()}function _e(t){var n=u(),r=t.apower||0;if(f.Oe&&n-f.Oe<5)return;if(r>e.ae){f.wc++;if(f.wc>=5){if(!f.weld)m(\"Relais klebt? \"+l(r)+\" W bei AUS\");f.weld=true;if(f.wc%30===5)Shelly.call(\"Switch.Set\",{id:0,on:false},g)}}else{f.wc=0;f.weld=false}}function Me(e){return\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min,\"+\"temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=\"+e}function Te(e,t,n){f.wx.busy=true;f.wx.L=e;f.wx.n=t;f.wx.rc=n;f.wx.t=u();f.wx.q++;f.wx.cg=f.cg;Shelly.call(\"HTTP.GET\",{url:Me(t),timeout:20},ke,f.wx.q)}function we(e){if(!Z(e)){i.ev=e.day;i.d=0;i.pi=0;i.dp=e.day-1;i.rt=0;i.xa=-1;i.xe=[];i.xw=[];f.why=\"Winterpause\";R();return}if(i.dp<0||e.day-1-i.dp>14){i.d=0;i.pi=0;i.dp=e.day-1-(i.dp<0?0:14)}while(i.xe.length&&e.day-i.xa>14)Q();if(!i.xe.length)i.xa=-1;if(f.la===null){$(e);Re(e,null,false);return}Te(e,e.day-(i.xa>=0?i.xa:i.dp+1),false)}function Ae(e,t){return e&&typeof e[t]===\"number\"?e[t]:null}function Ne(e,t,n){return{rain:Ae(e.precipitation_sum,t)||0,prob:Ae(e.precipitation_probability_max,t)||0,tmin:Ae(e.temperature_2m_min,t),tnow:n&&typeof n.temperature_2m===\"number\"?n.temperature_2m:null}}function ke(e,t,n,r){var u=f.wx.L,l=f.wx.rc,a=JSON.stringify(i);try{Ee(e,t,n,r)}catch(e){m(\"Fehler Wetterantwort: \"+e);i=JSON.parse(a);f.wx.busy=true;f.wx.rc=l;try{Ee(null,-1,\"Fehler\",r)}catch(e){m(\"Fehler Tagespr\\xC3\\xBCfung: \"+e);i=JSON.parse(a);f.wx.busy=false;f.wx.rc=false;if(u&&!l){i.ev=u.day;f.why=\"Fehler, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen\";R()}}}}function Ee(t,n,r,l){var a=f.wx.L,o=f.wx.n,s=false,h=null,m=null,p,S,g,y,b,d;if(l!==f.wx.q||!f.wx.busy)return;f.wx.busy=false;if(f.wx.cg!==f.cg){if(f.wx.rc){f.wx.rc=false;f.rh=0}return}try{if(!n&&t&&t.code===200){h=JSON.parse(t.body);m=h.daily;s=m&&m.time&&m.time.length===o+1&&m.time[o]===M(a)}}catch(e){s=false}if(f.wx.rc){f.wx.rc=false;if(s)Re(a,Ne(m,o,h.current),true);else if(i.rc===a.day&&(i.rk===1||i.rk===3))Re(a,null,true);return}if(!s){if(!f.oa)f.oa=N()||0;f.wx.ze++;d=N();if(f.wx.ze<(f.est||f.off?1:4)&&d&&_(d).min+21<e.A){f.wx.next=u()+1200;return}Ie(true);$(a);Re(a,null,false);return}for(p=0;p<o;p++){S=a.day-o+p;g=Ae(m.et0_fao_evapotranspiration,p);y=Ae(m.precipitation_sum,p);if(g===null)g=K(v(S).m);if(y===null)y=0;b=g*e.F-Math.max(0,y-e.B);if(S>i.dp){i.d=c(c(i.d-i.pi,0,e.U)+b,0,e.U);i.pi=0}else if(i.xa>=0&&S>=i.xa){if(S===i.xa)i.d=i.xd;i.d=c(c(i.d-(i.xw[S-i.xa]||0),0,e.U)+b,0,e.U)}}i.xa=-1;i.xe=[];i.xw=[];i.d=c(i.d-i.pi,0,e.U);i.pi=0;i.dp=a.day-1;f.nf=false;if(o>=1){y=Ae(m.precipitation_sum,o-1);f.nf=i.rd===a.day-1&&y!==null&&y-e.B<i.rx/2;te(a,Ae(m.temperature_2m_min,o-1),Ae(m.temperature_2m_max,o-1))}Ie(false);Re(a,Ne(m,o,h.current),false)}function Re(t,n,r){var u=X(t),l=0,o=0,c=N(),h=t.min,p=null,S=false,g,y,b,d,M,A,k,E,O,z,F,L,P,I,D=r&&i.rc===t.day?i.rk:0;if(c)h=_(c).min;f.wx.ze=0;if(f.run){R();return}y=i.ev<0?null:v(i.ev);if(!y||!Z(y)||t.day-i.ev>60){i.s0=t.day;i.sa=0;i.sh=0;i.sm=0;i.sf=0}i.ev=t.day;i.rc=-1;i.rk=0;if(D===1||D===3){p=i.rf;S=D===3}else if(n&&n.tmin!==null)p=n.tmin<e.G?n.tmin:null;else{p=ne();if(p!==null){if(p>=e.J)p=null;else S=true}}g=n&&n.tnow!==null?n.tnow:re();b=s(u);d=p===null?\"\":s(p);M=n?s(n.rain):\"\";A=T(h);k=T(e.A);E=i.pu?w(i.pu):\"\";if(n&&n.prob>=e.H&&!f.nf)l=Math.max(0,n.rain-e.B);O=Math.min(e.D,u-l);z=l>0&&O<Math.min(e.D,u);F=Y(O)*B()/3600;F=s(F);L=a(l);P=p===null?0:a(p);I=(Math.floor(h/60)+1)*60+5;if(!G())f.why=\"Automatik aus\";else if(V(t))f.why=\"Pause bis \"+E;else if(u<e.P)f.why=\"nicht n\\xC3\\xB6tig (\"+b+\" mm)\";else if(p!==null&&!(g>=e.V)){f.why=\"Frostsperre (\"+(S?\"gesch\\xC3\\xA4tzt \":\"\")+d+\" \\xC2\\xB0C), gie\\xC3\\x9Ft ab \"+e.V+\" \\xC2\\xB0C\";i.rc=t.day;i.rk=S?3:1;i.rf=P;f.rh=I}else{o=O;if(z){i.rd=t.day;i.rx=L}else if(i.rd===t.day)i.rd=-1;if(o<e.I&&l>0){f.why=\"Regen erwartet (\"+M+\" mm, \"+n.prob+\" %)\"+(D===2?\", \"+A+\" best\\xC3\\xA4tigt\":\"\");i.rc=t.day;i.rk=2;f.rh=I}else if(o<e.I)f.why=\"nicht n\\xC3\\xB6tig (\"+b+\" mm)\";else if(h>=e.A){f.why=k+\" vorbei, nicht mehr gestartet\";o=0}else f.why=(D===2?\"Regen abgesagt, \":D?\"Frost vorbei, \":\"\")+\"gegossen \"+F+\" mm\"+(f.nf?\" (gestern Regen ausgeblieben)\":\"\")}m(\"Tagespr\\xC3\\xBCfung: Defizit \"+a(u)+\" mm\"+(n?\"\":\" (ohne Internet)\")+\" -> \"+f.why);if(o>=e.I)f.want={k:\"auto\",mm:o,exp:(c||0)+7200};R()}function selfTest(){if(f.la===null)return\"FEHLER Ort unbekannt: \"+e.l;if(!f.st){f.st=\"l\\xC3\\xA4uft\";Shelly.call(\"HTTP.GET\",{url:Me(14),timeout:20},y,Oe)}return f.st===\"ok\"?\"ok, Ort \"+f.la+\" \"+f.lo:f.st}function Oe(e,t,n){var r=false;try{r=!t&&e.code===200&&JSON.parse(e.body).daily.time.length===15}catch(e){r=false}f.st=r?\"ok\":\"FEHLER \"+(n||\"Antwort\");m(\"Selbsttest Wetter: \"+f.st)}function ze(){var t=Shelly.getComponentStatus(\"sys\"),n=b(2026,4,15)*86400+e.T*60-(e.M+1)*3600;f.Ue=0;if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Re)return;f.def=true;f.est=true;f.eb=n;f.eu=u();i.df=1;i.ce=1;i.cs=n;Shelly.call(\"Sys.SetTime\",{unixtime:n},g);m(\"Uhrzeit unbekannt \\xE2\\x80\\x93 Einstecken gilt als 15. April \"+T(e.T));R()}function Fe(){f.gn=u()+900;Shelly.call(\"HTTP.GET\",{url:\"https://geocoding-api.open-meteo.com/v1/search?count=1&name=\"+f.oq+\"&countryCode=\"+e.p,timeout:20},y,Pe)}function Le(e){var t=\"\",n=0,r,i,f,u=\"0123456789ABCDEF\";while(n<e.length){r=e.charCodeAt(n);i=e.charCodeAt(n+1);f=-1;if(r>47&&r<58||r>64&&r<91||r>96&&r<123)t+=e.charAt(n);else if(r<128)t+=\"%\"+u.charAt(r>>4)+u.charAt(r&15);else if(r>193&&r<224&&i>127&&i<192){f=i;n++}else{f=128|r&63;r=192|r>>6}if(f>=0)t+=\"%\"+u.charAt(r>>4)+u.charAt(r&15)+\"%\"+u.charAt(f>>4)+u.charAt(f&15);n++}return t}function Pe(t,n,r){var u=null,l;try{if(!n&&t&&t.code===200)u=JSON.parse(t.body)}catch(e){u=null}if(!u)return;l=u.results&&u.results[0];if(!l){if(!f.gx)m(\"Ort \"+e.l+\" nicht gefunden \\xE2\\x80\\x93 Schreibweise pr\\xC3\\xBCfen oder LAT/LON eintragen\");f.gx=true;return}if(typeof l.latitude!==\"number\"||typeof l.longitude!==\"number\")return;f.gx=false;f.la=i.la=o(l.latitude);f.lo=i.lo=o(l.longitude);i.pz=e.p+e.l;R();m(\"Ort \"+e.l+\": \"+f.la+\", \"+f.lo)}function Ie(e){var t=N();if(e&&!f.oa)f.oa=t||0;if(e&&!f.off)f.We=u()+900;if(!e){if(f.off&&f.oa&&t){i.io=Math.floor(f.oa);i.id=Math.max(0,l((t-f.oa)/60));f.ie=f.est}f.oa=0}f.off=e;i.os=e?Math.floor(f.oa)||1:0}function De(e){if(i.ev>=0)i.ev+=e;if(i.dp>=0)i.dp+=e;if(i.fd>=0)i.fd+=e;if(i.pu)i.pu+=e;if(i.xa>=0)i.xa+=e;if(i.rd>=0)i.rd+=e;if(i.rc>=0)i.rc+=e;if(i.fu>1)i.fu+=e*86400;if(i.io&&!f.ie)i.io+=e*86400;if(i.s0>0)i.s0+=e;i.rt=0;i.df=0;f.td=null;f.ty=null;f.z=null;m(\"Echte Uhrzeit da: Tagesmarken um \"+e+\" Tage verschoben\")}function Ue(){if(f.Ue&&u()>=f.Ue)ze();if(u()>=f.cfgAt){f.cfgAt=u()+3600;tt();it()}if(!f.h&&u()-f.hb>=(f.hn<10?60:3600))D();if(f.la===null&&u()>=f.gn)Fe();var t=N();if(!t)return;var n=_(t),r=u();if(f.est&&!(f.cp&&r-f.cp<60)&&(Math.abs(t-(f.eb+r-f.eu))>5||k())){ae(t,f.eb+r-f.eu)}if(i.ev>n.day||i.dp>n.day-1||i.pu>n.day+14){if(i.ev>n.day)i.ev=-1;if(i.dp>n.day-1)i.dp=n.day-1;if(i.pu>n.day+14)i.pu=0;i.rt=0;R()}if(t-i.t>=e.Ae)R();ee(n,r);if(f.off&&f.la!==null&&!f.wx.busy&&r>=f.We){Shelly.call(\"HTTP.GET\",{url:\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=temperature_2m_min&timezone=auto&forecast_days=1\",timeout:10},y,We);f.We=r+900}if(i.pu&&n.day>i.pu){i.pu=0;R()}if(f.run&&f.run.k!==\"hand\"&&(!G()||V(n)))se(\"aus\");var l=f.est&&r<e.we;if(!l&&i.ev!==n.day&&n.min>=e.T&&n.min<e.A&&!f.wx.busy&&r>=f.wx.next&&!f.run&&!f.ps){we(n)}if(!l&&i.rc===n.day&&n.min>=f.rh&&n.min<e.A&&!f.wx.busy&&!f.run&&!f.ps){f.rh=(Math.floor(n.min/60)+1)*60+5;if(f.off||f.la===null)Re(n,null,true);else Te(n,0,true)}if(f.want&&!l){if(t>f.want.exp||!G()||n.min>=e.A)f.want=null;else if(!he(f.want.k,f.want.mm))f.want=null}if(i.rt&&t>=i.rt&&!f.run&&!l){if(n.min>=e.A||!G()||V(n)||i.fd!==n.day){i.rt=0;R()}else if(!he(\"retry\",i.rm)){i.rt=0;R()}}}function We(e,t,n){if(!t&&e&&e.code===200&&f.off){Ie(false);R()}}function Ce(t){var n=[],r=T(e.T);if(!t)n.push(\"Uhrzeit unbekannt\");else if(f.def)n.push(\"Uhr angenommen: Einstecken = \"+r);else if(f.est)n.push(\"Uhr gesch\\xC3\\xA4tzt\");if(f.la===null)n.push(\"Ort \"+(f.gx?e.l+\" nicht gefunden\":\"unbekannt\"));else if(f.off)n.push(\"ohne Internet\");if(f.Le)n.push(\"Speicher fehlt (Firmware alt)\");return{e:f.weld?\"Relais klebt\":i.fo?\"St\\xC3\\xB6rung: \"+i.ft:\"\",w:n}}function He(t){var n=f.run,r,u,l,a=i.fu>1?_(i.fu):null,o=i.rt?_(i.rt):null,c=Shelly.getUptimeMs()/1e3,m=T(e.T),p=T(e.A),S=i.pu?w(i.pu):\"\",g=a?T(a.min):\"\",y,b;if(f.weld)return\"ALARM: Pumpe zieht Strom trotz AUS \\xE2\\x80\\x93 Relais klebt? Stecker ziehen!\";if(n){r=n.sec-(c-n.t0);y=s(n.mm);b=Math.round(r/60);l=Math.round(f.sw.apower||0);return\"Beregnung (\"+(n.k===\"hand\"?\"Hand\":n.k===\"retry\"?\"Nachlauf\":\"Automatik\")+\"): \"+y+\" mm, noch \"+(b>0?b:0)+\" min, \"+l+\" W\"}if(!t)return\"Uhrzeit unbekannt \\xE2\\x80\\x93 Automatik wartet auf Internet. Taster geht.\";if(i.fo&&(!a||a.day===t.day)){b=o?T(o.min):\"\";r=\"St\\xC3\\xB6rung\"+(a?\" \"+g:\"\")+\": \"+i.ft;y=i.ev!==t.day&&t.min<e.A?\"heute \":\"morgen \";r+=o?\". Nachlauf \"+b:f.want?\". Neuer Versuch bis \"+p:\". N\\xC3\\xA4chster Versuch \"+y+m}else if(!Z(t))r=\"Winterpause bis 01.\"+h(e.N)+\". \\xE2\\x80\\x93 Taster geht\";else if(!G())r=\"Automatik aus \\xE2\\x80\\x93 Taster geht\";else if(V(t))r=\"Pause bis \"+S;else if(i.ev===t.day)r=\"Heute: \"+(f.why||\"gepr\\xC3\\xBCft\");else if(t.min<e.T)r=\"Bereit, Pr\\xC3\\xBCfung \"+m;else r=t.min<e.A?\"Pr\\xC3\\xBCfung l\\xC3\\xA4uft\":\"Heute nicht gepr\\xC3\\xBCft, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen \"+m;if(i.fo&&a&&a.day!==t.day){y=w(a.day);r+=\" \\xC2\\xB7 St\\xC3\\xB6rung \"+y+\" \"+g+\": \"+i.ft}l=Ce(t).w;for(u=0;u<l.length;u++)r+=\" \\xC2\\xB7 \"+l[u];if(i.lr)r+=\" \\xC2\\xB7 Zuletzt \"+i.lr;if(f.note&&c-f.Fe>43200)f.note=\"\";if(f.note)r+=\" \\xC2\\xB7 \"+f.note;else if(i.pn)r+=\" \\xC2\\xB7 Pumpe normal \"+i.pn+\" W\";while(r.length>230&&r.lastIndexOf(\" \\xC2\\xB7 \")>0)r=r.slice(0,r.lastIndexOf(\" \\xC2\\xB7 \"));return r.length>230?r.slice(0,230):r}function xe(){var e=N(),t=e?_(e):null,n;Ke(t);if(!f.h)return;try{for(n in f.h)if(n!==\"re\"&&f.hl<3&&typeof f.h[n].getStatus===\"function\"&&f.h[n].getStatus()===undefined)throw\"fehlt \"+n;Be(t)}catch(e){m(\"Bedienfeld neu: \"+e);f.hl++;try{f.h.re.off(f.hr)}catch(e){}f.h=null;f.hn=0;f.hb=0;f.Pe=-1;f.Ie=\"\";f.De=-1;J()}}function Be(e){var t,n,r,u;J();r=f.h.pa.getValue();if(e&&typeof r===\"number\"&&f.Pe>=0&&r!==f.Pe){i.pu=r>0?e.day+l(r)-1:0;i.rt=0;f.want=null;R();u=r>0?w(i.pu):\"\";m(\"Pause \"+(r>0?\"bis \"+u:\"aufgehoben\"))}n=e&&V(e)?i.pu-e.day+1:0;if(n!==f.Pe){f.h.pa.setValue(n);f.Pe=n}t=He(e);if(t!==f.Ie){f.h.st.setValue(t);f.Ie=t}n=e?a(X(e)):0;if(n!==f.De){f.h.bk.setValue(n);f.De=n}}function Ge(e,t){return e&&t&&e[0]===t[0]&&e[1]===t[1]&&e[2]===t[2]}function Je(){var e=Shelly.getComponentConfig(\"plugs_ui\"),t,n;f.led=\"?\";if(!e||!e.leds||e.leds.mode!==\"switch\"||!e.leds.colors||!e.leds.colors[\"switch:0\"])return;t=e.leds.colors[\"switch:0\"].off;for(n in r)if(n!==\"run\"&&t&&Ge(t.rgb,r[n])&&t.brightness===100)f.led=n}function Ve(e){return e.e?\"err\":e.w.length?\"warn\":\"ok\"}function Ke(e){var t=Ve(Ce(e)),n=u(),i=[],l;if(t!==f.Ce){f.Ce=t;f.He=n}if(t===f.led||n-f.He<(t===\"err\"||f.led===\"?\"?120:1800))return;for(l=0;l<f.ledN.length;l++)if(n-f.ledN[l]<86400)i.push(f.ledN[l]);f.ledN=i;if(i.length>=12)return;Shelly.call(\"PLUGS_UI.SetConfig\",{config:{leds:{mode:\"switch\",colors:{\"switch:0\":{on:{rgb:r.run,brightness:100},off:{rgb:r[t],brightness:100}}}}}},y,Ze);f.led=t;f.ledN.push(n);f.nl++}function Ze(e,t,n){if(t){m(\"LED nicht gesetzt: \"+n);f.led=\"?\";f.He=u()+3480}}function Xe(e){var t=_(e);return w(t.day)+t.y+\" \"+T(t.min)}function Ye(){try{var e=Shelly.getDeviceInfo();return e&&e.ver||\"?\"}catch(e){return\"?\"}}function qe(e){var t=Math.round(e/60),n=Math.round(t/60),r=Math.round(t/1440);return t<120?t+\" min\":t<2880?n+\" h\":r+\" Tage\"}var je={ok:\"gr\\xC3\\xBCn\",warn:\"gelb\",err:\"violett\"};function info(){var t=N(),n=t?_(t):null,r=Ce(n),u=Shelly.getUptimeMs()/1e3,l,a,o,c=Ve(r),h=He(n),m=r.w.join(\", \"),p=t?Xe(t):\"\\xE2\\x80\\x93 Uhrzeit unbekannt\",S=i.fu>1?Xe(i.fu)+\" \":\"\",g=i.s0>0?w(i.s0):\"-\",y=s(i.sm),b=n?X(n):i.d,v=i.ob>-50?s(i.ob):\"-\",d=i.oa>-50?s(i.oa):\"-\",M=f.off&&f.oa?Xe(f.oa):\"\",T=i.io?Xe(i.io):\"\",A=i.io?qe(i.id*60):\"\",k=Ye(),E=t?Xe(t-u):\"?\",R=qe(u),O=f.t0>e.Re?Xe(f.t0):\"\",z=qe(u-f.s0);b=s(b);o=\"Bew\\xC3\\xA4sserung \"+p+\"\\n\\nStatus: \"+h+\"\\nLED: \"+(je[f.led]||\"noch nicht gesetzt\")+(c!==f.led?\", wechselt bald auf \"+je[c]:\"\")+\" \\xE2\\x80\\x93 \"+(r.e||m||\"alles in Ordnung\")+\"\\nLetzte St\\xC3\\xB6rung: \"+(i.ft?S+i.ft+(i.fo?\" (offen)\":\" (erledigt)\"):\"keine\")+\"\\nLetzter Lauf: \"+(i.lr||\"keiner\")+\"\\nSaison seit \"+g+\": Automatik \"+i.sa+\", Hand \"+i.sh+\", zusammen \"+y+\" mm, St\\xC3\\xB6rungen \"+i.sf+\"\\nBodenkonto \"+b+\" mm, Normalleistung \"+(i.pn?i.pn+\" W\":\"nicht gelernt\")+\", Eigenw\\xC3\\xA4rme F\\xC3\\xBChler Nacht/Tag \"+v+\" / \"+d+\" K\"+\"\\nUhr: \"+(!t?\"unbekannt\":f.def?\"angenommen\":f.est?\"gesch\\xC3\\xA4tzt\":\"Zeitserver\")+\"\\nInternet: \"+(f.off?\"Wetterdienst fehlt\"+(f.oa?\" seit \"+M:\"\"):f.la===null?\"ohne Ort kein Wetterabruf\":\"ok\")+(i.io?\", letzter Ausfall \"+T+\", \"+A:\"\")+\"\\nOrt: \"+e.l+(f.la===null?f.gx?\" nicht gefunden\":\" noch unbekannt\":\" \"+f.la+\", \"+f.lo)+\"\\nGer\\xC3\\xA4t: Firmware \"+k+\", an seit \"+E+\" (\"+R+\")\"+(f.t0>e.Re?\", davor zuletzt gespeichert \"+O:\"\")+\"; Skript l\\xC3\\xA4uft seit \"+z+\"\\nFlash-Schreibvorg\\xC3\\xA4nge seit Skriptstart: Speicher \"+f.nw+\", Einstellungen \"+f.nc+\", LED \"+f.nl+\"\\n\\nLetzte Meldungen:\";a=f.lg.length;l=1;while(l<=a){o+=Qe(f.lg[(f.li-l+a)%a]);l++}return o}function Qe(e){var t=Number(e.slice(0,10)),n=t?_(t):null,r=n?w(n.day):\"\",i=n?T(n.min):\"\";return\"\\n\"+(n?r+(e.charAt(10)===\"~\"?\" ~\":\" \")+i:\"--.-- --:--\")+\" \"+e.slice(11)}function $e(e,t){try{t.body=info();t.code=200}catch(e){t.body=\"Fehler: \"+e;t.code=500}try{t.headers=[[\"Content-Type\",\"text/plain; charset=utf-8\"]];t.send()}catch(e){m(\"Diagnose-Seite: \"+e)}}function et(){var e;f.k++;try{e=p();S(e);f.u=N()||0;if(e.output&&!f.run)pe(e);else if(!e.output&&f.run)de(e);else if(e.output&&f.run)ye(e);else if(f.ps&&u()>f.ps.Be){pe(e,1);f.run.why=\"start\";de(e)}if(!e.output)_e(e);f.boot=false}catch(e){m(\"Fehler Takt: \"+e)}if(f.k%30===1&&f.wx.busy&&u()-f.wx.t>60)ke(null,-1,\"keine Antwort\",f.wx.q);if(f.k%30===1){try{Ue()}catch(e){m(\"Fehler Plan: \"+e)}}if(f.k%10===2){try{xe()}catch(e){m(\"Fehler Anzeige: \"+e)}}try{O()}catch(e){m(\"Fehler Speicher: \"+e)}}function tt(){var t=Shelly.getComponentConfig(\"switch\",0)||{},n={},r=false;if(t.initial_state!==\"off\"){n.initial_state=\"off\";r=true}if(t.auto_off!==true){n.auto_off=true;r=true}if(t.auto_off_delay!==e.te){n.auto_off_delay=e.te;r=true}if(t.auto_on===true){n.auto_on=false;r=true}if(t.autorecover_voltage_errors===true){n.autorecover_voltage_errors=false;r=true}if(t.name!==\"Brunnenpumpe\"){n.name=\"Brunnenpumpe\";r=true}if(r){Shelly.call(\"Switch.SetConfig\",{id:0,config:n},g);f.nc++}}var nt=\"0 */5 * * * *\";var rt=\"0 23 3 * * *\";function it(e){f.sn=e||0;Shelly.call(\"Schedule.List\",{},y,ft)}function ft(e,t,n){var r=e&&e.jobs||[],i,f,u,l,a=null,o=false;if(t){m(\"Zeitplan nicht lesbar: \"+n);return}for(i=0;i<r.length;i++){u=r[i].calls||[];for(f=0;f<u.length;f++){l=u[f]?String(u[f].method).toLowerCase():\"\";if(l===\"script.start\"&&u[f].params&&u[f].params.id===Script.id)a=r[i];if(l===\"shelly.update\")o=true}}if(!a){if(z(\"Schedule.Create\",{enable:true,timespec:nt,calls:[{method:\"Script.Start\",params:{id:Script.id}}]},ut)){m(\"W\\xC3\\xA4chter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht\")}}else if(a.enable!==true||a.timespec!==nt){z(\"Schedule.Update\",{id:a.id,enable:true,timespec:nt},ut)}else if(!o){if(z(\"Schedule.Create\",{enable:true,timespec:rt,calls:[{method:\"Shelly.Update\",params:{stage:\"stable\"}}]},ut)){m(\"Firmware-Update angelegt: t\\xC3\\xA4glich 03:23 die neueste stabile\")}}}function ut(e,t,n){if(t)m(\"Zeitplan nicht gesetzt: \"+n);else if(f.sn<2)it(f.sn+1)}function lt(){E();S(p());f.u=N()||0;f.oq=Le(e.l);if(typeof e.S===\"number\"&&typeof e._===\"number\"){f.la=e.S;f.lo=e._}else if(i.la!==null){f.la=i.la;f.lo=i.lo}f.t0=i.t;f.s0=u();if(i.os){f.off=true;f.oa=i.os>1?i.os:0}var t=Shelly.getComponentStatus(\"sys\"),n=u();if(i.wu>0&&n>=i.wu){f.sv=i.wu;f.wn=i.wn;f.w24=Math.min(i.wb,n)}if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Re&&(!i.ce||n<i.tu||k())){if(i.ce||i.df){if(i.df===1)De(_(t.unixtime).day-_(i.t).day);i.ce=0;R()}}else if(i.t>e.Re){f.eb=i.t+(n>=i.tu?n-i.tu:n);f.eu=n;f.est=true;f.def=i.df===1;f.u=N()||0;if(i.ce!==1||n<i.tu||!(t&&t.unixtime>e.Re)){i.ce=1;i.cs=Math.floor(f.eb);Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},g);m(\"Uhr aus Zeitanker gesch\\xC3\\xA4tzt\");R()}}else f.Ue=n+120;tt();it();f.cfgAt=n+3600;Je();D();try{HTTPServer.registerEndpoint(\"info\",$e)}catch(e){m(\"Diagnose-Seite fehlt: \"+e)}Timer.set(1e3,true,et);m(\"gestartet, Bodenkonto \"+a(i.d)+\" mm, Normalleistung \"+(i.pn||\"noch nicht gelernt\"))}lt();";
window.__bw = { fertig: false, log: [] };
deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })
  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })
  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });
return "Aufspielen gestartet, 31370 Byte";
})();
