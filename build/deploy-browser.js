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
 *           Skript läuft fehlerfrei, Einschaltzustand aus, Notabschaltung 7800 s, kein Wiedereinschalten,
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
    cfg.auto_off_delay === 7800 && cfg.auto_on !== true && fehlt.length === 0 && !!out.status && /^ok/.test(out.wetter) && reserve >= 2048 &&
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

var CODE = "var e={l:\"Ludwigshafen am Rhein\",p:\"DE\",S:null,M:null};var n=[.6,.9,1.6,2.6,3.5,4.5,4.4,3.8,2.4,1.1,.5,.5];var t=[6.1,9.3,13,17,21.1,26.3,27.4,27.4,22.8,16.7,9.6,6.8];var r={ok:[0,100,0],warn:[100,70,0],err:[100,0,0],run:[0,0,100]};var i=null;var f={k:0,u:0,sw:{output:false,apower:0,tC:null},ra:0,au:true,oq:\"\",eb:0,eu:0,est:false,run:null,ps:null,want:null,starts:[],A:0,wc:0,weld:false,wx:{busy:false,next:0,T:0,L:null,n:0,rc:false,t:0,q:0,cg:0},off:false,oa:0,ie:false,sv:-1e9,sd:false,wn:0,w24:0,cn:0,c24:0,why:\"\",note:\"\",W:0,P:false,h:null,_:-1,F:\"\",N:-1,boot:true,def:false,H:0,kh:-1,kc:0,ko:false,kw:0,O:0,cfgAt:0,sn:0,cg:0,hb:0,hn:0,hr:0,hl:0,led:\"\",U:\"\",R:0,ledN:[],lx:0,td:null,ty:null,ts:-1e9,z:null,zf:-1e9,zl:0,zn:0,cp:0,co:0,rh:0,nf:false,la:null,lo:null,gn:0,gx:false,st:\"\",lg:[],li:0,t0:0,s0:0,fl:[],fn:false,nw:0,nc:0,nl:0};function u(){return Shelly.getUptimeMs()/1e3}function l(e){return Math.round(e)}function a(e){return Math.round(e*10)/10}function o(e){return Math.round(e*100)/100}function s(e){var n=Math.round(e*10)/10;return String(n).replace(\".\",\",\")}function c(e,n,t){return e<n?n:e>t?t:e}function h(e){return(e<10?\"0\":\"\")+e}function m(e){var n=f.u>1e9?Math.floor(f.u):0,t=f.lg[(f.li+5)%6];e=String(e);print(\"[BW] \"+e);if(t&&t.slice(11)===e.slice(0,80))return;n=(n?String(n):\"0000000000\")+(f.est?\"~\":\" \")+e.slice(0,80);if(f.lg.length<6)f.lg.push(n);else f.lg[f.li]=n;f.li=(f.li+1)%6}function g(){return Shelly.getComponentStatus(\"switch\",0)||{}}function p(e){var n=e.temperature;f.sw.output=!!e.output;f.sw.apower=e.apower||0;f.sw.tC=n&&typeof n.tC===\"number\"?n.tC:null}function b(e,n,t){if(n)m(\"RPC-Fehler \"+n+\" \"+t)}function y(e,n,t,r){try{r(e,n,t)}catch(e){m(\"Fehler im R\\xC3\\xBCckruf: \"+e)}}function v(e,n,t){e-=n<=2?1:0;var r=e/400|0,i=e-r*400;var f=((153*(n+(n>2?-3:9))+2)/5|0)+t-1;var u=i*365+(i/4|0)-(i/100|0)+f;return r*146097+u-719468}function S(e){e+=719468;var n=e/146097|0,t=e-n*146097;var r=(t-(t/1460|0)+(t/36524|0)-(t/146096|0))/365|0;var i=t-(365*r+(r/4|0)-(r/100|0));var f=(5*i+2)/153|0;var u=f<10?f+3:f-9;return{y:r+n*400+(u<=2?1:0),m:u,d:i-((153*f+2)/5|0)+1}}function d(e){var n=1970+(e/31556952|0),t=v(n,4,1)-1,r=v(n,11,1)-1;t=(t-(t+4)%7)*86400+3600;r=(r-(r+4)%7)*86400+3600;return(1+(e>=t&&e<r?1:0))*3600}function k(e){var n=e+d(e),t=n/86400|0,r=S(t);return{day:t,min:(n-t*86400)/60|0,y:r.y,m:r.m,d:r.d}}function w(e){return e.y+\"-\"+h(e.m)+\"-\"+h(e.d)}function M(e){return h(e/60|0)+\":\"+h(e%60)}function z(e){var n=S(e);return h(n.d)+\".\"+h(n.m)+\".\"}function A(e){var n=S(e),t=v(n.y,1,1),r=2*Math.PI/365*(e-t);var i=Math.cos(r),u=Math.sin(r),l=Math.cos(2*r),a=Math.sin(2*r);var o=229.18*(75e-6+.001868*i-.032077*u-.014615*l-.040849*a);var s=.006918-.399912*i+.070257*u-.006758*l+907e-6*a;var c=(f.la===null?50:f.la)*Math.PI/180;var h=Math.cos(c),m=Math.cos(s),g=Math.tan(c),p=Math.tan(s),b=Math.cos(1.58534);var y=Math.acos(b/(h*m)-g*p);return 720-4*((f.lo===null?15*1:f.lo)+y*180/Math.PI)-o}function T(){var e=Shelly.getComponentStatus(\"sys\"),n=Shelly.getUptimeMs();if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return e.unixtime;return f.eb?f.eb+n/1e3-f.eu:null}function W(){var e=Shelly.getComponentStatus(\"sys\");return!!e&&typeof e.last_sync_ts===\"number\"&&Math.abs(e.last_sync_ts-i.cs)>5}function P(){var n=null,t=null;try{t=Script.storage.getItem(\"s\");n=JSON.parse(t)}catch(e){n=null}if(!n||n.v!==1){if(t)m(\"Speicher unlesbar, Voreinstellungen\");n={v:1}}if(typeof n.t!==\"number\")n.t=0;if(typeof n.d!==\"number\"||!(n.d>=0&&n.d<=25))n.d=0;if(typeof n.dp!==\"number\")n.dp=-1;if(typeof n.pi!==\"number\"||!(n.pi>=0))n.pi=0;if(typeof n.ev!==\"number\")n.ev=-1;if(typeof n.pn!==\"number\")n.pn=0;if(typeof n.pc!==\"number\")n.pc=0;if(typeof n.kt!==\"number\")n.kt=0;if(typeof n.pu!==\"number\")n.pu=0;if(typeof n.fd!==\"number\")n.fd=-1;if(typeof n.fc!==\"number\")n.fc=0;if(typeof n.rt!==\"number\")n.rt=0;if(typeof n.rm!==\"number\")n.rm=0;if(typeof n.lr!==\"string\")n.lr=\"\";if(typeof n.xa!==\"number\")n.xa=-1;if(!n.xe||typeof n.xe.length!==\"number\")n.xe=[];if(!n.xw||typeof n.xw.length!==\"number\"||n.xw.length!==n.xe.length){n.xw=[];n.xe=[];n.xa=-1}if(typeof n.xd!==\"number\")n.xd=0;if(typeof n.ob!==\"number\")n.ob=-99;if(typeof n.oa!==\"number\")n.oa=-99;if(typeof n.df!==\"number\")n.df=0;if(typeof n.rd!==\"number\")n.rd=-1;if(typeof n.rx!==\"number\")n.rx=0;if(typeof n.rc!==\"number\")n.rc=-1;if(typeof n.rk!==\"number\")n.rk=0;if(typeof n.rf!==\"number\")n.rf=0;if(typeof n.tu!==\"number\")n.tu=0;if(typeof n.ce!==\"number\")n.ce=0;if(typeof n.cs!==\"number\")n.cs=0;if(typeof n.fu!==\"number\")n.fu=0;if(typeof n.ft!==\"string\")n.ft=\"\";if(typeof n.fo!==\"number\")n.fo=n.fu?1:0;if(typeof n.s0!==\"number\")n.s0=0;if(typeof n.sa!==\"number\")n.sa=0;if(typeof n.sh!==\"number\")n.sh=0;if(typeof n.sm!==\"number\")n.sm=0;if(typeof n.sf!==\"number\")n.sf=0;if(typeof n.io!==\"number\")n.io=0;if(typeof n.id!==\"number\")n.id=0;if(typeof n.os!==\"number\")n.os=0;if(typeof n.wu!==\"number\")n.wu=0;if(typeof n.wn!==\"number\")n.wn=0;if(typeof n.wb!==\"number\")n.wb=0;if(n.pz!==e.p+e.l||typeof n.la!==\"number\"||typeof n.lo!==\"number\"){n.la=null;n.lo=null;n.pz=\"\"}i=n;try{n=JSON.parse(Script.storage.getItem(\"f\"))}catch(e){n=null}f.fl=n&&typeof n.length===\"number\"?n:[]}function _(){f.sd=true}function F(){var e=u(),n;if(!f.sd)return;if(e-f.w24>=86400){f.w24=e;f.wn=0}if(e-f.sv<(f.wn>=48?3600:60))return;n=T();if(n){i.t=Math.floor(n);i.tu=Math.floor(e)}i.d=o(i.d);i.pi=o(i.pi);i.wu=Math.floor(e);i.wn=f.wn+1;i.wb=Math.floor(f.w24);try{Script.storage.setItem(\"s\",JSON.stringify(i));f.P=false;f.sd=false;f.nw++;if(f.fn){Script.storage.setItem(\"f\",JSON.stringify(f.fl));f.fn=false;f.nw++}}catch(e){if(!f.P)m(\"Speicher schreibt nicht: \"+e);f.P=true}f.sv=e;f.wn++}function N(e,n,t){var r=Shelly.getUptimeMs()/1e3;if(r-f.c24>=86400){f.c24=r;f.cn=0}if(f.cn===30)m(\"Schreibbremse Einstellungen: \"+e);if(f.cn>=30){f.cn++;return false}Shelly.call(e,n,y,t);f.cn++;f.nc++;return true}var E=[[\"text\",200,\"st\"],[\"number\",200,\"bk\"],[\"boolean\",200,\"au\"],[\"number\",201,\"pa\"],[\"number\",202,\"ra\"],[\"button\",200,\"re\"]];function H(e){if(e===0)return{name:\"Status\",default_value:\"\",persisted:false,max_len:255,meta:{ui:{view:\"label\"}}};if(e===1)return{name:\"Wasserdefizit\",default_value:0,persisted:false,min:0,max:25,meta:{ui:{view:\"progressbar\",unit:\"mm\",step:.1}}};if(e===2)return{name:\"Automatik\",default_value:true,persisted:true,meta:{ui:{view:\"toggle\",titles:[\"Aus\",\"An\"]}}};if(e===3)return{name:\"Pause\",default_value:0,persisted:false,min:0,max:14,meta:{ui:{view:\"field\",unit:\"Tage\",step:1}}};if(e===4)return{name:\"Regenrate\",default_value:8.6,persisted:true,min:1,max:40,meta:{ui:{view:\"field\",unit:\"mm/h\",step:.1}}};return{name:\"Pumpe neu einlernen\",meta:{ui:{view:\"button\"}}}}var O=0;function L(){var e;while(O<E.length&&Shelly.getComponentConfig(E[O][0],E[O][1]))O++;if(O<E.length){e=H(O);N(\"Virtual.Add\",{type:E[O][0],id:E[O][1],config:e},x);return}if(!Shelly.getComponentConfig(\"group\",200)){N(\"Virtual.Add\",{type:\"group\",id:200,config:{name:\"Bew\\xC3\\xA4sserung\",meta:{ui:{view:\"group\"}}}},R);return}B();C()}function U(){f.hb=u();f.hn++;O=0;L()}function x(e,n,t){if(n)m(\"Bedienfeld \"+E[O][2]+\": \"+t);O++;L()}function R(e,n,t){B();C()}function B(){var e=[],n,t=Shelly.getComponentStatus(\"group\",200),r=t?t.value:null,i,f;for(n=0;n<E.length;n++)e.push(E[n][0]+\":\"+E[n][1]);i=!!r&&r.length===e.length;f=i?\",\"+r.join(\",\")+\",\":\"\";for(n=0;n<e.length;n++)if(f.indexOf(\",\"+e[n]+\",\")<0)i=false;if(!i)N(\"Group.Set\",{id:200,value:e},b)}function C(){var e={},n,t=true;if(f.h)return;try{n=0;while(n<E.length){e[E[n][2]]=Virtual.getHandle(E[n][0]+\":\"+E[n][1]);if(!e[E[n][2]])t=false;n++}if(t)f.hr=e.re.on(\"single_push\",D)}catch(e){t=false}if(!t){if(f.hn===1)m(\"Bedienfeld unvollst\\xC3\\xA4ndig \\xE2\\x80\\x93 ohne Anzeige weiter\");return}f.h=e;V();if(f.hn>1)m(\"Bedienfeld verbunden\")}function D(e){try{i.pn=0;i.pc=0;i.kt=0;_();me(\"Pumpe auf Voreinstellung; anlernen: einstecken, 5\\xC3\\x97 dr\\xC3\\xBCcken\")}catch(e){m(\"Fehler Taster: \"+e)}}function J(){return f.ra>0?f.ra:8.6}function Z(){return f.au}function V(){var e=f.h?f.h.ra.getValue():null;f.ra=typeof e===\"number\"&&e>=1&&e<=40?e:0;f.au=!f.h||f.h.au.getValue()!==false}function G(e){return i.pu&&e.day<=i.pu}function I(e){return n[e-1]}function j(e){var n=3,t=11;return n<=t?e.m>=n&&e.m<=t:e.m>=n||e.m<=t}function q(e){var t=i.dp<0?0:c(e.day-1-i.dp,0,14),r=c(i.d-i.pi,0,25);return c(r+t*n[e.m-1]*.85,0,25)}function K(e){var n=J(),t=Math.round(e/n*3600),r=120*60;return t<r?t:r}function Q(e){var n=e?i.oa:i.ob;return n>-50?n:e?10:15}function X(e){var r=S(e).m,i=f.ty,u=1,l;if(i&&i.d===e&&i.n>=100){l=Q(1);u=c(1+.06*(i.mx-l-t[r-1]),.5,1.6)}return n[r-1]*u*1.21}function Y(){var e=[],n=[],t;i.xd=c(i.xd-i.xw[0],0,25)+i.xe[0];for(t=1;t<i.xe.length;t++){e.push(i.xe[t]);n.push(i.xw[t])}i.xe=e;i.xw=n;i.xa++}function $(e){var n,t,r,f=i.pi;if(i.xa<0&&i.dp+1<e.day){i.xd=i.d;i.xe=[];i.xw=[]}i.d=c(i.d-i.pi,0,25);i.pi=0;for(n=i.dp+1;n<e.day;n++){t=i.d;r=X(n);r=a(r*.85);i.d=c(i.d+r,0,25);if(i.xa<0)i.xa=n;r=a(i.d-t);i.xe.push(r);r=a(f);i.xw.push(r);f=0}while(i.xe.length>14)Y();i.dp=e.day-1}function ee(e,n){var t,r,i,u;if(n-f.ts<600)return;f.ts=n;t=f.sw;if(t.output||f.run||n-f.A<1800||t.tC===null)return;i=t.tC;u=f.td;if(!u||u.d!==e.day){f.ty=u&&u.d===e.day-1?u:null;u=f.td={d:e.day,n:0,mn:i,mx:i}}u.n++;if(f.est)u.x=1;if(i<u.mn)u.mn=i;if(i>u.mx)u.mx=i;if(f.est)ie(i,n);else f.z=null}function ne(e,n,t){var r=f.ty;var u,l;if(!r||r.x||r.d!==e.day-1||r.n<100||n===null||t===null)return;if(t-n<5||r.mx-r.mn<(t-n)/2)return;u=r.mn-n;l=r.mx-t;if(u>-5&&u<50)i.ob=i.ob>-50?a(i.ob+(u-i.ob)*.3):a(u);if(l>-5&&l<50)i.oa=i.oa>-50?a(i.oa+(l-i.oa)*.3):a(l)}function te(){var e=f.td,n=null;if(e&&e.n)n=e.mn;else if(f.sw.tC!==null)n=f.sw.tC;if(n===null)return null;return n-Q(0)-(e&&e.n>=36?0:5)}function re(){var e=f.sw,n=Shelly.getUptimeMs()/1e3,t,r;if(e.output||f.run||n-f.A<1800||e.tC===null)return null;t=Q(0);r=Q(1);return e.tC-Math.max(t,r)}function ie(e,n){var t=f.z;if(!t){f.z={s:-1,v:e,t:n,mv:e,mt:n,e:null};return}if(t.e&&n-t.e.t>10800)t.e=null;if(t.e&&e>=t.e.v+5){fe(t.e.t);t.e=null}if(t.s<0){if(e<t.v){t.v=e;t.t=n}else if(e>t.v+3){if(t.mv-t.v>=6&&t.t-t.mt>=21600)t.e={t:t.t,v:t.v};t.s=1;t.v=e;t.t=n}}else if(e>t.v){t.v=e;t.t=n}else if(e<t.v-3){t.mv=t.v;t.mt=t.t;t.s=-1;t.v=e;t.t=n}}function fe(e){var n=f.eb+e-f.eu,t=Math.floor(n/86400),r,u,l,a=null,o=Shelly.getUptimeMs()/1e3,s=[];if(!f.est||o-f.zf<72e3)return;s[0]=A(t-1);s[1]=A(t);s[2]=A(t+1);for(r=-1;r<=1;r++){u=(t+r)*86400+s[r+1]*60+600-n;if(f.def?u>-43200&&u<=43200:u>=-10800&&u<75600)a=u}if(a===null)return;u=a-3600;if((f.zn?Math.abs(u):f.def?Math.abs(a):a)<5400)return;l=Math.floor(f.eb+u+o-f.eu);Shelly.call(\"Sys.SetTime\",{unixtime:l},y,le);f.zf=o;f.zl=u;f.co=i.cs;f.cp=o;i.cs=l}function ue(e){if(f.oa){f.oa+=e;if(i.os>1)i.os=Math.floor(f.oa)}if(f.ie&&i.io)i.io=Math.floor(i.io+e)}function le(e,n,t){f.cp=0;if(n){i.cs=f.co;m(\"Uhr nicht stellbar: \"+t);return}f.eb+=f.zl;f.zn=1;f.cg++;ue(f.zl);_();m(\"Uhr nach Tagesgang um \"+s(f.zl/3600)+\" h gestellt\")}function ae(e,n){if(f.def&&n)je(k(e).day-k(n).day);if(!(Math.abs(e-n)<=60))f.cg++;if(n)ue(e-n);f.eb=e;f.eu=u();f.est=false;f.def=false;f.ie=false;i.ce=0;f.td=null;f.ty=null;_()}function oe(e){var n=[],t;for(t=0;t<f.starts.length;t++)if(e-f.starts[t]<3600)n.push(f.starts[t]);f.starts=n;return n.length}function se(e){var n=f.run;if(n){if(!n.why)n.why=e;n.ot=Shelly.getUptimeMs()/1e3}Shelly.call(\"Switch.Set\",{id:0,on:false},b)}function ce(e,n,t){var r=f.ps,u,l;if(!n)return;u=T();l=(\"Einschalten abgelehnt: \"+t).slice(0,60);f.ps=null;m(l);if(r&&r.k!==\"hand\")f.want={k:r.k,mm:r.mm,exp:r.exp||(u||0)+1800};if(i.ft!==l||!i.fo||!(u&&i.fu>1&&k(i.fu).day===k(u).day)){i.fu=u?Math.floor(u):1;i.ft=l;i.fo=1;Me(\"ab\",t);_()}}function he(e,n){var t=u(),r=f.sw;if(f.ps&&t>f.ps.B)f.ps=null;if(f.run||r.output||f.ps)return\"l\\xC3\\xA4uft\";if(f.weld)return\"Relais\";if(f.A&&t-f.A<120)return\"Pause\";if(oe(t)>=10)return\"Starts\";var i=K(n);if(i<60)return\"kurz\";Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:i},y,ce);f.ps={k:e,mm:i*J()/3600,sec:i,B:t+15};return null}function me(e){f.note=e;f.W=Shelly.getUptimeMs()/1e3;m(e)}function ge(e,n){var t=u(),r=f.ps,o=T(),s,h,g,p=0,y;f.ps=null;if(r&&(n||t<=r.B)){s=r.k;h=r.mm;g=r.sec}else{s=\"hand\";if(oe(t)>=10){me(\"Zu viele Starts in einer Stunde \\xE2\\x80\\x93 Pumpe gesch\\xC3\\xBCtzt\");f.starts.push(t);se(\"starts\");return}y=0;if(f.boot&&e.timer_duration)y=o&&e.timer_started_at>1767225600?c(o-e.timer_started_at,0,t):t;if(f.boot&&e.timer_duration&&e.timer_duration<7800){p=e.timer_duration-y;g=l(c(Math.min(p,120*60-y),1,e.timer_duration));if(g<p-5)Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:g},b);h=g*J()/3600}else{h=c(o?q(k(o)):6,6,15);g=l(c(Math.min(K(h),120*60-y),1,120*60));h=g*J()/3600;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:g},b)}f.want=null;if(i.rt){i.rt=0;_()}}f.starts.push(t);f.run={k:s,t0:t,lt:t,u0:o||0,sec:g,mm:h,ps:0,cr:0,ck:t,pf:-1,u:0,o:0,n:0,i:0,why:\"\",det:\"\"};m(\"Pumpe an (\"+s+\"), Ziel \"+a(h)+\" mm in \"+l(g/60)+\" min\")}function pe(e){var n=e.ps*J()/3600,t=n-e.cr;if(t>0){i.pi=i.pi+t;e.cr=n}}function be(e,n){f.run.why=e;f.run.det=n;m(\"Schutz: \"+e+\" (\"+n+\")\");se(e)}function ye(){return!i.pn?600:i.pc?(i.pn+i.pc)/2:i.pn*.75}function ve(){return i.pn?i.pn*1.3:2100}function Se(e){var n=f.run,t=u(),r=t-n.t0,i=c(t-n.lt,0,5);var a=e.apower||0,o=e.current||0,h=ye(),m=ve();n.lt=t;if(n.why){if(!(t-n.ot<5))se(n.why);return}if(r>n.sec+60){se(\"ende\");return}n.pf=n.pf<0?a:n.pf+(a-n.pf)*.3;n.i=r>=2&&o>10.5?n.i+1:0;if(n.i>=2){be(\"blockiert\",s(o)+\" A\");return}n.n=r>=3&&a<50?n.n+1:0;if(n.n>=5){be(\"keinStrom\",l(a)+\" W\");return}n.o=r>=40&&n.pf>m?n.o+1:0;if(n.o>=5){be(\"ueberlast\",l(n.pf)+\" W > \"+l(m)+\" W\");return}n.u=r>=40&&a>=50&&n.pf<h?n.u+1:0;if(n.u>=8){be(\"unterlast\",l(n.pf)+\" W < \"+l(h)+\" W\");return}if(n.pf>=h)n.ps+=i;if(t-n.ck>=3600){pe(n);_();n.ck=t}}var de={unterlast:\"Trockenlauf oder Hahn zu\",ueberlast:\"\\xC3\\x9Cberlast\",blockiert:\"Pumpe blockiert\",keinStrom:\"Pumpe zieht keinen Strom\",start:\"Pumpe lief nicht an\"};var ke={auto:\"Automatik\",retry:\"Nachlauf\",hand:\"Hand\",kal:\"Anlernen\"};var we={fw:\"Firmware-Schutz\",ab:\"Einschalten abgelehnt\",rk:\"Relais klebt\",ka:\"Anlernen abgebrochen\"};function Me(e,n){var t=T();f.fl=f.fl.slice(-4);f.fn=true;_();f.fl.push((t?String(Math.floor(t)):\"0000000000\")+(f.est?\"~\":\" \")+e+\":\"+String(n||\"\").slice(0,16))}function ze(e){var n=f.run,t=u(),r=T(),l=n.why,o=e.errors&&e.errors.length;f.run=null;f.A=t;pe(n);if(o&&(!de[l]||l===\"start\"))l=\"fw\";var c=l===\"fw\"||!!de[l],h=c&&l===\"fw\"?e.errors.join(\",\"):\"\";var g=c?h?\"Firmware-Schutz: \"+h:de[l]+(n.det?\" (\"+n.det+\")\":\"\"):\"\";if(c){i.fu=r?Math.floor(r):1;i.ft=g.slice(0,60);i.fo=1;Me(l,h||n.det)}else if(n.ps>=60&&(n.k!==\"kal\"||l===\"angelernt\"))i.fo=0;if(n.k===\"hand\"||n.k===\"kal\")i.sh++;else i.sa++;if(n.k===\"kal\"&&n.kp){if(!c){Me(\"ka\",\"ausgeschaltet\");i.fu=r?Math.floor(r):1;i.ft=\"Anlernen abgebrochen: ausgeschaltet\";i.fo=1}f.sv=-1e9;f.lx=1;me(\"Anlernen abgebrochen: \"+(g||\"ausgeschaltet\")+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\")}i.sm=a(i.sm+n.cr);if(c)i.sf++;if(r){var p=k(r),b=k(n.u0||r);i.lr=z(b.day)+\" \"+M(b.min)+\" \"+ke[n.k]+\" \"+s(n.cr)+\" mm\"+(c?\" \\xE2\\x80\\x93 abgebrochen\":\"\");if(c){if(i.fd!==p.day){i.fd=p.day;i.fc=0}i.fc++;var y=n.mm-n.cr,v=l===\"unterlast\"?2:1;i.rt=0;if((n.k===\"auto\"||n.k===\"retry\")&&y>=2&&i.fc<=v){i.rt=Math.floor(r)+(t-n.t0<10?6:60)*60;i.rm=a(y)}}}m(\"Pumpe aus: \"+(l||\"Ende/Stopp\")+\", \"+a(n.cr)+\" mm gegeben\");_()}function Ae(e){var n=u(),t=e.apower||0;if(f.A&&n-f.A<5)return;if(t>50){f.wc++;if(f.wc>=5){if(!f.weld){m(\"Relais klebt? \"+l(t)+\" W bei AUS\");Me(\"rk\",l(t)+\" W\");_()}f.weld=true;if(f.wc%30===5)Shelly.call(\"Switch.Set\",{id:0,on:false},b)}}else{f.wc=0;f.weld=false}}function Te(e){var n=e?e.delta:null;if(!n||e.component!==\"switch:0\"||typeof n.output!==\"boolean\"||n.output===f.ko)return;f.ko=n.output;if(u()>60||n.source===\"loopback\"||f.run&&f.run.why)return;f.kc++;f.kw=f.kc===5&&n.output?1:0}function We(){var e=f.run;f.kw=0;e.k=\"kal\";e.kp=1;e.kt=u();e.ks=0;e.kn=0;e.kl=1e9;e.kh=0;e.kn0=0;e.sec=300;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:300},b);me(\"Anlernen: Hahn offen lassen, gut 1 min nach dem 5. Druck zudrehen\")}function Pe(e){var n=f.run;n.ks+=e;n.kn++;if(e<n.kl)n.kl=e;if(e>n.kh)n.kh=e}function _e(e){var n=f.run,t=u(),r=t-n.kt,i=c(t-n.lt,0,5),a=e.apower||0,o=e.current||0,h=\"\";n.lt=t;if(n.why){if(!(t-n.ot<5))se(n.why);return}n.i=r>=2&&o>10.5?n.i+1:0;n.n=r>=3&&a<50?n.n+1:0;if(n.i>=2)be(\"blockiert\",s(o)+\" A\");else if(n.n>=5)be(\"keinStrom\",l(a)+\" W\");else if(n.kp===1){n.ps+=i;if(r>=45)Pe(a);if(r>=60)h=Fe()}else if(n.kp===2){n.kd=a<n.kn0*.92?n.kd+1:0;if(!n.kd)n.ps+=i;if(n.kd>=3){n.kp=3;n.kt=t;n.ks=0;n.kn=0;n.kl=1e9;n.kh=0}else if(r>=180)h=Ne(0)}else if(n.kp===3){if(r>=10)Pe(a);if(r>=20)h=Ne(1)}if(h)Ee(h,n.kx)}function Fe(){var e=f.run,n=e.kn?e.ks/e.kn:0;if(n<300)return l(n)+\" W zu wenig\";if(n>1900)return l(n)+\" W zu viel\";if(e.kh>e.kl*1.15)return\"unruhig \"+l(e.kl)+\"-\"+l(e.kh)+\" W, zu fr\\xC3\\xBCh zugedreht oder Luft im Rohr?\";e.kn0=l(n);e.kp=2;e.kd=0;m(\"Anlernen: Normalleistung \"+e.kn0+\" W, jetzt Hahn zudrehen\");return\"\"}function Ne(e){var n=f.run,t=T(),r=n.kn?n.ks/n.kn:0,u=1-r/n.kn0,a=\"\",o;if(!e)a=\"Hahn nicht zugedreht\";else if(n.kh>n.kl*1.1)a=\"Hahn zu unruhig\";else if(u<.2)a=\"Hahn zu nur \"+l(u*100)+\" % weniger, nicht erkennbar\";if(a&&n.kn0<600){n.kx=\"trocken? \"+n.kn0+\" W\";return a+\"; unter \"+600+\" W nur mit Zudrehen (Trockenlauf?)\"}i.pn=n.kn0;i.pc=a?0:l(r);i.kt=t?Math.floor(t):1;_();f.sv=-1e9;o=l(ye());a=(a?a+\", \":\"Hahn zu \"+i.pc+\" W, \")+\"Untergrenze \"+o+\" W\";n.kp=0;f.lx=1;me(\"Angelernt: \"+i.pn+\" W, \"+a);se(\"angelernt\");return\"\"}function Ee(e,n){var t=T();f.run.kp=0;Me(\"ka\",n||e);f.sv=-1e9;f.lx=1;i.fu=t?Math.floor(t):1;i.ft=(\"Anlernen abgebrochen: \"+e).slice(0,60);i.fo=1;me(\"Anlernen abgebrochen: \"+e+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\");se(\"abbruch\")}function He(e){return\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min,\"+\"temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=\"+e}function Oe(e,n,t){f.wx.busy=true;f.wx.L=e;f.wx.n=n;f.wx.rc=t;f.wx.t=u();f.wx.q++;f.wx.cg=f.cg;Shelly.call(\"HTTP.GET\",{url:He(n),timeout:20},Re,f.wx.q)}function Le(e){if(!j(e)){i.ev=e.day;i.d=0;i.pi=0;i.dp=e.day-1;i.rt=0;i.xa=-1;i.xe=[];i.xw=[];f.why=\"Winterpause\";_();return}if(i.dp<0||e.day-1-i.dp>14){i.d=0;i.pi=0;i.dp=e.day-1-(i.dp<0?0:14)}while(i.xe.length&&e.day-i.xa>14)Y();if(!i.xe.length)i.xa=-1;if(f.la===null){$(e);Ce(e,null,false);return}Oe(e,e.day-(i.xa>=0?i.xa:i.dp+1),false)}function Ue(e,n){return e&&typeof e[n]===\"number\"?e[n]:null}function xe(e,n,t){return{rain:Ue(e.precipitation_sum,n)||0,prob:Ue(e.precipitation_probability_max,n)||0,tmin:Ue(e.temperature_2m_min,n),tnow:t&&typeof t.temperature_2m===\"number\"?t.temperature_2m:null}}function Re(e,n,t,r){var u=f.wx.L,l=f.wx.rc,a=JSON.stringify(i);try{Be(e,n,t,r)}catch(e){m(\"Fehler Wetterantwort: \"+e);i=JSON.parse(a);f.wx.busy=true;f.wx.rc=l;try{Be(null,-1,\"Fehler\",r)}catch(e){m(\"Fehler Tagespr\\xC3\\xBCfung: \"+e);i=JSON.parse(a);f.wx.busy=false;f.wx.rc=false;if(u&&!l){i.ev=u.day;f.why=\"Fehler, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen\";_()}}}}function Be(e,n,t,r){var l=f.wx.L,a=f.wx.n,o=false,s=null,h=null,m,g,p,b,y,v;if(r!==f.wx.q||!f.wx.busy)return;f.wx.busy=false;if(f.wx.cg!==f.cg){if(f.wx.rc){f.wx.rc=false;f.rh=0}return}try{if(!n&&e&&e.code===200){s=JSON.parse(e.body);h=s.daily;o=h&&h.time&&h.time.length===a+1&&h.time[a]===w(l)}}catch(e){o=false}if(f.wx.rc){f.wx.rc=false;if(o)Ce(l,xe(h,a,s.current),true);else if(i.rc===l.day&&(i.rk===1||i.rk===3))Ce(l,null,true);return}if(!o){if(!f.oa)f.oa=T()||0;f.wx.T++;v=T();if(f.wx.T<(f.est||f.off?1:4)&&v&&k(v).min+21<750){f.wx.next=u()+1200;return}Ie(true);$(l);Ce(l,null,false);return}for(m=0;m<a;m++){g=l.day-a+m;p=Ue(h.et0_fao_evapotranspiration,m);b=Ue(h.precipitation_sum,m);if(p===null)p=I(S(g).m);if(b===null)b=0;y=p*.85-Math.max(0,b-1);if(g>i.dp){i.d=c(c(i.d-i.pi,0,25)+y,0,25);i.pi=0}else if(i.xa>=0&&g>=i.xa){if(g===i.xa)i.d=i.xd;i.d=c(c(i.d-(i.xw[g-i.xa]||0),0,25)+y,0,25)}}i.xa=-1;i.xe=[];i.xw=[];i.d=c(i.d-i.pi,0,25);i.pi=0;i.dp=l.day-1;f.nf=false;if(a>=1){b=Ue(h.precipitation_sum,a-1);f.nf=i.rd===l.day-1&&b!==null&&b-1<i.rx/2;ne(l,Ue(h.temperature_2m_min,a-1),Ue(h.temperature_2m_max,a-1))}Ie(false);Ce(l,xe(h,a,s.current),false)}function Ce(e,n,t){var r=q(e),u=0,l=0,o=T(),c=e.min,h=null,g=false,p,b,y,v,d,w,A,W,P,F,N,E,H,O,L=t&&i.rc===e.day?i.rk:0;if(o)c=k(o).min;f.wx.T=0;if(f.run){_();return}b=i.ev<0?null:S(i.ev);if(!b||!j(b)||e.day-i.ev>60){i.s0=e.day;i.sa=0;i.sh=0;i.sm=0;i.sf=0}i.ev=e.day;i.rc=-1;i.rk=0;if(L===1||L===3){h=i.rf;g=L===3}else if(n&&n.tmin!==null)h=n.tmin<5?n.tmin:null;else{h=te();if(h!==null){if(h>=5)h=null;else g=true}}p=n&&n.tnow!==null?n.tnow:re();y=s(r);v=h===null?\"\":s(h);d=n?s(n.rain):\"\";w=M(c);A=M(750);W=i.pu?z(i.pu):\"\";if(n&&n.prob>=60&&!f.nf)u=Math.max(0,n.rain-1);P=Math.min(15,r-u);F=u>0&&P<Math.min(15,r);N=K(P)*J()/3600;N=s(N);E=a(u);H=h===null?0:a(h);O=(Math.floor(c/60)+1)*60+5;if(!Z())f.why=\"Automatik aus\";else if(G(e))f.why=\"Pause bis \"+W;else if(r<8)f.why=\"nicht n\\xC3\\xB6tig (\"+y+\" mm)\";else if(h!==null&&!(p>=5)){f.why=\"Frostsperre (\"+(g?\"gesch\\xC3\\xA4tzt \":\"\")+v+\" \\xC2\\xB0C), gie\\xC3\\x9Ft ab \"+5+\" \\xC2\\xB0C\";i.rc=e.day;i.rk=g?3:1;i.rf=H;f.rh=O}else{l=P;if(F){i.rd=e.day;i.rx=E}else if(i.rd===e.day)i.rd=-1;if(l<5&&u>0){f.why=\"Regen erwartet (\"+d+\" mm, \"+n.prob+\" %)\"+(L===2?\", \"+w+\" best\\xC3\\xA4tigt\":\"\");i.rc=e.day;i.rk=2;f.rh=O}else if(l<5)f.why=\"nicht n\\xC3\\xB6tig (\"+y+\" mm)\";else if(c>=750){f.why=A+\" vorbei, nicht mehr gestartet\";l=0}else f.why=(L===2?\"Regen abgesagt, \":L?\"Frost vorbei, \":\"\")+\"gegossen \"+N+\" mm\"+(f.nf?\" (gestern Regen ausgeblieben)\":\"\")}m(\"Tagespr\\xC3\\xBCfung: Defizit \"+a(r)+\" mm\"+(n?\"\":\" (ohne Internet)\")+\" -> \"+f.why);if(l>=5)f.want={k:\"auto\",mm:l,exp:(o||0)+7200};_()}function selfTest(){if(f.la===null)return\"FEHLER Ort unbekannt: \"+e.l;if(!f.st){f.st=\"l\\xC3\\xA4uft\";Shelly.call(\"HTTP.GET\",{url:He(14),timeout:20},y,De)}return f.st===\"ok\"?\"ok, Ort \"+f.la+\" \"+f.lo:f.st}function De(e,n,t){var r=false;try{r=!n&&e.code===200&&JSON.parse(e.body).daily.time.length===15}catch(e){r=false}f.st=r?\"ok\":\"FEHLER \"+(t||\"Antwort\");m(\"Selbsttest Wetter: \"+f.st)}function Je(){var e=Shelly.getComponentStatus(\"sys\"),n=v(2026,4,1)*86400+600*60-(1+1)*3600;f.H=0;if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return;f.def=true;f.est=true;f.eb=n;f.eu=u();i.df=1;i.ce=1;i.cs=n;Shelly.call(\"Sys.SetTime\",{unixtime:n},b);m(\"Uhrzeit unbekannt \\xE2\\x80\\x93 Einstecken gilt als 1. April \"+M(600));_()}function Ze(){f.gn=u()+900;Shelly.call(\"HTTP.GET\",{url:\"https://geocoding-api.open-meteo.com/v1/search?count=1&name=\"+f.oq+\"&countryCode=\"+e.p,timeout:20},y,Ge)}function Ve(e){var n=\"\",t=0,r,i,f,u=\"0123456789ABCDEF\";while(t<e.length){r=e.charCodeAt(t);i=e.charCodeAt(t+1);f=-1;if(r>47&&r<58||r>64&&r<91||r>96&&r<123)n+=e.charAt(t);else if(r<128)n+=\"%\"+u.charAt(r>>4)+u.charAt(r&15);else if(r>193&&r<224&&i>127&&i<192){f=i;t++}else{f=128|r&63;r=192|r>>6}if(f>=0)n+=\"%\"+u.charAt(r>>4)+u.charAt(r&15)+\"%\"+u.charAt(f>>4)+u.charAt(f&15);t++}return n}function Ge(n,t,r){var u=null,l;try{if(!t&&n&&n.code===200)u=JSON.parse(n.body)}catch(e){u=null}if(!u)return;l=u.results&&u.results[0];if(!l){if(!f.gx)m(\"Ort \"+e.l+\" nicht gefunden \\xE2\\x80\\x93 Schreibweise pr\\xC3\\xBCfen oder LAT/LON eintragen\");f.gx=true;return}if(typeof l.latitude!==\"number\"||typeof l.longitude!==\"number\")return;f.gx=false;f.la=i.la=o(l.latitude);f.lo=i.lo=o(l.longitude);i.pz=e.p+e.l;_();m(\"Ort \"+e.l+\": \"+f.la+\", \"+f.lo)}function Ie(e){var n=T();if(e&&!f.oa)f.oa=n||0;if(e&&!f.off)f.O=u()+900;if(!e){if(f.off&&f.oa&&n){i.io=Math.floor(f.oa);i.id=Math.max(0,l((n-f.oa)/60));f.ie=f.est}f.oa=0}f.off=e;i.os=e?Math.floor(f.oa)||1:0}function je(e){if(i.ev>=0)i.ev+=e;if(i.dp>=0)i.dp+=e;if(i.fd>=0)i.fd+=e;if(i.pu)i.pu+=e;if(i.xa>=0)i.xa+=e;if(i.rd>=0)i.rd+=e;if(i.rc>=0)i.rc+=e;if(i.fu>1)i.fu+=e*86400;if(i.io&&!f.ie)i.io+=e*86400;if(i.s0>0)i.s0+=e;i.rt=0;i.df=0;f.td=null;f.ty=null;f.z=null;m(\"Echte Uhrzeit da: Tagesmarken um \"+e+\" Tage verschoben\")}function qe(){var e=f.kh;if(e>=0&&u()>62){f.kh=-1;f.kw=0;Shelly.removeStatusHandler(e)}if(f.H&&u()>=f.H)Je();if(u()>=f.cfgAt){f.cfgAt=u()+3600;gn();yn()}if(!f.h&&u()-f.hb>=(f.hn<10?60:3600))U();if(f.la===null&&u()>=f.gn)Ze();var n=T();if(!n)return;var t=k(n),r=u();if(f.est&&!(f.cp&&r-f.cp<60)&&(Math.abs(n-(f.eb+r-f.eu))>5||W())){ae(n,f.eb+r-f.eu)}if(i.ev>t.day||i.dp>t.day-1||i.pu>t.day+14){if(i.ev>t.day)i.ev=-1;if(i.dp>t.day-1)i.dp=t.day-1;if(i.pu>t.day+14)i.pu=0;i.rt=0;_()}if(n-i.t>=21600)_();ee(t,r);if(f.off&&f.la!==null&&!f.wx.busy&&r>=f.O){f.O=r+900;Shelly.call(\"HTTP.GET\",{url:\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=temperature_2m_min&timezone=auto&forecast_days=1\",timeout:10},y,Ke)}if(i.pu&&t.day>i.pu){i.pu=0;_()}if(f.run&&(f.run.k===\"auto\"||f.run.k===\"retry\")&&(!Z()||G(t)))se(\"aus\");var l=f.est&&r<600;if(!l&&i.ev!==t.day&&t.min>=600&&t.min<750&&!f.wx.busy&&r>=f.wx.next&&!f.run&&!f.ps){Le(t)}if(!l&&i.rc===t.day&&t.min>=f.rh&&t.min<750&&!f.wx.busy&&!f.run&&!f.ps){f.rh=(Math.floor(t.min/60)+1)*60+5;if(f.off||f.la===null)Ce(t,null,true);else Oe(t,0,true)}if(f.want&&!l){if(n>f.want.exp||!Z()||t.min>=750)f.want=null;else if(!he(f.want.k,f.want.mm)){f.ps.exp=f.want.exp;f.want=null}}if(i.rt&&n>=i.rt&&!f.run&&!l){if(t.min>=750||!Z()||G(t)||i.fd!==t.day){i.rt=0;_()}else if(!he(\"retry\",i.rm)){i.rt=0;_()}}}function Ke(e,n,t){if(!n&&e&&e.code===200&&f.off){Ie(false);_()}}function Qe(n){var t=[],r=M(600);if(!n)t.push(\"Uhrzeit unbekannt\");else if(f.def)t.push(\"Uhr angenommen: Einstecken = \"+r);else if(f.est)t.push(\"Uhr gesch\\xC3\\xA4tzt\");if(f.la===null)t.push(\"Ort \"+(f.gx?e.l+\" nicht gefunden\":\"unbekannt\"));else if(f.off)t.push(\"ohne Internet\");if(f.P)t.push(\"Speicher schreibt nicht\");return{e:f.weld?\"Relais klebt\":f.P?\"Speicher schreibt nicht\":i.fo?\"St\\xC3\\xB6rung: \"+i.ft:\"\",w:t}}function Xe(e){var n=f.run,t,r,u,l=i.fu>1?k(i.fu):null,a=i.rt?k(i.rt):null,o=Shelly.getUptimeMs()/1e3,c=M(600),m=M(750),g=i.pu?z(i.pu):\"\",p=l?M(l.min):\"\",b,y;if(f.weld)return\"ALARM: Pumpe zieht Strom trotz AUS \\xE2\\x80\\x93 Relais klebt? Stecker ziehen!\";if(n){t=n.sec-(o-n.t0);b=s(n.mm);y=Math.round(t/60);u=Math.round(f.sw.apower||0);if(n.k===\"kal\")return\"Anlernen: \"+(n.kp===1?\"Hahn offen lassen, Normalleistung messen\":n.kp===3?\"Hahn-zu-Leistung messen\":\"jetzt Hahn zudrehen\")+\", \"+u+\" W\";return\"Beregnung (\"+ke[n.k]+\"): \"+b+\" mm, noch \"+(y>0?y:0)+\" min, \"+u+\" W\"}if(!e)return\"Uhrzeit unbekannt \\xE2\\x80\\x93 Automatik wartet auf Internet. Taster geht.\";if(i.fo&&(!l||l.day===e.day)){y=a?M(a.min):\"\";t=\"St\\xC3\\xB6rung\"+(l?\" \"+p:\"\")+\": \"+i.ft;b=i.ev!==e.day&&e.min<750?\"heute \":\"morgen \";t+=a?\". Nachlauf \"+y:f.want?\". Neuer Versuch bis \"+m:\". N\\xC3\\xA4chster Versuch \"+b+c}else if(!j(e))t=\"Winterpause bis 01.\"+h(3)+\". \\xE2\\x80\\x93 Taster geht\";else if(!Z())t=\"Automatik aus \\xE2\\x80\\x93 Taster geht\";else if(G(e))t=\"Pause bis \"+g;else if(i.ev===e.day)t=\"Heute: \"+(f.why||\"gepr\\xC3\\xBCft\");else if(e.min<600)t=\"Bereit, Pr\\xC3\\xBCfung \"+c;else t=e.min<750?\"Pr\\xC3\\xBCfung l\\xC3\\xA4uft\":\"Heute nicht gepr\\xC3\\xBCft, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen \"+c;if(i.fo&&l&&l.day!==e.day){b=z(l.day);t+=\" \\xC2\\xB7 St\\xC3\\xB6rung \"+b+\" \"+p+\": \"+i.ft}u=Qe(e).w;for(r=0;r<u.length;r++)t+=\" \\xC2\\xB7 \"+u[r];if(i.lr)t+=\" \\xC2\\xB7 Zuletzt \"+i.lr;if(f.note&&o-f.W>43200)f.note=\"\";if(f.note)t+=\" \\xC2\\xB7 \"+f.note;else if(i.pn)t+=\" \\xC2\\xB7 Pumpe angelernt \"+i.pn+\" W\";while(t.length>230&&t.lastIndexOf(\" \\xC2\\xB7 \")>0)t=t.slice(0,t.lastIndexOf(\" \\xC2\\xB7 \"));return t.length>230?t.slice(0,230):t}function Ye(){var e=T(),n=e?k(e):null,t;rn(n);if(!f.h)return;try{for(t in f.h)if(t!==\"re\"&&f.hl<3&&typeof f.h[t].getStatus===\"function\"&&f.h[t].getStatus()===undefined)throw\"fehlt \"+t;$e(n)}catch(e){m(\"Bedienfeld neu: \"+e);f.hl++;try{f.h.re.off(f.hr)}catch(e){}f.h=null;f.hn=0;f.hb=0;f._=-1;f.F=\"\";f.N=-1;V()}}function $e(e){var n,t,r,u;V();r=f.h.pa.getValue();if(e&&typeof r===\"number\"&&f._>=0&&r!==f._){i.pu=r>0?e.day+l(r)-1:0;i.rt=0;f.want=null;_();u=r>0?z(i.pu):\"\";m(\"Pause \"+(r>0?\"bis \"+u:\"aufgehoben\"))}t=e&&G(e)?i.pu-e.day+1:0;if(t!==f._){f.h.pa.setValue(t);f._=t}n=Xe(e);if(n!==f.F){f.h.st.setValue(n);f.F=n}t=e?a(q(e)):0;if(t!==f.N){f.h.bk.setValue(t);f.N=t}}function en(e,n){return e&&n&&e[0]===n[0]&&e[1]===n[1]&&e[2]===n[2]}function nn(){var e=Shelly.getComponentConfig(\"plugs_ui\"),n,t;f.led=\"?\";if(!e||!e.leds||e.leds.mode!==\"switch\"||!e.leds.colors||!e.leds.colors[\"switch:0\"])return;n=e.leds.colors[\"switch:0\"].off;for(t in r)if(t!==\"run\"&&n&&en(n.rgb,r[t])&&n.brightness===100)f.led=t}function tn(e){return e.e?\"err\":e.w.length?\"warn\":\"ok\"}function rn(e){var n=tn(Qe(e)),t=u(),i=[],l;if(n!==f.U){f.U=n;f.R=t}if(n===f.led){f.lx=0;return}if(!f.lx&&t-f.R<(n===\"err\"||f.led===\"?\"?120:1800))return;for(l=0;l<f.ledN.length;l++)if(t-f.ledN[l]<86400)i.push(f.ledN[l]);f.ledN=i;if(i.length>=12&&n!==\"err\")return;Shelly.call(\"PLUGS_UI.SetConfig\",{config:{leds:{mode:\"switch\",colors:{\"switch:0\":{on:{rgb:r.run,brightness:100},off:{rgb:r[n],brightness:100}}}}}},y,fn);f.led=n;f.ledN.push(t);f.nl++;f.lx=0}function fn(e,n,t){if(n){m(\"LED nicht gesetzt: \"+t);f.led=\"?\";f.R=u()+3480}}function un(e){var n=k(e);return z(n.day)+n.y+\" \"+M(n.min)}function ln(){try{var e=Shelly.getDeviceInfo();return e&&e.ver||\"?\"}catch(e){return\"?\"}}function an(e){var n=Math.round(e/60),t=Math.round(n/60),r=Math.round(n/1440);return n<120?n+\" min\":n<2880?t+\" h\":r+\" Tage\"}var on={ok:\"gr\\xC3\\xBCn\",warn:\"gelb\",err:\"rot\"};function info(){var n=T(),t=n?k(n):null,r=Qe(t),u=Shelly.getUptimeMs()/1e3,a,o,c,h=tn(r),m=Xe(t),g=r.w.join(\", \"),p=n?un(n):\"\\xE2\\x80\\x93 Uhrzeit unbekannt\",b=i.fu>1?un(i.fu)+\" \":\"\",y=i.s0>0?z(i.s0):\"-\",v=s(i.sm),S=t?q(t):i.d,d=i.ob>-50?s(i.ob):\"-\",w=i.oa>-50?s(i.oa):\"-\",M=f.off&&f.oa?un(f.oa):\"\",A=i.io?un(i.io):\"\",W=i.io?an(i.id*60):\"\",P=ln(),_=n?un(n-u):\"?\",F=an(u),N=f.t0>1767225600?un(f.t0):\"\",E=an(u-f.s0),H=l(ye()),O=l(ve()),L=i.kt>1?\" \"+un(i.kt):\"\";S=s(S);c=\"Bew\\xC3\\xA4sserung \"+p+\"\\n\\nStatus: \"+m+\"\\nLED: \"+(on[f.led]||\"noch nicht gesetzt\")+(h!==f.led?\", wechselt bald auf \"+on[h]:\"\")+\" \\xE2\\x80\\x93 \"+(r.e||g||\"alles in Ordnung\")+\"\\nLetzte St\\xC3\\xB6rung: \"+(i.ft?b+i.ft+(i.fo?\" (offen)\":\" (erledigt)\"):\"keine\")+\"\\nLetzter Lauf: \"+(i.lr||\"keiner\")+\"\\nSaison seit \"+y+\": Automatik \"+i.sa+\", Hand \"+i.sh+\", zusammen \"+v+\" mm, St\\xC3\\xB6rungen \"+i.sf+\"\\nPumpe: \"+(i.pn?\"angelernt\"+L+\", normal \"+i.pn+\" W, Hahn zu \"+(i.pc?i.pc+\" W\":i.kt?\"nicht erkannt\":\"nicht gemessen\"):\"Voreinstellung, nicht angelernt\")+\"; Untergrenze \"+H+\" W, Obergrenze \"+O+\" W\"+\"\\nBodenkonto \"+S+\" mm, Eigenw\\xC3\\xA4rme F\\xC3\\xBChler Nacht/Tag \"+d+\" / \"+w+\" K\"+\"\\nUhr: \"+(!n?\"unbekannt\":f.def?\"angenommen\":f.est?\"gesch\\xC3\\xA4tzt\":\"Zeitserver\")+\"\\nInternet: \"+(f.off?\"Wetterdienst fehlt\"+(f.oa?\" seit \"+M:\"\"):f.la===null?\"ohne Ort kein Wetterabruf\":\"ok\")+(i.io?\", letzter Ausfall \"+A+\", \"+W:\"\")+\"\\nOrt: \"+e.l+(f.la===null?f.gx?\" nicht gefunden\":\" noch unbekannt\":\" \"+f.la+\", \"+f.lo)+\"\\nGer\\xC3\\xA4t: Firmware \"+P+\", an seit \"+_+\" (\"+F+\")\"+(f.t0>1767225600?\", davor zuletzt gespeichert \"+N:\"\")+\"; Skript l\\xC3\\xA4uft seit \"+E+\"\\nFlash-Schreibvorg\\xC3\\xA4nge seit Skriptstart: Speicher \"+f.nw+\", Einstellungen \"+f.nc+\", LED \"+f.nl+\"\\n\\nSt\\xC3\\xB6rungen (gespeichert, neueste zuerst):\"+(f.fl.length?\"\":\" keine\");a=f.fl.length-1;while(a>=0){c+=sn(f.fl[a]);a--}c+=\"\\n\\nLetzte Meldungen (seit Skriptstart):\";o=f.lg.length;a=1;while(a<=o){c+=cn(f.lg[(f.li-a+o)%o]);a++}return c}function sn(e){var n=Number(e.slice(0,10)),t=e.indexOf(\":\"),r=e.slice(11,t),i=e.slice(t+1),f=n>1?un(n):\"\";return\"\\n\"+(f?(e.charAt(10)===\"~\"?\"~\":\"\")+f:\"Zeit unbekannt\")+\" \"+(de[r]||we[r]||r)+(i?\" (\"+i+\")\":\"\")}function cn(e){var n=Number(e.slice(0,10)),t=n?k(n):null,r=t?z(t.day):\"\",i=t?M(t.min):\"\";return\"\\n\"+(t?r+(e.charAt(10)===\"~\"?\" ~\":\" \")+i:\"--.-- --:--\")+\" \"+e.slice(11)}function hn(e,n){try{n.body=info();n.code=200}catch(e){n.body=\"Fehler: \"+e;n.code=500}try{n.headers=[[\"Content-Type\",\"text/plain; charset=utf-8\"]];n.send()}catch(e){m(\"Diagnose-Seite: \"+e)}}function mn(){var e;f.k++;try{e=g();p(e);f.u=T()||0;if(f.kw&&f.run&&f.run.k===\"hand\"&&e.output)We();if(e.output&&!f.run)ge(e);else if(!e.output&&f.run)ze(e);else if(e.output&&f.run&&f.run.k===\"kal\")_e(e);else if(e.output&&f.run)Se(e);else if(f.ps&&u()>f.ps.B){ge(e,1);f.run.why=\"start\";ze(e)}if(!e.output)Ae(e);f.boot=false}catch(e){m(\"Fehler Takt: \"+e)}if(f.k%30===1&&f.wx.busy&&u()-f.wx.t>60)Re(null,-1,\"keine Antwort\",f.wx.q);if(f.k%30===1){try{qe()}catch(e){m(\"Fehler Plan: \"+e)}}if(f.k%10===2){try{Ye()}catch(e){m(\"Fehler Anzeige: \"+e)}}try{F()}catch(e){m(\"Fehler Speicher: \"+e)}}function gn(){var e=Shelly.getComponentConfig(\"switch\",0)||{},n={},t=false;if(e.initial_state!==\"off\"){n.initial_state=\"off\";t=true}if(e.auto_off!==true){n.auto_off=true;t=true}if(e.auto_off_delay!==7800){n.auto_off_delay=7800;t=true}if(e.auto_on===true){n.auto_on=false;t=true}if(e.autorecover_voltage_errors===true){n.autorecover_voltage_errors=false;t=true}if(e.name!==\"Brunnenpumpe\"){n.name=\"Brunnenpumpe\";t=true}if(t){Shelly.call(\"Switch.SetConfig\",{id:0,config:n},b);f.nc++;m(\"Relais-Sicherung nachgestellt\")}}var pn=\"0 */5 * * * *\";var bn=\"0 23 3 * * *\";function yn(e){f.sn=e||0;Shelly.call(\"Schedule.List\",{},y,vn)}function vn(e,n,t){var r=e&&e.jobs||[],i,f,u,l,a=null,o=false;if(n){m(\"Zeitplan nicht lesbar: \"+t);return}for(i=0;i<r.length;i++){u=r[i].calls||[];for(f=0;f<u.length;f++){l=u[f]?String(u[f].method).toLowerCase():\"\";if(l===\"script.start\"&&u[f].params&&u[f].params.id===Script.id)a=r[i];if(l===\"shelly.update\")o=true}}if(!a){if(N(\"Schedule.Create\",{enable:true,timespec:pn,calls:[{method:\"Script.Start\",params:{id:Script.id}}]},Sn)){m(\"W\\xC3\\xA4chter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht\")}}else if(a.enable!==true||a.timespec!==pn){N(\"Schedule.Update\",{id:a.id,enable:true,timespec:pn},Sn)}else if(!o){if(N(\"Schedule.Create\",{enable:true,timespec:bn,calls:[{method:\"Shelly.Update\",params:{stage:\"stable\"}}]},Sn)){m(\"Firmware-Update angelegt: t\\xC3\\xA4glich 03:23 die neueste stabile\")}}}function Sn(e,n,t){if(n)m(\"Zeitplan nicht gesetzt: \"+t);else if(f.sn<2)yn(f.sn+1)}function dn(){p(g());f.u=T()||0;f.oq=Ve(e.l);if(typeof e.S===\"number\"&&typeof e.M===\"number\"){f.la=e.S;f.lo=e.M}else if(i.la!==null){f.la=i.la;f.lo=i.lo}f.t0=i.t;f.s0=u();if(i.os){f.off=true;f.oa=i.os>1?i.os:0}var n=Shelly.getComponentStatus(\"sys\"),t=u();if(i.wu>0&&t>=i.wu){f.sv=i.wu;f.wn=i.wn;f.w24=Math.min(i.wb,t)}if(n&&typeof n.unixtime===\"number\"&&n.unixtime>1767225600&&(!i.ce||t<i.tu||W())){if(i.ce||i.df){if(i.df===1)je(k(n.unixtime).day-k(i.t).day);i.ce=0;_()}}else if(i.t>1767225600){f.eb=i.t+(t>=i.tu?t-i.tu:t);f.eu=t;f.est=true;f.def=i.df===1;f.u=T()||0;if(i.ce!==1||t<i.tu||!(n&&n.unixtime>1767225600)){i.ce=1;i.cs=Math.floor(f.eb);Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},b);m(\"Uhr aus Zeitanker gesch\\xC3\\xA4tzt\");_()}}else f.H=t+120;gn();yn();f.cfgAt=t+3600;nn();try{HTTPServer.registerEndpoint(\"info\",hn)}catch(e){m(\"Diagnose-Seite fehlt: \"+e)}if(u()<60){try{f.ko=!!g().output;f.kc=f.ko?1:0;f.kh=Shelly.addStatusHandler(Te)}catch(e){m(\"Anlern-Geste fehlt: \"+e)}}}function kn(){P();try{dn()}catch(e){m(\"Fehler Start: \"+e)}try{U()}catch(e){m(\"Fehler Bedienfeld: \"+e)}Timer.set(1e3,true,mn);m(\"gestartet, Bodenkonto \"+a(i.d)+\" mm, Pumpe \"+(i.pn?\"angelernt \"+i.pn+\" W\":\"Voreinstellung\"))}kn();";
window.__bw = { fertig: false, log: [] };
deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })
  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })
  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });
return "Aufspielen gestartet, 35297 Byte";
})();
