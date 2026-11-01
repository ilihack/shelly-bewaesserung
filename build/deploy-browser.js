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

var CODE = "var e={l:\"Ludwigshafen am Rhein\",p:\"DE\",S:null,M:null};var t=[.6,.9,1.6,2.6,3.5,4.5,4.4,3.8,2.4,1.1,.5,.5];var n=[6.1,9.3,13,17,21.1,26.3,27.4,27.4,22.8,16.7,9.6,6.8];var r={ok:[0,100,0],warn:[100,70,0],err:[100,0,0],run:[0,0,100]};var i=null;var f={k:0,u:0,sw:{output:false,apower:0,tC:null},ra:0,au:true,oq:\"\",eb:0,eu:0,est:false,run:null,ps:null,want:null,starts:[],T:0,wc:0,weld:false,wx:{busy:false,next:0,A:0,L:null,n:0,rc:false,t:0,q:0,cg:0},off:false,oa:0,ie:false,sv:-1e9,sd:false,wn:0,w24:0,cn:0,c24:0,why:\"\",note:\"\",W:0,P:false,h:null,_:-1,N:\"\",F:-1,boot:true,def:false,O:0,kh:-1,kc:0,k0:0,ko:false,kw:0,H:0,cfgAt:0,sn:0,cg:0,hb:0,hn:0,hr:0,hl:0,led:\"\",U:\"\",R:0,ledN:[],td:null,ty:null,ts:-1e9,z:null,zf:-1e9,zl:0,zn:0,cp:0,co:0,rh:0,nf:false,la:null,lo:null,gn:0,gx:false,st:\"\",lg:[],li:0,t0:0,s0:0,fl:[],fn:false,nw:0,nc:0,nl:0};function u(){return Shelly.getUptimeMs()/1e3}function l(e){return Math.round(e)}function a(e){return Math.round(e*10)/10}function o(e){return Math.round(e*100)/100}function s(e){var t=Math.round(e*10)/10;return String(t).replace(\".\",\",\")}function c(e,t,n){return e<t?t:e>n?n:e}function h(e){return(e<10?\"0\":\"\")+e}function m(e){var t=f.u>1e9?Math.floor(f.u):0;e=String(e);print(\"[BW] \"+e);t=(t?String(t):\"0000000000\")+(f.est?\"~\":\" \")+e.slice(0,80);if(f.lg.length<6)f.lg.push(t);else f.lg[f.li]=t;f.li=(f.li+1)%6}function g(){return Shelly.getComponentStatus(\"switch\",0)||{}}function p(e){var t=e.temperature;f.sw.output=!!e.output;f.sw.apower=e.apower||0;f.sw.tC=t&&typeof t.tC===\"number\"?t.tC:null}function b(e,t,n){if(t)m(\"RPC-Fehler \"+t+\" \"+n)}function y(e,t,n,r){try{r(e,t,n)}catch(e){m(\"Fehler im R\\xC3\\xBCckruf: \"+e)}}function v(e,t,n){e-=t<=2?1:0;var r=e/400|0,i=e-r*400;var f=((153*(t+(t>2?-3:9))+2)/5|0)+n-1;var u=i*365+(i/4|0)-(i/100|0)+f;return r*146097+u-719468}function S(e){e+=719468;var t=e/146097|0,n=e-t*146097;var r=(n-(n/1460|0)+(n/36524|0)-(n/146096|0))/365|0;var i=n-(365*r+(r/4|0)-(r/100|0));var f=(5*i+2)/153|0;var u=f<10?f+3:f-9;return{y:r+t*400+(u<=2?1:0),m:u,d:i-((153*f+2)/5|0)+1}}function d(e){var t=1970+(e/31556952|0),n=v(t,4,1)-1,r=v(t,11,1)-1;n=(n-(n+4)%7)*86400+3600;r=(r-(r+4)%7)*86400+3600;return(1+(e>=n&&e<r?1:0))*3600}function k(e){var t=e+d(e),n=t/86400|0,r=S(n);return{day:n,min:(t-n*86400)/60|0,y:r.y,m:r.m,d:r.d}}function w(e){return e.y+\"-\"+h(e.m)+\"-\"+h(e.d)}function M(e){return h(e/60|0)+\":\"+h(e%60)}function z(e){var t=S(e);return h(t.d)+\".\"+h(t.m)+\".\"}function T(e){var t=S(e),n=v(t.y,1,1),r=2*Math.PI/365*(e-n);var i=Math.cos(r),u=Math.sin(r),l=Math.cos(2*r),a=Math.sin(2*r);var o=229.18*(75e-6+.001868*i-.032077*u-.014615*l-.040849*a);var s=.006918-.399912*i+.070257*u-.006758*l+907e-6*a;var c=(f.la===null?50:f.la)*Math.PI/180;var h=Math.cos(c),m=Math.cos(s),g=Math.tan(c),p=Math.tan(s),b=Math.cos(1.58534);var y=Math.acos(b/(h*m)-g*p);return 720-4*((f.lo===null?15*1:f.lo)+y*180/Math.PI)-o}function A(){var e=Shelly.getComponentStatus(\"sys\"),t=Shelly.getUptimeMs();if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return e.unixtime;return f.eb?f.eb+t/1e3-f.eu:null}function W(){var e=Shelly.getComponentStatus(\"sys\");return!!e&&typeof e.last_sync_ts===\"number\"&&Math.abs(e.last_sync_ts-i.cs)>5}function P(){var t=null;try{t=JSON.parse(Script.storage.getItem(\"s\"))}catch(e){t=null}if(!t||t.v!==1)t={v:1};if(typeof t.t!==\"number\")t.t=0;if(typeof t.d!==\"number\"||!(t.d>=0&&t.d<=25))t.d=0;if(typeof t.dp!==\"number\")t.dp=-1;if(typeof t.pi!==\"number\"||!(t.pi>=0))t.pi=0;if(typeof t.ev!==\"number\")t.ev=-1;if(typeof t.pn!==\"number\")t.pn=0;if(typeof t.pc!==\"number\")t.pc=0;if(typeof t.kt!==\"number\")t.kt=0;if(typeof t.pu!==\"number\")t.pu=0;if(typeof t.fd!==\"number\")t.fd=-1;if(typeof t.fc!==\"number\")t.fc=0;if(typeof t.rt!==\"number\")t.rt=0;if(typeof t.rm!==\"number\")t.rm=0;if(typeof t.lr!==\"string\")t.lr=\"\";if(typeof t.xa!==\"number\")t.xa=-1;if(!t.xe||typeof t.xe.length!==\"number\")t.xe=[];if(!t.xw||typeof t.xw.length!==\"number\"||t.xw.length!==t.xe.length){t.xw=[];t.xe=[];t.xa=-1}if(typeof t.xd!==\"number\")t.xd=0;if(typeof t.ob!==\"number\")t.ob=-99;if(typeof t.oa!==\"number\")t.oa=-99;if(typeof t.df!==\"number\")t.df=0;if(typeof t.rd!==\"number\")t.rd=-1;if(typeof t.rx!==\"number\")t.rx=0;if(typeof t.rc!==\"number\")t.rc=-1;if(typeof t.rk!==\"number\")t.rk=0;if(typeof t.rf!==\"number\")t.rf=0;if(typeof t.tu!==\"number\")t.tu=0;if(typeof t.ce!==\"number\")t.ce=0;if(typeof t.cs!==\"number\")t.cs=0;if(typeof t.fu!==\"number\")t.fu=0;if(typeof t.ft!==\"string\")t.ft=\"\";if(typeof t.fo!==\"number\")t.fo=t.fu?1:0;if(typeof t.s0!==\"number\")t.s0=0;if(typeof t.sa!==\"number\")t.sa=0;if(typeof t.sh!==\"number\")t.sh=0;if(typeof t.sm!==\"number\")t.sm=0;if(typeof t.sf!==\"number\")t.sf=0;if(typeof t.io!==\"number\")t.io=0;if(typeof t.id!==\"number\")t.id=0;if(typeof t.os!==\"number\")t.os=0;if(typeof t.wu!==\"number\")t.wu=0;if(typeof t.wn!==\"number\")t.wn=0;if(typeof t.wb!==\"number\")t.wb=0;if(t.pz!==e.p+e.l||typeof t.la!==\"number\"||typeof t.lo!==\"number\"){t.la=null;t.lo=null;t.pz=\"\"}i=t;try{t=JSON.parse(Script.storage.getItem(\"f\"))}catch(e){t=null}f.fl=t&&typeof t.length===\"number\"?t:[]}function _(){f.sd=true}function N(){var e=u(),t;if(!f.sd)return;if(e-f.w24>=86400){f.w24=e;f.wn=0}if(e-f.sv<(f.wn>=48?3600:60))return;t=A();if(t){i.t=Math.floor(t);i.tu=Math.floor(e)}i.d=o(i.d);i.pi=o(i.pi);i.wu=Math.floor(e);i.wn=f.wn+1;i.wb=Math.floor(f.w24);try{Script.storage.setItem(\"s\",JSON.stringify(i));f.P=false;f.sd=false;f.nw++;if(f.fn){Script.storage.setItem(\"f\",JSON.stringify(f.fl));f.fn=false;f.nw++}}catch(e){f.P=true}f.sv=e;f.wn++}function F(e,t,n){var r=Shelly.getUptimeMs()/1e3;if(r-f.c24>=86400){f.c24=r;f.cn=0}if(f.cn===30)m(\"Schreibbremse Einstellungen: \"+e);if(f.cn>=30){f.cn++;return false}Shelly.call(e,t,y,n);f.cn++;f.nc++;return true}var O=[[\"text\",200,\"st\"],[\"number\",200,\"bk\"],[\"boolean\",200,\"au\"],[\"number\",201,\"pa\"],[\"number\",202,\"ra\"],[\"button\",200,\"re\"]];function E(e){if(e===0)return{name:\"Status\",default_value:\"\",persisted:false,max_len:255,meta:{ui:{view:\"label\"}}};if(e===1)return{name:\"Wasserdefizit\",default_value:0,persisted:false,min:0,max:25,meta:{ui:{view:\"progressbar\",unit:\"mm\",step:.1}}};if(e===2)return{name:\"Automatik\",default_value:true,persisted:true,meta:{ui:{view:\"toggle\",titles:[\"Aus\",\"An\"]}}};if(e===3)return{name:\"Pause\",default_value:0,persisted:false,min:0,max:14,meta:{ui:{view:\"field\",unit:\"Tage\",step:1}}};if(e===4)return{name:\"Regenrate\",default_value:8.6,persisted:true,min:1,max:40,meta:{ui:{view:\"field\",unit:\"mm/h\",step:.1}}};return{name:\"Pumpe neu einlernen\",meta:{ui:{view:\"button\"}}}}var H=0;function L(){var e;while(H<O.length&&Shelly.getComponentConfig(O[H][0],O[H][1]))H++;if(H<O.length){e=E(H);F(\"Virtual.Add\",{type:O[H][0],id:O[H][1],config:e},x);return}if(!Shelly.getComponentConfig(\"group\",200)){F(\"Virtual.Add\",{type:\"group\",id:200,config:{name:\"Bew\\xC3\\xA4sserung\",meta:{ui:{view:\"group\"}}}},R);return}B();J()}function U(){f.hb=u();f.hn++;H=0;L()}function x(e,t,n){if(t)m(\"Bedienfeld \"+O[H][2]+\": \"+n);H++;L()}function R(e,t,n){B();J()}function B(){var e=[],t,n=Shelly.getComponentStatus(\"group\",200),r,i;for(t=0;t<O.length;t++)e.push(O[t][0]+\":\"+O[t][1]);r=n?JSON.stringify(n.value):\"\";i=JSON.stringify(e);if(r!==i)F(\"Group.Set\",{id:200,value:e},b)}function J(){var e={},t,n=true;if(f.h)return;try{t=0;while(t<O.length){e[O[t][2]]=Virtual.getHandle(O[t][0]+\":\"+O[t][1]);if(!e[O[t][2]])n=false;t++}if(n)f.hr=e.re.on(\"single_push\",C)}catch(e){n=false}if(!n){if(f.hn===1)m(\"Bedienfeld unvollst\\xC3\\xA4ndig \\xE2\\x80\\x93 ohne Anzeige weiter\");return}f.h=e;G();if(f.hn>1)m(\"Bedienfeld verbunden\")}function C(e){try{i.pn=0;i.pc=0;i.kt=0;_();me(\"Pumpe auf Voreinstellung; anlernen: einstecken, 5\\xC3\\x97 dr\\xC3\\xBCcken\")}catch(e){m(\"Fehler Taster: \"+e)}}function Z(){return f.ra>0?f.ra:8.6}function D(){return f.au}function G(){var e=f.h?f.h.ra.getValue():null;f.ra=typeof e===\"number\"&&e>=1&&e<=40?e:0;f.au=!f.h||f.h.au.getValue()!==false}function V(e){return i.pu&&e.day<=i.pu}function I(e){return t[e-1]}function j(e){var t=3,n=11;return t<=n?e.m>=t&&e.m<=n:e.m>=t||e.m<=n}function q(e){var n=i.dp<0?0:c(e.day-1-i.dp,0,14),r=c(i.d-i.pi,0,25);return c(r+n*t[e.m-1]*.85,0,25)}function K(e){var t=Z(),n=Math.round(e/t*3600),r=120*60;return n<r?n:r}function Q(e){var t=e?i.oa:i.ob;return t>-50?t:e?10:15}function X(e){var r=S(e).m,i=f.ty,u=1,l;if(i&&i.d===e&&i.n>=100){l=Q(1);u=c(1+.06*(i.mx-l-n[r-1]),.5,1.6)}return t[r-1]*u*1.21}function Y(){var e=[],t=[],n;i.xd=c(i.xd-i.xw[0],0,25)+i.xe[0];for(n=1;n<i.xe.length;n++){e.push(i.xe[n]);t.push(i.xw[n])}i.xe=e;i.xw=t;i.xa++}function $(e){var t,n,r,f=i.pi;if(i.xa<0&&i.dp+1<e.day){i.xd=i.d;i.xe=[];i.xw=[]}i.d=c(i.d-i.pi,0,25);i.pi=0;for(t=i.dp+1;t<e.day;t++){n=i.d;r=X(t);r=a(r*.85);i.d=c(i.d+r,0,25);if(i.xa<0)i.xa=t;r=a(i.d-n);i.xe.push(r);r=a(f);i.xw.push(r);f=0}while(i.xe.length>14)Y();i.dp=e.day-1}function ee(e,t){var n,r,i,u;if(t-f.ts<600)return;f.ts=t;n=f.sw;if(n.output||f.run||t-f.T<1800||n.tC===null)return;i=n.tC;u=f.td;if(!u||u.d!==e.day){f.ty=u&&u.d===e.day-1?u:null;u=f.td={d:e.day,n:0,mn:i,mx:i}}u.n++;if(f.est)u.x=1;if(i<u.mn)u.mn=i;if(i>u.mx)u.mx=i;if(f.est)ie(i,t);else f.z=null}function te(e,t,n){var r=f.ty;var u,l;if(!r||r.x||r.d!==e.day-1||r.n<100||t===null||n===null)return;u=r.mn-t;l=r.mx-n;if(u>-5&&u<50)i.ob=i.ob>-50?a(i.ob+(u-i.ob)*.3):a(u);if(l>-5&&l<50)i.oa=i.oa>-50?a(i.oa+(l-i.oa)*.3):a(l)}function ne(){var e=f.td,t=null;if(e&&e.n)t=e.mn;else if(f.sw.tC!==null)t=f.sw.tC;if(t===null)return null;return t-Q(0)-(e&&e.n>=36?0:5)}function re(){var e=f.sw,t=Shelly.getUptimeMs()/1e3,n,r;if(i.oa<-50||e.output||f.run||t-f.T<1800||e.tC===null)return null;n=Q(0);r=Q(1);return e.tC-Math.max(n,r)}function ie(e,t){var n=f.z;if(!n){f.z={s:-1,v:e,t:t,mv:e,mt:t,e:null};return}if(n.e&&t-n.e.t>10800)n.e=null;if(n.e&&e>=n.e.v+5){fe(n.e.t);n.e=null}if(n.s<0){if(e<n.v){n.v=e;n.t=t}else if(e>n.v+3){if(n.mv-n.v>=6&&n.t-n.mt>=21600)n.e={t:n.t,v:n.v};n.s=1;n.v=e;n.t=t}}else if(e>n.v){n.v=e;n.t=t}else if(e<n.v-3){n.mv=n.v;n.mt=n.t;n.s=-1;n.v=e;n.t=t}}function fe(e){var t=f.eb+e-f.eu,n=Math.floor(t/86400),r,u,l,a=null,o=Shelly.getUptimeMs()/1e3,s=[];if(!f.est||o-f.zf<72e3)return;s[0]=T(n-1);s[1]=T(n);s[2]=T(n+1);for(r=-1;r<=1;r++){u=(n+r)*86400+s[r+1]*60+600-t;if(f.def?u>-43200&&u<=43200:u>=-10800&&u<75600)a=u}if(a===null)return;u=a-3600;if((f.zn?Math.abs(u):f.def?Math.abs(a):a)<5400)return;l=Math.floor(f.eb+u+o-f.eu);Shelly.call(\"Sys.SetTime\",{unixtime:l},y,le);f.zf=o;f.zl=u;f.co=i.cs;f.cp=o;i.cs=l}function ue(e){if(f.oa){f.oa+=e;if(i.os>1)i.os=Math.floor(f.oa)}if(f.ie&&i.io)i.io=Math.floor(i.io+e)}function le(e,t,n){f.cp=0;if(t){i.cs=f.co;m(\"Uhr nicht stellbar: \"+n);return}f.eb+=f.zl;f.zn=1;f.cg++;ue(f.zl);_();m(\"Uhr nach Tagesgang um \"+s(f.zl/3600)+\" h gestellt\")}function ae(e,t){if(f.def&&t)qe(k(e).day-k(t).day);if(!(Math.abs(e-t)<=60))f.cg++;if(t)ue(e-t);f.eb=e;f.eu=u();f.est=false;f.def=false;f.ie=false;i.ce=0;f.td=null;f.ty=null;_()}function oe(e){var t=[],n;for(n=0;n<f.starts.length;n++)if(e-f.starts[n]<3600)t.push(f.starts[n]);f.starts=t;return t.length}function se(e){if(f.run&&!f.run.why)f.run.why=e;Shelly.call(\"Switch.Set\",{id:0,on:false},b)}function ce(e,t,n){var r=f.ps,u,l;if(!t)return;u=A();l=(\"Einschalten abgelehnt: \"+n).slice(0,60);f.ps=null;m(l);if(r&&r.k!==\"hand\")f.want={k:r.k,mm:r.mm,exp:(u||0)+1800};if(i.ft!==l||!i.fo||!(u&&i.fu>1&&k(i.fu).day===k(u).day)){i.fu=u?Math.floor(u):1;i.ft=l;i.fo=1;Me(\"ab\",n);_()}}function he(e,t){var n=u(),r=f.sw;if(f.ps&&n>f.ps.B)f.ps=null;if(f.run||r.output||f.ps)return\"l\\xC3\\xA4uft\";if(f.weld)return\"Relais\";if(f.T&&n-f.T<120)return\"Pause\";if(oe(n)>=10)return\"Starts\";var i=K(t);if(i<60)return\"kurz\";Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:i},y,ce);f.ps={k:e,mm:i*Z()/3600,sec:i,B:n+15};return null}function me(e){f.note=e;f.W=Shelly.getUptimeMs()/1e3;m(e)}function ge(e,t){var n=u(),r=f.ps,o=A(),s,h,g,p=0,y;f.ps=null;if(r&&(t||n<=r.B)){s=r.k;h=r.mm;g=r.sec}else{s=\"hand\";if(oe(n)>=10){me(\"Zu viele Starts in einer Stunde \\xE2\\x80\\x93 Pumpe gesch\\xC3\\xBCtzt\");f.starts.push(n);se(\"starts\");return}if(f.boot&&e.timer_duration){y=o&&e.timer_started_at?c(o-e.timer_started_at,0,e.timer_duration):0;p=e.timer_duration-y;g=e.timer_duration>120*60?Math.min(p,120*60-y):p;g=l(c(g,1,e.timer_duration));if(g<p-5)Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:g},b);h=g*Z()/3600}else{h=c(o?q(k(o)):6,6,15);g=K(h);h=g*Z()/3600;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:g},b)}f.want=null;if(i.rt){i.rt=0;_()}}f.starts.push(n);f.run={k:s,t0:n,lt:n,u0:o||0,sec:g,mm:h,ps:0,cr:0,ck:n,pf:-1,u:0,o:0,n:0,i:0,why:\"\",det:\"\"};m(\"Pumpe an (\"+s+\"), Ziel \"+a(h)+\" mm in \"+l(g/60)+\" min\")}function pe(e){var t=e.ps*Z()/3600,n=t-e.cr;if(n>0){i.pi=i.pi+n;e.cr=t}}function be(e,t){f.run.why=e;f.run.det=t;m(\"Schutz: \"+e+\" (\"+t+\")\");se(e)}function ye(){return!i.pn?600:i.pc?(i.pn+i.pc)/2:i.pn*.75}function ve(){return i.pn?i.pn*1.3:2100}function Se(e){var t=f.run,n=u(),r=n-t.t0,i=c(n-t.lt,0,5);var a=e.apower||0,o=e.current||0,h=ye(),m=ve();t.lt=n;if(t.why)return;if(r>t.sec+60){se(\"ende\");return}t.pf=t.pf<0?a:t.pf+(a-t.pf)*.3;t.i=r>=2&&o>10.5?t.i+1:0;if(t.i>=2){be(\"blockiert\",s(o)+\" A\");return}t.n=r>=3&&a<50?t.n+1:0;if(t.n>=5){be(\"keinStrom\",l(a)+\" W\");return}t.o=r>=40&&t.pf>m?t.o+1:0;if(t.o>=5){be(\"ueberlast\",l(t.pf)+\" W > \"+l(m)+\" W\");return}t.u=r>=40&&a>=50&&t.pf<h?t.u+1:0;if(t.u>=8){be(\"unterlast\",l(t.pf)+\" W < \"+l(h)+\" W\");return}if(t.pf>=h)t.ps+=i;if(n-t.ck>=3600){pe(t);_();t.ck=n}}var de={unterlast:\"Trockenlauf oder Hahn zu\",ueberlast:\"\\xC3\\x9Cberlast\",blockiert:\"Pumpe blockiert\",keinStrom:\"Pumpe zieht keinen Strom\",start:\"Pumpe lief nicht an\"};var ke={auto:\"Automatik\",retry:\"Nachlauf\",hand:\"Hand\",kal:\"Anlernen\"};var we={fw:\"Firmware-Schutz\",ab:\"Einschalten abgelehnt\",rk:\"Relais klebt\",ka:\"Anlernen abgebrochen\"};function Me(e,t){var n=A();f.fl=f.fl.slice(-4);f.fn=true;_();f.fl.push((n?String(Math.floor(n)):\"0000000000\")+(f.est?\"~\":\" \")+e+\":\"+String(t||\"\").slice(0,16))}function ze(e){var t=f.run,n=u(),r=A(),l=t.why,o=e.errors&&e.errors.length;f.run=null;f.T=n;pe(t);if(o&&(!de[l]||l===\"start\"))l=\"fw\";var c=l===\"fw\"||!!de[l],h=c&&l===\"fw\"?e.errors.join(\",\"):\"\";var g=c?h?\"Firmware-Schutz: \"+h:de[l]+(t.det?\" (\"+t.det+\")\":\"\"):\"\";if(c){i.fu=r?Math.floor(r):1;i.ft=g.slice(0,60);i.fo=1;Me(l,h||t.det)}else if(t.ps>=60&&(t.k!==\"kal\"||l===\"angelernt\"))i.fo=0;if(t.k===\"hand\"||t.k===\"kal\")i.sh++;else i.sa++;if(t.k===\"kal\"&&t.kp){if(!c)Me(\"ka\",\"ausgeschaltet\");f.sv=-1e9;me(\"Anlernen abgebrochen: \"+(g||\"ausgeschaltet\")+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\")}i.sm=a(i.sm+t.cr);if(c)i.sf++;if(r){var p=k(r),b=k(t.u0||r);i.lr=z(b.day)+\" \"+M(b.min)+\" \"+ke[t.k]+\" \"+s(t.cr)+\" mm\"+(c?\" \\xE2\\x80\\x93 abgebrochen\":\"\");if(c){if(i.fd!==p.day){i.fd=p.day;i.fc=0}i.fc++;var y=t.mm-t.cr,v=l===\"unterlast\"?2:1;i.rt=0;if((t.k===\"auto\"||t.k===\"retry\")&&y>=2&&i.fc<=v){i.rt=Math.floor(r)+(n-t.t0<10?6:60)*60;i.rm=a(y)}}}m(\"Pumpe aus: \"+(l||\"Ende/Stopp\")+\", \"+a(t.cr)+\" mm gegeben\");_()}function Te(e){var t=u(),n=e.apower||0;if(f.T&&t-f.T<5)return;if(n>50){f.wc++;if(f.wc>=5){if(!f.weld){m(\"Relais klebt? \"+l(n)+\" W bei AUS\");Me(\"rk\",l(n)+\" W\");_()}f.weld=true;if(f.wc%30===5)Shelly.call(\"Switch.Set\",{id:0,on:false},b)}}else{f.wc=0;f.weld=false}}function Ae(e){var t=e?e.delta:null,n=u();if(!t||e.component!==\"switch:0\"||typeof t.output!==\"boolean\"||t.output===f.ko)return;f.ko=t.output;if(!f.kc||n-f.k0>20){f.kc=0;f.k0=n}f.kc++;f.kw=f.kc===5&&t.output&&f.k0<=60?1:0}function We(){var e=f.run;f.kw=0;e.k=\"kal\";e.kp=1;e.kt=u();e.ks=0;e.kn=0;e.kl=1e9;e.kh=0;e.kn0=0;e.sec=300;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:300},b);me(\"Anlernen: Hahn offen lassen, Normalleistung wird gemessen\")}function Pe(e){var t=f.run;t.ks+=e;t.kn++;if(e<t.kl)t.kl=e;if(e>t.kh)t.kh=e}function _e(e){var t=f.run,n=u(),r=n-t.kt,i=c(n-t.lt,0,5),a=e.apower||0,o=e.current||0,h=\"\";t.lt=n;if(t.why)return;t.i=r>=2&&o>10.5?t.i+1:0;t.n=r>=3&&a<50?t.n+1:0;if(t.i>=2)be(\"blockiert\",s(o)+\" A\");else if(t.n>=5)be(\"keinStrom\",l(a)+\" W\");else if(n-t.t0>300-5)h=\"Zeit um\";else if(t.kp===1){t.ps+=i;if(r>=45)Pe(a);if(r>=60)h=Ne()}else if(t.kp===3){t.kd=r>=5&&a<t.kn0*.92?t.kd+1:0;if(!t.kd)t.ps+=i;if(t.kd>=3){t.kp=4;t.kt=n;t.ks=0;t.kn=0;t.kl=1e9;t.kh=0}else if(r>=60)h=Oe(0)}else if(t.kp===4){if(r>=10)Pe(a);if(r>=20)h=Oe(1)}if(h)Ee(h,t.kx)}function Ne(){var e=f.run,t=e.kn?e.ks/e.kn:0;if(t<300)return l(t)+\" W zu wenig\";if(t>1900)return l(t)+\" W zu viel\";if(e.kh>e.kl*1.15)return\"unruhig \"+l(e.kl)+\"-\"+l(e.kh)+\" W, Luft im Rohr?\";e.kn0=l(t);e.kp=2;e.kt=u();e.kon=0;e.koff=0;Shelly.call(\"Switch.Set\",{id:0,on:false},b);m(\"Anlernen: Normalleistung \"+e.kn0+\" W \\xE2\\x80\\x93 Signal, jetzt Hahn zudrehen\");return\"\"}function Fe(e){var t=f.run,n=u(),r=l(300-(n-t.t0));if(!e.output)t.koff=1;if(e.output&&!t.kon&&(t.koff||e.timer_duration>300))Ee(\"Taster gedr\\xC3\\xBCckt\");else if(!e.output&&!t.kon&&n-t.kt>=2){t.kon=n;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:r>30?r:30},b)}else if(e.output&&(t.kon||n-t.kt>10)){t.kp=3;t.kt=n;t.kd=0;t.lt=n}else if(n-t.kt>10)Ee(\"Relais blieb aus\")}function Oe(e){var t=f.run,n=A(),r=t.kn?t.ks/t.kn:0,u=1-r/t.kn0,a=\"\",o;if(!e)a=\"Hahn nicht zugedreht\";else if(t.kh>t.kl*1.1)a=\"Hahn zu unruhig\";else if(u<.2)a=\"Hahn zu nur \"+l(u*100)+\" % weniger, nicht erkennbar\";if(a&&t.kn0<600){t.kx=\"trocken? \"+t.kn0+\" W\";return a+\"; unter \"+600+\" W nur mit Zudrehen (Trockenlauf?)\"}i.pn=t.kn0;i.pc=a?0:l(r);i.kt=n?Math.floor(n):1;_();f.sv=-1e9;o=l(ye());a=(a?a+\", \":\"Hahn zu \"+i.pc+\" W, \")+\"Untergrenze \"+o+\" W\";t.kp=0;me(\"Angelernt: \"+i.pn+\" W, \"+a);se(\"angelernt\");return\"\"}function Ee(e,t){f.run.kp=0;Me(\"ka\",t||e);f.sv=-1e9;me(\"Anlernen abgebrochen: \"+e+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\");se(\"abbruch\")}function He(e){return\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min,\"+\"temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=\"+e}function Le(e,t,n){f.wx.busy=true;f.wx.L=e;f.wx.n=t;f.wx.rc=n;f.wx.t=u();f.wx.q++;f.wx.cg=f.cg;Shelly.call(\"HTTP.GET\",{url:He(t),timeout:20},Be,f.wx.q)}function Ue(e){if(!j(e)){i.ev=e.day;i.d=0;i.pi=0;i.dp=e.day-1;i.rt=0;i.xa=-1;i.xe=[];i.xw=[];f.why=\"Winterpause\";_();return}if(i.dp<0||e.day-1-i.dp>14){i.d=0;i.pi=0;i.dp=e.day-1-(i.dp<0?0:14)}while(i.xe.length&&e.day-i.xa>14)Y();if(!i.xe.length)i.xa=-1;if(f.la===null){$(e);Ce(e,null,false);return}Le(e,e.day-(i.xa>=0?i.xa:i.dp+1),false)}function xe(e,t){return e&&typeof e[t]===\"number\"?e[t]:null}function Re(e,t,n){return{rain:xe(e.precipitation_sum,t)||0,prob:xe(e.precipitation_probability_max,t)||0,tmin:xe(e.temperature_2m_min,t),tnow:n&&typeof n.temperature_2m===\"number\"?n.temperature_2m:null}}function Be(e,t,n,r){var u=f.wx.L,l=f.wx.rc,a=JSON.stringify(i);try{Je(e,t,n,r)}catch(e){m(\"Fehler Wetterantwort: \"+e);i=JSON.parse(a);f.wx.busy=true;f.wx.rc=l;try{Je(null,-1,\"Fehler\",r)}catch(e){m(\"Fehler Tagespr\\xC3\\xBCfung: \"+e);i=JSON.parse(a);f.wx.busy=false;f.wx.rc=false;if(u&&!l){i.ev=u.day;f.why=\"Fehler, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen\";_()}}}}function Je(e,t,n,r){var l=f.wx.L,a=f.wx.n,o=false,s=null,h=null,m,g,p,b,y,v;if(r!==f.wx.q||!f.wx.busy)return;f.wx.busy=false;if(f.wx.cg!==f.cg){if(f.wx.rc){f.wx.rc=false;f.rh=0}return}try{if(!t&&e&&e.code===200){s=JSON.parse(e.body);h=s.daily;o=h&&h.time&&h.time.length===a+1&&h.time[a]===w(l)}}catch(e){o=false}if(f.wx.rc){f.wx.rc=false;if(o)Ce(l,Re(h,a,s.current),true);else if(i.rc===l.day&&(i.rk===1||i.rk===3))Ce(l,null,true);return}if(!o){if(!f.oa)f.oa=A()||0;f.wx.A++;v=A();if(f.wx.A<(f.est||f.off?1:4)&&v&&k(v).min+21<750){f.wx.next=u()+1200;return}je(true);$(l);Ce(l,null,false);return}for(m=0;m<a;m++){g=l.day-a+m;p=xe(h.et0_fao_evapotranspiration,m);b=xe(h.precipitation_sum,m);if(p===null)p=I(S(g).m);if(b===null)b=0;y=p*.85-Math.max(0,b-1);if(g>i.dp){i.d=c(c(i.d-i.pi,0,25)+y,0,25);i.pi=0}else if(i.xa>=0&&g>=i.xa){if(g===i.xa)i.d=i.xd;i.d=c(c(i.d-(i.xw[g-i.xa]||0),0,25)+y,0,25)}}i.xa=-1;i.xe=[];i.xw=[];i.d=c(i.d-i.pi,0,25);i.pi=0;i.dp=l.day-1;f.nf=false;if(a>=1){b=xe(h.precipitation_sum,a-1);f.nf=i.rd===l.day-1&&b!==null&&b-1<i.rx/2;te(l,xe(h.temperature_2m_min,a-1),xe(h.temperature_2m_max,a-1))}je(false);Ce(l,Re(h,a,s.current),false)}function Ce(e,t,n){var r=q(e),u=0,l=0,o=A(),c=e.min,h=null,g=false,p,b,y,v,d,w,T,W,P,N,F,O,E,H,L=n&&i.rc===e.day?i.rk:0;if(o)c=k(o).min;f.wx.A=0;if(f.run){_();return}b=i.ev<0?null:S(i.ev);if(!b||!j(b)||e.day-i.ev>60){i.s0=e.day;i.sa=0;i.sh=0;i.sm=0;i.sf=0}i.ev=e.day;i.rc=-1;i.rk=0;if(L===1||L===3){h=i.rf;g=L===3}else if(t&&t.tmin!==null)h=t.tmin<5?t.tmin:null;else{h=ne();if(h!==null){if(h>=5)h=null;else g=true}}p=t&&t.tnow!==null?t.tnow:re();y=s(r);v=h===null?\"\":s(h);d=t?s(t.rain):\"\";w=M(c);T=M(750);W=i.pu?z(i.pu):\"\";if(t&&t.prob>=60&&!f.nf)u=Math.max(0,t.rain-1);P=Math.min(15,r-u);N=u>0&&P<Math.min(15,r);F=K(P)*Z()/3600;F=s(F);O=a(u);E=h===null?0:a(h);H=(Math.floor(c/60)+1)*60+5;if(!D())f.why=\"Automatik aus\";else if(V(e))f.why=\"Pause bis \"+W;else if(r<8)f.why=\"nicht n\\xC3\\xB6tig (\"+y+\" mm)\";else if(h!==null&&!(p>=5)){f.why=\"Frostsperre (\"+(g?\"gesch\\xC3\\xA4tzt \":\"\")+v+\" \\xC2\\xB0C), gie\\xC3\\x9Ft ab \"+5+\" \\xC2\\xB0C\";i.rc=e.day;i.rk=g?3:1;i.rf=E;f.rh=H}else{l=P;if(N){i.rd=e.day;i.rx=O}else if(i.rd===e.day)i.rd=-1;if(l<5&&u>0){f.why=\"Regen erwartet (\"+d+\" mm, \"+t.prob+\" %)\"+(L===2?\", \"+w+\" best\\xC3\\xA4tigt\":\"\");i.rc=e.day;i.rk=2;f.rh=H}else if(l<5)f.why=\"nicht n\\xC3\\xB6tig (\"+y+\" mm)\";else if(c>=750){f.why=T+\" vorbei, nicht mehr gestartet\";l=0}else f.why=(L===2?\"Regen abgesagt, \":L?\"Frost vorbei, \":\"\")+\"gegossen \"+F+\" mm\"+(f.nf?\" (gestern Regen ausgeblieben)\":\"\")}m(\"Tagespr\\xC3\\xBCfung: Defizit \"+a(r)+\" mm\"+(t?\"\":\" (ohne Internet)\")+\" -> \"+f.why);if(l>=5)f.want={k:\"auto\",mm:l,exp:(o||0)+7200};_()}function selfTest(){if(f.la===null)return\"FEHLER Ort unbekannt: \"+e.l;if(!f.st){f.st=\"l\\xC3\\xA4uft\";Shelly.call(\"HTTP.GET\",{url:He(14),timeout:20},y,Ze)}return f.st===\"ok\"?\"ok, Ort \"+f.la+\" \"+f.lo:f.st}function Ze(e,t,n){var r=false;try{r=!t&&e.code===200&&JSON.parse(e.body).daily.time.length===15}catch(e){r=false}f.st=r?\"ok\":\"FEHLER \"+(n||\"Antwort\");m(\"Selbsttest Wetter: \"+f.st)}function De(){var e=Shelly.getComponentStatus(\"sys\"),t=v(2026,4,1)*86400+600*60-(1+1)*3600;f.O=0;if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return;f.def=true;f.est=true;f.eb=t;f.eu=u();i.df=1;i.ce=1;i.cs=t;Shelly.call(\"Sys.SetTime\",{unixtime:t},b);m(\"Uhrzeit unbekannt \\xE2\\x80\\x93 Einstecken gilt als 1. April \"+M(600));_()}function Ge(){f.gn=u()+900;Shelly.call(\"HTTP.GET\",{url:\"https://geocoding-api.open-meteo.com/v1/search?count=1&name=\"+f.oq+\"&countryCode=\"+e.p,timeout:20},y,Ie)}function Ve(e){var t=\"\",n=0,r,i,f,u=\"0123456789ABCDEF\";while(n<e.length){r=e.charCodeAt(n);i=e.charCodeAt(n+1);f=-1;if(r>47&&r<58||r>64&&r<91||r>96&&r<123)t+=e.charAt(n);else if(r<128)t+=\"%\"+u.charAt(r>>4)+u.charAt(r&15);else if(r>193&&r<224&&i>127&&i<192){f=i;n++}else{f=128|r&63;r=192|r>>6}if(f>=0)t+=\"%\"+u.charAt(r>>4)+u.charAt(r&15)+\"%\"+u.charAt(f>>4)+u.charAt(f&15);n++}return t}function Ie(t,n,r){var u=null,l;try{if(!n&&t&&t.code===200)u=JSON.parse(t.body)}catch(e){u=null}if(!u)return;l=u.results&&u.results[0];if(!l){if(!f.gx)m(\"Ort \"+e.l+\" nicht gefunden \\xE2\\x80\\x93 Schreibweise pr\\xC3\\xBCfen oder LAT/LON eintragen\");f.gx=true;return}if(typeof l.latitude!==\"number\"||typeof l.longitude!==\"number\")return;f.gx=false;f.la=i.la=o(l.latitude);f.lo=i.lo=o(l.longitude);i.pz=e.p+e.l;_();m(\"Ort \"+e.l+\": \"+f.la+\", \"+f.lo)}function je(e){var t=A();if(e&&!f.oa)f.oa=t||0;if(e&&!f.off)f.H=u()+900;if(!e){if(f.off&&f.oa&&t){i.io=Math.floor(f.oa);i.id=Math.max(0,l((t-f.oa)/60));f.ie=f.est}f.oa=0}f.off=e;i.os=e?Math.floor(f.oa)||1:0}function qe(e){if(i.ev>=0)i.ev+=e;if(i.dp>=0)i.dp+=e;if(i.fd>=0)i.fd+=e;if(i.pu)i.pu+=e;if(i.xa>=0)i.xa+=e;if(i.rd>=0)i.rd+=e;if(i.rc>=0)i.rc+=e;if(i.fu>1)i.fu+=e*86400;if(i.io&&!f.ie)i.io+=e*86400;if(i.s0>0)i.s0+=e;i.rt=0;i.df=0;f.td=null;f.ty=null;f.z=null;m(\"Echte Uhrzeit da: Tagesmarken um \"+e+\" Tage verschoben\")}function Ke(){var e=f.kh;if(e>=0&&u()>90){f.kh=-1;f.kw=0;Shelly.removeStatusHandler(e)}if(f.O&&u()>=f.O)De();if(u()>=f.cfgAt){f.cfgAt=u()+3600;gt();yt()}if(!f.h&&u()-f.hb>=(f.hn<10?60:3600))U();if(f.la===null&&u()>=f.gn)Ge();var t=A();if(!t)return;var n=k(t),r=u();if(f.est&&!(f.cp&&r-f.cp<60)&&(Math.abs(t-(f.eb+r-f.eu))>5||W())){ae(t,f.eb+r-f.eu)}if(i.ev>n.day||i.dp>n.day-1||i.pu>n.day+14){if(i.ev>n.day)i.ev=-1;if(i.dp>n.day-1)i.dp=n.day-1;if(i.pu>n.day+14)i.pu=0;i.rt=0;_()}if(t-i.t>=21600)_();ee(n,r);if(f.off&&f.la!==null&&!f.wx.busy&&r>=f.H){Shelly.call(\"HTTP.GET\",{url:\"https://api.open-meteo.com/v1/forecast?latitude=\"+f.la+\"&longitude=\"+f.lo+\"&daily=temperature_2m_min&timezone=auto&forecast_days=1\",timeout:10},y,Qe);f.H=r+900}if(i.pu&&n.day>i.pu){i.pu=0;_()}if(f.run&&(f.run.k===\"auto\"||f.run.k===\"retry\")&&(!D()||V(n)))se(\"aus\");var l=f.est&&r<600;if(!l&&i.ev!==n.day&&n.min>=600&&n.min<750&&!f.wx.busy&&r>=f.wx.next&&!f.run&&!f.ps){Ue(n)}if(!l&&i.rc===n.day&&n.min>=f.rh&&n.min<750&&!f.wx.busy&&!f.run&&!f.ps){f.rh=(Math.floor(n.min/60)+1)*60+5;if(f.off||f.la===null)Ce(n,null,true);else Le(n,0,true)}if(f.want&&!l){if(t>f.want.exp||!D()||n.min>=750)f.want=null;else if(!he(f.want.k,f.want.mm))f.want=null}if(i.rt&&t>=i.rt&&!f.run&&!l){if(n.min>=750||!D()||V(n)||i.fd!==n.day){i.rt=0;_()}else if(!he(\"retry\",i.rm)){i.rt=0;_()}}}function Qe(e,t,n){if(!t&&e&&e.code===200&&f.off){je(false);_()}}function Xe(t){var n=[],r=M(600);if(!t)n.push(\"Uhrzeit unbekannt\");else if(f.def)n.push(\"Uhr angenommen: Einstecken = \"+r);else if(f.est)n.push(\"Uhr gesch\\xC3\\xA4tzt\");if(f.la===null)n.push(\"Ort \"+(f.gx?e.l+\" nicht gefunden\":\"unbekannt\"));else if(f.off)n.push(\"ohne Internet\");if(f.P)n.push(\"Speicher fehlt (Firmware alt)\");return{e:f.weld?\"Relais klebt\":i.fo?\"St\\xC3\\xB6rung: \"+i.ft:\"\",w:n}}function Ye(e){var t=f.run,n,r,u,l=i.fu>1?k(i.fu):null,a=i.rt?k(i.rt):null,o=Shelly.getUptimeMs()/1e3,c=M(600),m=M(750),g=i.pu?z(i.pu):\"\",p=l?M(l.min):\"\",b,y;if(f.weld)return\"ALARM: Pumpe zieht Strom trotz AUS \\xE2\\x80\\x93 Relais klebt? Stecker ziehen!\";if(t){n=t.sec-(o-t.t0);b=s(t.mm);y=Math.round(n/60);u=Math.round(f.sw.apower||0);if(t.k===\"kal\")return\"Anlernen: \"+(t.kp===1?\"Hahn offen lassen, Normalleistung messen\":t.kp===4?\"Hahn-zu-Leistung messen\":\"jetzt Hahn zudrehen\")+\", \"+u+\" W\";return\"Beregnung (\"+ke[t.k]+\"): \"+b+\" mm, noch \"+(y>0?y:0)+\" min, \"+u+\" W\"}if(!e)return\"Uhrzeit unbekannt \\xE2\\x80\\x93 Automatik wartet auf Internet. Taster geht.\";if(i.fo&&(!l||l.day===e.day)){y=a?M(a.min):\"\";n=\"St\\xC3\\xB6rung\"+(l?\" \"+p:\"\")+\": \"+i.ft;b=i.ev!==e.day&&e.min<750?\"heute \":\"morgen \";n+=a?\". Nachlauf \"+y:f.want?\". Neuer Versuch bis \"+m:\". N\\xC3\\xA4chster Versuch \"+b+c}else if(!j(e))n=\"Winterpause bis 01.\"+h(3)+\". \\xE2\\x80\\x93 Taster geht\";else if(!D())n=\"Automatik aus \\xE2\\x80\\x93 Taster geht\";else if(V(e))n=\"Pause bis \"+g;else if(i.ev===e.day)n=\"Heute: \"+(f.why||\"gepr\\xC3\\xBCft\");else if(e.min<600)n=\"Bereit, Pr\\xC3\\xBCfung \"+c;else n=e.min<750?\"Pr\\xC3\\xBCfung l\\xC3\\xA4uft\":\"Heute nicht gepr\\xC3\\xBCft, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen \"+c;if(i.fo&&l&&l.day!==e.day){b=z(l.day);n+=\" \\xC2\\xB7 St\\xC3\\xB6rung \"+b+\" \"+p+\": \"+i.ft}u=Xe(e).w;for(r=0;r<u.length;r++)n+=\" \\xC2\\xB7 \"+u[r];if(i.lr)n+=\" \\xC2\\xB7 Zuletzt \"+i.lr;if(f.note&&o-f.W>43200)f.note=\"\";if(f.note)n+=\" \\xC2\\xB7 \"+f.note;else if(i.pn)n+=\" \\xC2\\xB7 Pumpe angelernt \"+i.pn+\" W\";while(n.length>230&&n.lastIndexOf(\" \\xC2\\xB7 \")>0)n=n.slice(0,n.lastIndexOf(\" \\xC2\\xB7 \"));return n.length>230?n.slice(0,230):n}function $e(){var e=A(),t=e?k(e):null,n;it(t);if(!f.h)return;try{for(n in f.h)if(n!==\"re\"&&f.hl<3&&typeof f.h[n].getStatus===\"function\"&&f.h[n].getStatus()===undefined)throw\"fehlt \"+n;et(t)}catch(e){m(\"Bedienfeld neu: \"+e);f.hl++;try{f.h.re.off(f.hr)}catch(e){}f.h=null;f.hn=0;f.hb=0;f._=-1;f.N=\"\";f.F=-1;G()}}function et(e){var t,n,r,u;G();r=f.h.pa.getValue();if(e&&typeof r===\"number\"&&f._>=0&&r!==f._){i.pu=r>0?e.day+l(r)-1:0;i.rt=0;f.want=null;_();u=r>0?z(i.pu):\"\";m(\"Pause \"+(r>0?\"bis \"+u:\"aufgehoben\"))}n=e&&V(e)?i.pu-e.day+1:0;if(n!==f._){f.h.pa.setValue(n);f._=n}t=Ye(e);if(t!==f.N){f.h.st.setValue(t);f.N=t}n=e?a(q(e)):0;if(n!==f.F){f.h.bk.setValue(n);f.F=n}}function tt(e,t){return e&&t&&e[0]===t[0]&&e[1]===t[1]&&e[2]===t[2]}function nt(){var e=Shelly.getComponentConfig(\"plugs_ui\"),t,n;f.led=\"?\";if(!e||!e.leds||e.leds.mode!==\"switch\"||!e.leds.colors||!e.leds.colors[\"switch:0\"])return;t=e.leds.colors[\"switch:0\"].off;for(n in r)if(n!==\"run\"&&t&&tt(t.rgb,r[n])&&t.brightness===100)f.led=n}function rt(e){return e.e?\"err\":e.w.length?\"warn\":\"ok\"}function it(e){var t=rt(Xe(e)),n=u(),i=[],l;if(t!==f.U){f.U=t;f.R=n}if(t===f.led||n-f.R<(t===\"err\"||f.led===\"?\"?120:1800))return;for(l=0;l<f.ledN.length;l++)if(n-f.ledN[l]<86400)i.push(f.ledN[l]);f.ledN=i;if(i.length>=12)return;Shelly.call(\"PLUGS_UI.SetConfig\",{config:{leds:{mode:\"switch\",colors:{\"switch:0\":{on:{rgb:r.run,brightness:100},off:{rgb:r[t],brightness:100}}}}}},y,ft);f.led=t;f.ledN.push(n);f.nl++}function ft(e,t,n){if(t){m(\"LED nicht gesetzt: \"+n);f.led=\"?\";f.R=u()+3480}}function ut(e){var t=k(e);return z(t.day)+t.y+\" \"+M(t.min)}function lt(){try{var e=Shelly.getDeviceInfo();return e&&e.ver||\"?\"}catch(e){return\"?\"}}function at(e){var t=Math.round(e/60),n=Math.round(t/60),r=Math.round(t/1440);return t<120?t+\" min\":t<2880?n+\" h\":r+\" Tage\"}var ot={ok:\"gr\\xC3\\xBCn\",warn:\"gelb\",err:\"rot\"};function info(){var t=A(),n=t?k(t):null,r=Xe(n),u=Shelly.getUptimeMs()/1e3,a,o,c,h=rt(r),m=Ye(n),g=r.w.join(\", \"),p=t?ut(t):\"\\xE2\\x80\\x93 Uhrzeit unbekannt\",b=i.fu>1?ut(i.fu)+\" \":\"\",y=i.s0>0?z(i.s0):\"-\",v=s(i.sm),S=n?q(n):i.d,d=i.ob>-50?s(i.ob):\"-\",w=i.oa>-50?s(i.oa):\"-\",M=f.off&&f.oa?ut(f.oa):\"\",T=i.io?ut(i.io):\"\",W=i.io?at(i.id*60):\"\",P=lt(),_=t?ut(t-u):\"?\",N=at(u),F=f.t0>1767225600?ut(f.t0):\"\",O=at(u-f.s0),E=l(ye()),H=l(ve()),L=i.kt>1?\" \"+ut(i.kt):\"\";S=s(S);c=\"Bew\\xC3\\xA4sserung \"+p+\"\\n\\nStatus: \"+m+\"\\nLED: \"+(ot[f.led]||\"noch nicht gesetzt\")+(h!==f.led?\", wechselt bald auf \"+ot[h]:\"\")+\" \\xE2\\x80\\x93 \"+(r.e||g||\"alles in Ordnung\")+\"\\nLetzte St\\xC3\\xB6rung: \"+(i.ft?b+i.ft+(i.fo?\" (offen)\":\" (erledigt)\"):\"keine\")+\"\\nLetzter Lauf: \"+(i.lr||\"keiner\")+\"\\nSaison seit \"+y+\": Automatik \"+i.sa+\", Hand \"+i.sh+\", zusammen \"+v+\" mm, St\\xC3\\xB6rungen \"+i.sf+\"\\nPumpe: \"+(i.pn?\"angelernt\"+L+\", normal \"+i.pn+\" W, Hahn zu \"+(i.pc?i.pc+\" W\":i.kt?\"nicht erkannt\":\"nicht gemessen\"):\"Voreinstellung, nicht angelernt\")+\"; Untergrenze \"+E+\" W, Obergrenze \"+H+\" W\"+\"\\nBodenkonto \"+S+\" mm, Eigenw\\xC3\\xA4rme F\\xC3\\xBChler Nacht/Tag \"+d+\" / \"+w+\" K\"+\"\\nUhr: \"+(!t?\"unbekannt\":f.def?\"angenommen\":f.est?\"gesch\\xC3\\xA4tzt\":\"Zeitserver\")+\"\\nInternet: \"+(f.off?\"Wetterdienst fehlt\"+(f.oa?\" seit \"+M:\"\"):f.la===null?\"ohne Ort kein Wetterabruf\":\"ok\")+(i.io?\", letzter Ausfall \"+T+\", \"+W:\"\")+\"\\nOrt: \"+e.l+(f.la===null?f.gx?\" nicht gefunden\":\" noch unbekannt\":\" \"+f.la+\", \"+f.lo)+\"\\nGer\\xC3\\xA4t: Firmware \"+P+\", an seit \"+_+\" (\"+N+\")\"+(f.t0>1767225600?\", davor zuletzt gespeichert \"+F:\"\")+\"; Skript l\\xC3\\xA4uft seit \"+O+\"\\nFlash-Schreibvorg\\xC3\\xA4nge seit Skriptstart: Speicher \"+f.nw+\", Einstellungen \"+f.nc+\", LED \"+f.nl+\"\\n\\nSt\\xC3\\xB6rungen (gespeichert, neueste zuerst):\"+(f.fl.length?\"\":\" keine\");a=f.fl.length-1;while(a>=0){c+=st(f.fl[a]);a--}c+=\"\\n\\nLetzte Meldungen (seit Skriptstart):\";o=f.lg.length;a=1;while(a<=o){c+=ct(f.lg[(f.li-a+o)%o]);a++}return c}function st(e){var t=Number(e.slice(0,10)),n=e.indexOf(\":\"),r=e.slice(11,n),i=e.slice(n+1),f=t>1?ut(t):\"\";return\"\\n\"+(f?(e.charAt(10)===\"~\"?\"~\":\"\")+f:\"Zeit unbekannt\")+\" \"+(de[r]||we[r]||r)+(i?\" (\"+i+\")\":\"\")}function ct(e){var t=Number(e.slice(0,10)),n=t?k(t):null,r=n?z(n.day):\"\",i=n?M(n.min):\"\";return\"\\n\"+(n?r+(e.charAt(10)===\"~\"?\" ~\":\" \")+i:\"--.-- --:--\")+\" \"+e.slice(11)}function ht(e,t){try{t.body=info();t.code=200}catch(e){t.body=\"Fehler: \"+e;t.code=500}try{t.headers=[[\"Content-Type\",\"text/plain; charset=utf-8\"]];t.send()}catch(e){m(\"Diagnose-Seite: \"+e)}}function mt(){var e;f.k++;try{e=g();p(e);f.u=A()||0;if(f.kw&&f.run&&f.run.k===\"hand\"&&e.output)We();if(f.run&&f.run.kp===2)Fe(e);else if(e.output&&!f.run)ge(e);else if(!e.output&&f.run)ze(e);else if(e.output&&f.run&&f.run.k===\"kal\")_e(e);else if(e.output&&f.run)Se(e);else if(f.ps&&u()>f.ps.B){ge(e,1);f.run.why=\"start\";ze(e)}if(!e.output)Te(e);f.boot=false}catch(e){m(\"Fehler Takt: \"+e)}if(f.k%30===1&&f.wx.busy&&u()-f.wx.t>60)Be(null,-1,\"keine Antwort\",f.wx.q);if(f.k%30===1){try{Ke()}catch(e){m(\"Fehler Plan: \"+e)}}if(f.k%10===2){try{$e()}catch(e){m(\"Fehler Anzeige: \"+e)}}try{N()}catch(e){m(\"Fehler Speicher: \"+e)}}function gt(){var e=Shelly.getComponentConfig(\"switch\",0)||{},t={},n=false;if(e.initial_state!==\"off\"){t.initial_state=\"off\";n=true}if(e.auto_off!==true){t.auto_off=true;n=true}if(e.auto_off_delay!==7800){t.auto_off_delay=7800;n=true}if(e.auto_on===true){t.auto_on=false;n=true}if(e.autorecover_voltage_errors===true){t.autorecover_voltage_errors=false;n=true}if(e.name!==\"Brunnenpumpe\"){t.name=\"Brunnenpumpe\";n=true}if(n){Shelly.call(\"Switch.SetConfig\",{id:0,config:t},b);f.nc++}}var pt=\"0 */5 * * * *\";var bt=\"0 23 3 * * *\";function yt(e){f.sn=e||0;Shelly.call(\"Schedule.List\",{},y,vt)}function vt(e,t,n){var r=e&&e.jobs||[],i,f,u,l,a=null,o=false;if(t){m(\"Zeitplan nicht lesbar: \"+n);return}for(i=0;i<r.length;i++){u=r[i].calls||[];for(f=0;f<u.length;f++){l=u[f]?String(u[f].method).toLowerCase():\"\";if(l===\"script.start\"&&u[f].params&&u[f].params.id===Script.id)a=r[i];if(l===\"shelly.update\")o=true}}if(!a){if(F(\"Schedule.Create\",{enable:true,timespec:pt,calls:[{method:\"Script.Start\",params:{id:Script.id}}]},St)){m(\"W\\xC3\\xA4chter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht\")}}else if(a.enable!==true||a.timespec!==pt){F(\"Schedule.Update\",{id:a.id,enable:true,timespec:pt},St)}else if(!o){if(F(\"Schedule.Create\",{enable:true,timespec:bt,calls:[{method:\"Shelly.Update\",params:{stage:\"stable\"}}]},St)){m(\"Firmware-Update angelegt: t\\xC3\\xA4glich 03:23 die neueste stabile\")}}}function St(e,t,n){if(t)m(\"Zeitplan nicht gesetzt: \"+n);else if(f.sn<2)yt(f.sn+1)}function dt(){P();p(g());f.u=A()||0;f.oq=Ve(e.l);if(typeof e.S===\"number\"&&typeof e.M===\"number\"){f.la=e.S;f.lo=e.M}else if(i.la!==null){f.la=i.la;f.lo=i.lo}f.t0=i.t;f.s0=u();if(i.os){f.off=true;f.oa=i.os>1?i.os:0}var t=Shelly.getComponentStatus(\"sys\"),n=u();if(i.wu>0&&n>=i.wu){f.sv=i.wu;f.wn=i.wn;f.w24=Math.min(i.wb,n)}if(t&&typeof t.unixtime===\"number\"&&t.unixtime>1767225600&&(!i.ce||n<i.tu||W())){if(i.ce||i.df){if(i.df===1)qe(k(t.unixtime).day-k(i.t).day);i.ce=0;_()}}else if(i.t>1767225600){f.eb=i.t+(n>=i.tu?n-i.tu:n);f.eu=n;f.est=true;f.def=i.df===1;f.u=A()||0;if(i.ce!==1||n<i.tu||!(t&&t.unixtime>1767225600)){i.ce=1;i.cs=Math.floor(f.eb);Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},b);m(\"Uhr aus Zeitanker gesch\\xC3\\xA4tzt\");_()}}else f.O=n+120;gt();yt();f.cfgAt=n+3600;nt();U();try{HTTPServer.registerEndpoint(\"info\",ht)}catch(e){m(\"Diagnose-Seite fehlt: \"+e)}if(u()<60){try{f.ko=!!g().output;f.kh=Shelly.addStatusHandler(Ae)}catch(e){m(\"Anlern-Geste fehlt: \"+e)}}Timer.set(1e3,true,mt);m(\"gestartet, Bodenkonto \"+a(i.d)+\" mm, Pumpe \"+(i.pn?\"angelernt \"+i.pn+\" W\":\"Voreinstellung\"))}dt();";
window.__bw = { fertig: false, log: [] };
deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })
  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })
  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });
return "Aufspielen gestartet, 34959 Byte";
})();
