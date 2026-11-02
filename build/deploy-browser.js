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

var CODE = "var e={l:\"Ludwigshafen am Rhein\",S:\"DE\",p:null,M:null};var t=[.6,.9,1.6,2.6,3.5,4.5,4.4,3.8,2.4,1.1,.5,.5];var n=[6.1,9.3,13,17,21.1,26.3,27.4,27.4,22.8,16.7,9.6,6.8];var r={ok:[0,100,0],warn:[100,70,0],err:[100,0,0],run:[0,0,100],cue:[100,100,100]};var i=null;var u={k:0,u:0,sw:{output:false,apower:0,tC:null},ra:0,au:true,oq:\"\",eb:0,eu:0,est:false,run:null,ps:null,want:null,starts:[],A:0,wc:0,weld:false,wx:{busy:false,next:0,T:0,L:null,n:0,rc:false,t:0,q:0,cg:0},off:false,oa:0,ie:false,sv:-1e9,sd:false,wn:0,w24:0,cn:0,c24:0,why:\"\",note:\"\",W:0,P:false,h:null,_:-1,F:\"\",N:-1,boot:true,def:false,H:0,kh:-1,kts:[],ko:false,kw:0,O:0,cfgAt:0,sn:0,cg:0,hb:0,hn:0,hr:-1,hl:0,led:\"\",ledOn:\"\",U:\"\",R:0,ledN:[],lx:0,cue:0,td:null,ty:null,ts:-1e9,z:null,zf:-1e9,zl:0,zn:0,cp:0,co:0,rh:0,nf:false,la:null,lo:null,gn:0,gx:false,st:\"\",lg:[],li:0,t0:0,s0:0,fl:[],fn:false,nw:0,nc:0,nl:0};function f(){return Shelly.getUptimeMs()/1e3}function l(e){return Math.round(e)}function a(e){return Math.round(e*10)/10}function s(e){return Math.round(e*100)/100}function o(e){var t=Math.round(e*10)/10;return String(t).replace(\".\",\",\")}function h(e,t,n){return e<t?t:e>n?n:e}function c(e){return typeof e===\"number\"&&e-e===0}function m(e){return typeof e===\"number\"&&e-e===0?e:0}function g(e){var t=e.length,n=0;while(n<e.length){if(e.charCodeAt(n)>127)t+=5;n++}return t}function v(e){return(e<10?\"0\":\"\")+e}function S(e){var t=u.u>1e9&&u.u<1e10?Math.floor(u.u):0,n=u.lg[(u.li+5)%6];e=String(e);print(\"[BW] \"+e);if(n&&n.slice(11)===e.slice(0,80))return;t=(t?String(t):\"0000000000\")+(u.est?\"~\":\" \")+e.slice(0,80);if(u.lg.length<6)u.lg.push(t);else u.lg[u.li]=t;u.li=(u.li+1)%6}function p(){return Shelly.getComponentStatus(\"switch\",0)||{}}function d(e){var t=e.temperature;u.sw.output=!!e.output;u.sw.apower=m(e.apower);u.sw.tC=t&&c(t.tC)?t.tC:null}function b(e,t,n){if(t)S(\"RPC-Fehler \"+t+\" \"+n)}function y(e,t,n,r){try{r(e,t,n)}catch(e){S(\"Fehler im R\\xC3\\xBCckruf: \"+e)}}function k(e,t,n){e-=t<=2?1:0;var r=e/400|0,i=e-r*400;var u=((153*(t+(t>2?-3:9))+2)/5|0)+n-1;var f=i*365+(i/4|0)-(i/100|0)+u;return r*146097+f-719468}function w(e){e+=719468;var t=e/146097|0,n=e-t*146097;var r=(n-(n/1460|0)+(n/36524|0)-(n/146096|0))/365|0;var i=n-(365*r+(r/4|0)-(r/100|0));var u=(5*i+2)/153|0;var f=u<10?u+3:u-9;return{y:r+t*400+(f<=2?1:0),m:f,d:i-((153*u+2)/5|0)+1}}function M(e){var t=1970+(e/31556952|0),n=k(t,4,1)-1,r=k(t,11,1)-1;n=(n-(n+4)%7)*86400+3600;r=(r-(r+4)%7)*86400+3600;return(1+(e>=n&&e<r?1:0))*3600}function z(e){var t=e+M(e),n=t/86400|0,r=w(n);return{day:n,min:(t-n*86400)/60|0,y:r.y,m:r.m,d:r.d}}function A(e){return e.y+\"-\"+v(e.m)+\"-\"+v(e.d)}function T(e){return v(e/60|0)+\":\"+v(e%60)}function W(e){var t=w(e);return v(t.d)+\".\"+v(t.m)+\".\"}function P(e){var t=w(e),n=k(t.y,1,1),r=2*Math.PI/365*(e-n);var i=Math.cos(r),f=Math.sin(r),l=Math.cos(2*r),a=Math.sin(2*r);var s=229.18*(75e-6+.001868*i-.032077*f-.014615*l-.040849*a);var o=.006918-.399912*i+.070257*f-.006758*l+907e-6*a;var h=(u.la===null?50:u.la)*Math.PI/180;var c=Math.cos(h),m=Math.cos(o),g=Math.tan(h),v=Math.tan(o),S=Math.cos(1.58534);var p=Math.acos(S/(c*m)-g*v);return 720-4*((u.lo===null?15*1:u.lo)+p*180/Math.PI)-s}function _(){var e=Shelly.getComponentStatus(\"sys\"),t=Shelly.getUptimeMs();if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return e.unixtime;return u.eb?u.eb+t/1e3-u.eu:null}function E(){var e=Shelly.getComponentStatus(\"sys\");return!!e&&typeof e.last_sync_ts===\"number\"&&Math.abs(e.last_sync_ts-i.cs)>5}function F(){var t=null,n=null,r,f,l={v:1,t:0,d:0,dp:-1,pi:0,ev:-1,pn:0,pc:0,kt:0,pu:0,fd:-1,fc:0,rt:0,rm:0,rq:0,lr:\"\",xa:-1,xd:0,ob:-99,oa:-99,df:0,rd:-1,rx:0,rc:-1,rk:0,rf:0,tu:0,ce:0,cs:0,fu:0,ft:\"\",fo:0,s0:0,sa:0,sh:0,sm:0,sf:0,io:0,id:0,os:0,wu:0,wn:0,wb:0,la:null,lo:null,pz:\"\"};try{n=Script.storage.getItem(\"s\");t=JSON.parse(n)}catch(e){t=null}if(!t||t.v!==1){if(n)S(\"Speicher unlesbar, Voreinstellungen\");t={}}for(r in l){if(typeof t[r]!==typeof l[r])continue;if(typeof l[r]===\"string\")l[r]=t[r];else if(c(t[r])&&Math.abs(t[r])<1e10)l[r]=s(t[r])}if(!(l.d>=0&&l.d<=25))l.d=0;if(!(l.pi>=0))l.pi=0;if(!(l.pn>=300&&l.pn<=1900))l.pn=0;if(!(l.pc>=0&&l.pc<l.pn))l.pc=0;if(!c(t.fo))l.fo=l.fu?1:0;if(g(l.lr)>80)l.lr=\"\";if(g(l.ft)>140)l.ft=\"\";n=t.xe;r=t.xw;l.xe=[];l.xw=[];if(n&&r&&n.length===r.length&&n.length<=14){for(f=0;f<n.length;f++){if(!c(n[f])||!c(r[f])||Math.abs(n[f])>1e4||Math.abs(r[f])>1e4){l.xe=[];l.xw=[];break}l.xe.push(s(n[f]));l.xw.push(s(r[f]))}}if(!l.xe.length)l.xa=-1;if(t.pz===e.S+e.l&&c(t.la)&&Math.abs(t.la)<=90&&c(t.lo)&&Math.abs(t.lo)<=180){l.la=t.la;l.lo=t.lo}else l.pz=\"\";i=l;try{t=JSON.parse(Script.storage.getItem(\"f\"))}catch(e){t=null}u.fl=[];if(t&&typeof t===\"object\"&&t.length<=5)for(f=0;f<t.length;f++)if(typeof t[f]===\"string\"&&g(t[f])<=60)u.fl.push(t[f])}function L(){u.sd=true}function N(){var e=f(),t;if(!u.sd)return;if(e-u.w24>=86400){u.w24=e;u.wn=0}if(e-u.sv<(u.wn>=48?3600:60))return;t=_();if(t){i.t=Math.floor(t);i.tu=Math.floor(e)}i.d=s(i.d);i.pi=s(i.pi);i.wu=Math.floor(e);i.wn=u.wn+1;i.wb=Math.floor(u.w24);try{Script.storage.setItem(\"s\",JSON.stringify(i));u.P=false;u.sd=false;u.nw++;if(u.fn){Script.storage.setItem(\"f\",JSON.stringify(u.fl));u.fn=false;u.nw++}}catch(e){if(!u.P)S(\"Speicher schreibt nicht: \"+e);u.P=true}u.sv=e;u.wn++}function x(e,t,n){var r=Shelly.getUptimeMs()/1e3;if(r-u.c24>=86400){u.c24=r;u.cn=0}if(u.cn===30)S(\"Schreibbremse Einstellungen: \"+e);if(u.cn>=30){u.cn++;return false}Shelly.call(e,t,y,n);u.cn++;u.nc++;return true}var H=[[\"text\",200,\"st\"],[\"number\",200,\"bk\"],[\"boolean\",200,\"au\"],[\"number\",201,\"pa\"],[\"number\",202,\"ra\"],[\"button\",200,\"re\"]];function O(e){if(e===0)return{name:\"Status\",default_value:\"\",persisted:false,max_len:255,meta:{ui:{view:\"label\"}}};if(e===1)return{name:\"Wasserdefizit\",default_value:0,persisted:false,min:0,max:25,meta:{ui:{view:\"progressbar\",unit:\"mm\",step:.1}}};if(e===2)return{name:\"Automatik\",default_value:true,persisted:true,meta:{ui:{view:\"toggle\",titles:[\"Aus\",\"An\"]}}};if(e===3)return{name:\"Pause\",default_value:0,persisted:false,min:0,max:14,meta:{ui:{view:\"field\",unit:\"Tage\",step:1}}};if(e===4)return{name:\"Regenrate\",default_value:8.6,persisted:true,min:1,max:40,meta:{ui:{view:\"field\",unit:\"mm/h\",step:.1}}};return{name:\"Pumpe neu einlernen\",meta:{ui:{view:\"button\"}}}}var U=0;function R(){var e;while(U<H.length&&Shelly.getComponentConfig(H[U][0],H[U][1]))U++;if(U<H.length){e=O(U);x(\"Virtual.Add\",{type:H[U][0],id:H[U][1],config:e},D);return}if(!Shelly.getComponentConfig(\"group\",200)){x(\"Virtual.Add\",{type:\"group\",id:200,config:{name:\"Bew\\xC3\\xA4sserung\",meta:{ui:{view:\"group\"}}}},C);return}J();Z()}function B(){u.hb=f();u.hn++;U=0;R()}function D(e,t,n){if(U>=H.length)return;if(t)S(\"Bedienfeld \"+H[U][2]+\": \"+n);U++;R()}function C(e,t,n){J();Z()}function J(){var e=[],t,n=Shelly.getComponentStatus(\"group\",200),r=n?n.value:null,i,u;for(t=0;t<H.length;t++)e.push(H[t][0]+\":\"+H[t][1]);i=!!r&&r.length===e.length;u=i?\",\"+String(r)+\",\":\"\";for(t=0;t<e.length;t++)if(u.indexOf(\",\"+e[t]+\",\")<0)i=false;if(!i)x(\"Group.Set\",{id:200,value:e},b)}function Z(){var e={},t,n=true;if(u.h)return;try{t=0;while(t<H.length){e[H[t][2]]=Virtual.getHandle(H[t][0]+\":\"+H[t][1]);if(!e[H[t][2]])n=false;t++}}catch(e){n=false}if(!n){if(u.hn===1)S(\"Bedienfeld unvollst\\xC3\\xA4ndig \\xE2\\x80\\x93 ohne Anzeige weiter\");return}if(u.hr<0){try{u.hr=e.re.on(\"single_push\",V)}catch(e){S(\"Knopf im Bedienfeld ohne Abo: \"+e)}}u.h=e;j();if(u.hn>1)S(\"Bedienfeld verbunden\")}function V(e){try{i.pn=0;i.pc=0;i.kt=0;L();Se(\"Pumpe auf Voreinstellung; anlernen: einstecken, 5\\xC3\\x97 dr\\xC3\\xBCcken\")}catch(e){S(\"Fehler Taster: \"+e)}}function G(){return u.ra>0?u.ra:8.6}function I(){return u.au}function j(){var e=u.h?u.h.ra.getValue():(Shelly.getComponentStatus(\"number\",202)||{}).value,t=u.h?u.h.au.getValue():(Shelly.getComponentStatus(\"boolean\",200)||{}).value;u.ra=typeof e===\"number\"&&e>=1&&e<=40?e:0;u.au=t!==false}function q(e){return i.pu&&e.day<=i.pu}function K(e){return t[e-1]}function Q(e){var t=3,n=11;return t<=n?e.m>=t&&e.m<=n:e.m>=t||e.m<=n}function X(e){var n=i.dp<0?0:h(e.day-1-i.dp,0,14),r=h(i.d-i.pi,0,25);return h(r+n*t[e.m-1]*.85,0,25)}function Y(e){var t=G(),n=Math.round(e/t*3600),r=120*60;return n<r?n:r}function $(e){var t=e?i.oa:i.ob;return t>-50?t:e?10:15}function ee(e){var r=w(e).m,i=u.ty,f=1,l;if(i&&i.d===e&&i.n>=100){l=$(1);f=h(1+.06*(i.mx-l-n[r-1]),.5,1.6)}return t[r-1]*f*1.21}function te(){var e=[],t=[],n;i.xd=h(i.xd-i.xw[0],0,25)+i.xe[0];for(n=1;n<i.xe.length;n++){e.push(i.xe[n]);t.push(i.xw[n])}i.xe=e;i.xw=t;i.xa++}function ne(e){var t,n,r,u=i.pi;if(i.dp+1>=e.day)return;if(i.xa<0&&i.dp+1<e.day){i.xd=i.d;i.xe=[];i.xw=[]}i.d=h(i.d-i.pi,0,25);i.pi=0;for(t=i.dp+1;t<e.day;t++){n=i.d;r=ee(t);r=a(r*.85);i.d=h(i.d+r,0,25);if(i.xa<0)i.xa=t;r=a(i.d-n);i.xe.push(r);r=a(u);i.xw.push(r);u=0}while(i.xe.length>14)te();i.dp=e.day-1}function re(e,t){var n,r,i,f;if(t-u.ts<600)return;u.ts=t;n=u.sw;if(n.output||u.run||t-u.A<1800||n.tC===null)return;i=n.tC;f=u.td;if(!f||f.d!==e.day){u.ty=f&&f.d===e.day-1?f:null;f=u.td={d:e.day,n:0,mn:i,mx:i}}f.n++;if(u.est)f.x=1;if(i<f.mn)f.mn=i;if(i>f.mx)f.mx=i;if(u.est)le(i,t);else u.z=null}function ie(e,t,n){var r=u.ty;var f,l;if(!r||r.x||r.d!==e.day-1||r.n<100||t===null||n===null)return;if(n-t<5||r.mx-r.mn<(n-t)/2)return;f=r.mn-t;l=r.mx-n;if(f>-5&&f<50)i.ob=i.ob>-50?a(i.ob+(f-i.ob)*.3):a(f);if(l>-5&&l<50)i.oa=i.oa>-50?a(i.oa+(l-i.oa)*.3):a(l)}function ue(){var e=u.td,t=null;if(e&&e.n)t=e.mn;else if(u.sw.tC!==null)t=u.sw.tC;if(t===null)return null;return t-$(0)-(e&&e.n>=36?0:5)}function fe(){var e=u.sw,t=Shelly.getUptimeMs()/1e3,n,r;if(e.output||u.run||t-u.A<1800||e.tC===null)return null;n=$(0);r=$(1);return e.tC-Math.max(n,r)}function le(e,t){var n=u.z;if(!n){u.z={s:-1,v:e,t:t,mv:e,mt:t,e:null};return}if(n.e&&t-n.e.t>10800)n.e=null;if(n.e&&e>=n.e.v+5){ae(n.e.t);n.e=null}if(n.s<0){if(e<n.v){n.v=e;n.t=t}else if(e>n.v+3){if(n.mv-n.v>=6&&n.t-n.mt>=21600)n.e={t:n.t,v:n.v};n.s=1;n.v=e;n.t=t}}else if(e>n.v){n.v=e;n.t=t}else if(e<n.v-3){n.mv=n.v;n.mt=n.t;n.s=-1;n.v=e;n.t=t}}function ae(e){var t=u.eb+e-u.eu,n=Math.floor(t/86400),r,f,l,a=null,s=Shelly.getUptimeMs()/1e3,o=[];if(!u.est||s-u.zf<72e3)return;o[0]=P(n-1);o[1]=P(n);o[2]=P(n+1);for(r=-1;r<=1;r++){f=(n+r)*86400+o[r+1]*60+600-t;if(u.def?f>-43200&&f<=43200:f>=-10800&&f<75600)a=f}if(a===null)return;f=a-3600;if((u.zn?Math.abs(f):u.def?Math.abs(a):a)<5400)return;l=Math.floor(u.eb+f+s-u.eu);Shelly.call(\"Sys.SetTime\",{unixtime:l},y,oe);u.zf=s;u.zl=f;u.co=i.cs;u.cp=s;i.cs=l}function se(e){if(u.oa){u.oa+=e;if(i.os>1)i.os=Math.floor(u.oa)}if(u.ie&&i.io)i.io=Math.floor(i.io+e);if(i.rt)i.rt=Math.floor(i.rt+e);if(u.want)u.want.exp+=e}function oe(e,t,n){u.cp=0;if(t){i.cs=u.co;S(\"Uhr nicht stellbar: \"+n);return}u.eb+=u.zl;u.zn=1;u.cg++;se(u.zl);L();S(\"Uhr nach Tagesgang um \"+o(u.zl/3600)+\" h gestellt\")}function he(e,t){if(u.def&&t)Qe(z(e).day-z(t).day);if(!(Math.abs(e-t)<=60))u.cg++;if(t)se(e-t);u.eb=e;u.eu=f();u.est=false;u.def=false;u.ie=false;i.ce=0;u.td=null;u.ty=null;L()}function ce(e){var t=[],n;for(n=0;n<u.starts.length;n++)if(e-u.starts[n]<3600)t.push(u.starts[n]);u.starts=t.slice(-10);return t.length}function me(e){var t=u.run;if(t){if(!t.why)t.why=e;t.ot=Shelly.getUptimeMs()/1e3}Shelly.call(\"Switch.Set\",{id:0,on:false},b)}function ge(e,t,n){var r=u.ps,f,l;if(!t)return;f=_();l=(\"Einschalten abgelehnt: \"+n).slice(0,60);u.ps=null;S(l);if(r&&r.k!==\"hand\")u.want={k:r.k,mm:r.mm,exp:r.exp||(f||0)+1800};if(i.ft!==l||!i.fo||!(f&&i.fu>1&&z(i.fu).day===z(f).day)){i.fu=f?Math.floor(f):1;i.ft=l;i.fo=1;Te(\"ab\",n);L()}}function ve(e,t){var n=f(),r=u.sw;if(u.ps&&n>u.ps.B)u.ps=null;if(u.run||r.output||u.ps)return\"l\\xC3\\xA4uft\";if(u.weld)return\"Relais\";if(u.A&&n-u.A<120)return\"Pause\";if(ce(n)>=10)return\"Starts\";var i=Y(t);if(i<60)return\"kurz\";Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:i},y,ge);u.ps={k:e,mm:i*G()/3600,sec:i,B:n+15};return null}function Se(e){u.note=e;u.W=Shelly.getUptimeMs()/1e3;S(e)}function pe(e,t){var n=f(),r=u.ps,s=_(),o,c,m,g=0,v;u.ps=null;if(r&&(t||n<=r.B)){o=r.k;c=r.mm;m=r.sec}else{o=\"hand\";if(ce(n)>=10){Se(\"Zu viele Starts in einer Stunde \\xE2\\x80\\x93 Pumpe gesch\\xC3\\xBCtzt\");u.starts.push(n);me(\"starts\");return}v=0;if(u.boot&&e.timer_duration)v=s&&e.timer_started_at>1767225600?h(s-e.timer_started_at,0,n):n;if(u.boot&&e.timer_duration&&e.timer_duration<7800){g=e.timer_duration-v;m=l(h(Math.min(g,120*60-v),1,e.timer_duration));if(m<g-5)Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:m},b);c=m*G()/3600}else{c=h(s?X(z(s)):6,6,15);m=l(h(Math.min(Y(c),120*60-v),1,120*60));c=m*G()/3600;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:m},b)}u.want=null;if(i.rt){i.rt=0;L()}}u.starts.push(n);u.run={k:o,t0:n,lt:n,u0:s||0,sec:m,mm:c,ps:0,cr:0,ck:n,pf:-1,u:0,o:0,n:0,i:0,why:\"\",det:\"\",ref:o===\"retry\"?i.rq:0,rs:0,rn:0};S(\"Pumpe an (\"+o+\"), Ziel \"+a(c)+\" mm in \"+l(m/60)+\" min\")}function de(e){var t=e.ps*G()/3600,n=t-e.cr;if(n>0){i.pi=i.pi+n;e.cr=t}}function be(e,t){u.run.why=e;u.run.det=t;S(\"Schutz: \"+e+\" (\"+t+\")\");me(e)}function ye(){return!i.pn?600:i.pc?(i.pn+i.pc)/2:i.pn*.75}function ke(){return i.pn?i.pn*1.3:2100}function we(e){var t=u.run,n=f(),r=n-t.t0,a=h(n-t.lt,0,5);var s=m(e.apower),c=m(e.current),g=ye(),v=ke();t.lt=n;if(t.why){if(!(n-t.ot<5))me(t.why);return}if(r>t.sec+60){me(\"ende\");return}t.pf=t.pf<0?s:t.pf+(s-t.pf)*.3;if(!i.pn&&r>=40+10&&r<40+20&&!t.ref&&t.pf<=v){t.rs+=t.pf;t.rn++}if(!i.pn&&r>=40+20){if(!t.ref&&t.rn)t.ref=t.rs/t.rn;g=Math.max(g,t.ref*(1-.2))}t.i=r>=2&&c>10.5?t.i+1:0;if(t.i>=2){be(\"blockiert\",o(c)+\" A\");return}t.n=r>=3&&s<50?t.n+1:0;if(t.n>=5){be(\"keinStrom\",l(s)+\" W\");return}t.o=r>=40&&t.pf>v?t.o+1:0;if(t.o>=5){be(\"ueberlast\",l(t.pf)+\" W > \"+l(v)+\" W\");return}t.u=r>=40&&s>=50&&t.pf<g?t.u+1:0;if(t.u>=8){be(\"unterlast\",l(t.pf)+\" W < \"+l(g)+\" W\");return}if(t.pf>=g)t.ps+=a;if(n-t.ck>=1800){de(t);L();t.ck=n}}var Me={unterlast:\"Trockenlauf oder Hahn zu\",ueberlast:\"\\xC3\\x9Cberlast\",blockiert:\"Pumpe blockiert\",keinStrom:\"Pumpe zieht keinen Strom\",start:\"Pumpe lief nicht an\"};var ze={auto:\"Automatik\",retry:\"Nachlauf\",hand:\"Hand\",kal:\"Anlernen\"};var Ae={fw:\"Firmware-Schutz\",ab:\"Einschalten abgelehnt\",rk:\"Relais klebt\",ka:\"Anlernen abgebrochen\"};function Te(e,t){var n=_();u.fl=u.fl.slice(-4);u.fn=true;L();u.fl.push((n&&n<1e10?String(Math.floor(n)):\"0000000000\")+(u.est?\"~\":\" \")+e+\":\"+String(t||\"\").slice(0,16))}function We(e){var t=u.run,n=f(),r=_(),s=t.why,h=e.errors&&e.errors.length;u.run=null;u.A=n;if(t.k===\"kal\"){u.cue=0;u.lx=1}de(t);if(h&&(!Me[s]||s===\"start\"))s=\"fw\";var c=s===\"fw\"||!!Me[s],m=c&&s===\"fw\"?String(e.errors):\"\";var g=c?m?\"Firmware-Schutz: \"+m:Me[s]+(t.det?\" (\"+t.det+\")\":\"\"):\"\";if(c){i.fu=r?Math.floor(r):1;i.ft=g.slice(0,60);i.fo=1;Te(s,m||t.det)}else if(t.ps>=60&&(t.k!==\"kal\"||s===\"angelernt\"))i.fo=0;if(t.k===\"hand\"||t.k===\"kal\")i.sh++;else i.sa++;if(t.k===\"kal\"&&t.kp){if(!c){Te(\"ka\",\"ausgeschaltet\");i.fu=r?Math.floor(r):1;i.ft=\"Anlernen abgebrochen: ausgeschaltet\";i.fo=1}u.sv=-1e9;Se(\"Anlernen abgebrochen: \"+(g||\"ausgeschaltet\")+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\")}i.sm=a(i.sm+t.cr);if(c)i.sf++;if(r){var v=z(r),p=z(t.u0||r);i.lr=W(p.day)+\" \"+T(p.min)+\" \"+ze[t.k]+\" \"+o(t.cr)+\" mm\"+(c?\" \\xE2\\x80\\x93 abgebrochen\":\"\");if(c&&(t.k===\"auto\"||t.k===\"retry\")){if(i.fd!==v.day){i.fd=v.day;i.fc=0}i.fc++;var d=t.mm-t.cr,b=s===\"unterlast\"?2:1;i.rt=0;if(d>=2&&i.fc<=b){i.rt=Math.floor(r)+(n-t.t0<10?6:60)*60;i.rm=a(d);i.rq=s===\"unterlast\"?l(t.ref||0):0}}}S(\"Pumpe aus: \"+(s||\"Ende/Stopp\")+\", \"+a(t.cr)+\" mm gegeben\");L()}function Pe(e){var t=f(),n=m(e.apower);if(u.A&&t-u.A<5)return;if(n>50){u.wc++;if(u.wc>=5){if(!u.weld){S(\"Relais klebt? \"+l(n)+\" W bei AUS\");Te(\"rk\",l(n)+\" W\");L()}u.weld=true;if(u.wc%30===5)Shelly.call(\"Switch.Set\",{id:0,on:false},b)}}else{u.wc=0;u.weld=false}}function _e(e){var t=e?e.delta:null,n=f(),r;if(!t||e.component!==\"switch:0\"||typeof t.output!==\"boolean\"||t.output===u.ko)return;u.ko=t.output;if(n>60||t.source===\"loopback\"||u.run&&u.run.why)return;r=u.kts.slice(-4);r.push(n);u.kts=r;u.kw=r.length===5&&t.output&&n-r[0]<=10?1:0}function Ee(){var e=u.run;u.kw=0;e.k=\"kal\";e.kp=1;e.kt=f();e.ks=0;e.kn=0;e.kl=1e9;e.kh=0;e.kn0=0;e.sec=300+40-40;Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:e.sec},b);Se(\"Anlernen: Hahn offen lassen; wird die LED wei\\xC3\\x9F, Hahn zudrehen\")}function Fe(e){var t=u.run;t.ks+=e;t.kn++;if(e<t.kl)t.kl=e;if(e>t.kh)t.kh=e}function Le(e){var t=u.run,n=f(),r=n-t.kt,i=h(n-t.lt,0,5),a=m(e.apower),s=m(e.current),c=\"\";t.lt=n;if(t.why){if(!(n-t.ot<5))me(t.why);return}t.i=r>=2&&s>10.5?t.i+1:0;t.n=r>=3&&a<50?t.n+1:0;if(t.i>=2)be(\"blockiert\",o(s)+\" A\");else if(t.n>=5)be(\"keinStrom\",l(a)+\" W\");else if(t.kp===1){t.ps+=i;if(r>=40+5)Fe(a);if(r>=40+20)c=Ne()}else if(t.kp===2){t.kd=a<t.kn0*.92?t.kd+1:0;if(!t.kd)t.ps+=i;if(t.kd>=3){t.kp=3;t.kt=n;t.ks=0;t.kn=0;t.kl=1e9;t.kh=0}else if(r>=40+140)c=xe(0)}else if(t.kp===3){if(r>=10)Fe(a);if(r>=20)c=xe(1)}if(c)He(c,t.kx)}function Ne(){var e=u.run,t=e.kn?e.ks/e.kn:0;if(t<300)return l(t)+\" W zu wenig\";if(t>1900)return l(t)+\" W zu viel\";if(e.kh>e.kl*1.15)return\"unruhig \"+l(e.kl)+\"-\"+l(e.kh)+\" W, zu fr\\xC3\\xBCh zugedreht oder Luft im Rohr?\";e.kn0=l(t);e.kp=2;e.kd=0;u.cue=1;u.lx=1;S(\"Anlernen: Normalleistung \"+e.kn0+\" W, jetzt Hahn zudrehen (LED wei\\xC3\\x9F)\");return\"\"}function xe(e){var t=u.run,n=_(),r=t.kn?t.ks/t.kn:0,f=1-r/t.kn0,a=\"\",s;if(!e)a=\"Hahn nicht zugedreht\";else if(t.kh>t.kl*1.1)a=\"Hahn zu unruhig\";else if(f<.2)a=\"Hahn zu nur \"+l(f*100)+\" % weniger, nicht erkennbar\";if(a&&t.kn0<600){t.kx=\"trocken? \"+t.kn0+\" W\";return a+\"; unter \"+600+\" W nur mit Zudrehen (Trockenlauf?)\"}i.pn=t.kn0;i.pc=a?0:l(r);i.kt=n?Math.floor(n):1;L();u.sv=-1e9;s=l(ye());a=(a?a+\", \":\"Hahn zu \"+i.pc+\" W, \")+\"Untergrenze \"+s+\" W\";t.kp=0;Se(\"Angelernt: \"+i.pn+\" W, \"+a);me(\"angelernt\");return\"\"}function He(e,t){var n=_();u.run.kp=0;Te(\"ka\",t||e);u.sv=-1e9;i.fu=n?Math.floor(n):1;i.ft=(\"Anlernen abgebrochen: \"+e).slice(0,60);i.fo=1;Se(\"Anlernen abgebrochen: \"+e+\" \\xE2\\x80\\x93 nichts \\xC3\\xBCbernommen\");me(\"abbruch\")}function Oe(e){return\"https://api.open-meteo.com/v1/forecast?latitude=\"+u.la+\"&longitude=\"+u.lo+\"&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min,\"+\"temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=\"+e}function Ue(e,t,n){u.wx.busy=true;u.wx.L=e;u.wx.n=t;u.wx.rc=n;u.wx.t=f();u.wx.q++;u.wx.cg=u.cg;Shelly.call(\"HTTP.GET\",{url:Oe(t),timeout:20},Ce,u.wx.q)}function Re(e){if(!Q(e)){i.ev=e.day;i.d=0;i.pi=0;i.dp=e.day-1;i.rt=0;i.xa=-1;i.xe=[];i.xw=[];u.why=\"Winterpause\";L();return}if(i.dp<0||e.day-1-i.dp>14){i.d=0;i.pi=0;i.dp=e.day-1-(i.dp<0?0:14)}while(i.xe.length&&e.day-i.xa>14)te();if(!i.xe.length)i.xa=-1;if(u.la===null){ne(e);Ze(e,null,false);return}Ue(e,e.day-(i.xa>=0?i.xa:i.dp+1),false)}function Be(e,t){return e&&typeof e[t]===\"number\"?e[t]:null}function De(e,t,n){return{rain:Be(e.precipitation_sum,t)||0,prob:Be(e.precipitation_probability_max,t)||0,tmin:Be(e.temperature_2m_min,t),tnow:n&&typeof n.temperature_2m===\"number\"?n.temperature_2m:null}}function Ce(e,t,n,r){var f=u.wx.L,l=u.wx.rc,a=JSON.stringify(i);try{Je(e,t,n,r)}catch(e){S(\"Fehler Wetterantwort: \"+e);i=JSON.parse(a);u.wx.busy=true;u.wx.rc=l;try{Je(null,-1,\"Fehler\",r)}catch(e){S(\"Fehler Tagespr\\xC3\\xBCfung: \"+e);i=JSON.parse(a);u.wx.busy=false;u.wx.rc=false;if(f&&!l){i.ev=f.day;u.why=\"Fehler, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen\";L()}}}}function Je(e,t,n,r){var l=u.wx.L,a=u.wx.n,s=false,o=null,c=null,m,g,v,S,p,d;if(r!==u.wx.q||!u.wx.busy)return;u.wx.busy=false;if(u.wx.cg!==u.cg){if(u.wx.rc){u.wx.rc=false;u.rh=0}return}try{if(!t&&e&&e.code===200){o=JSON.parse(e.body);c=o.daily;s=c&&c.time&&c.time.length===a+1&&c.time[a]===A(l)}}catch(e){s=false}if(u.wx.rc){u.wx.rc=false;if(s)Ze(l,De(c,a,o.current),true);else if(i.rc===l.day&&(i.rk===1||i.rk===3))Ze(l,null,true);return}if(!s){if(!u.oa)u.oa=_()||0;u.wx.T++;d=_();if(u.wx.T<(u.est||u.off?1:4)&&d&&z(d).min+21<750){u.wx.next=f()+1200;return}Ke(true);ne(l);Ze(l,null,false);return}for(m=0;m<a;m++){g=l.day-a+m;v=Be(c.et0_fao_evapotranspiration,m);S=Be(c.precipitation_sum,m);if(v===null)v=K(w(g).m);if(S===null)S=0;p=v*.85-Math.max(0,S-1);if(g>i.dp){i.d=h(h(i.d-i.pi,0,25)+p,0,25);i.pi=0}else if(i.xa>=0&&g>=i.xa){if(g===i.xa)i.d=i.xd;i.d=h(h(i.d-(i.xw[g-i.xa]||0),0,25)+p,0,25)}}i.xa=-1;i.xe=[];i.xw=[];i.d=h(i.d-i.pi,0,25);i.pi=0;i.dp=l.day-1;u.nf=false;if(a>=1){S=Be(c.precipitation_sum,a-1);u.nf=i.rd===l.day-1&&S!==null&&S-1<i.rx/2;ie(l,Be(c.temperature_2m_min,a-1),Be(c.temperature_2m_max,a-1))}Ke(false);Ze(l,De(c,a,o.current),false)}function Ze(e,t,n){var r=X(e),f=0,l=0,s=_(),h=e.min,c=null,m=false,g,v,p,d,b,y,k,M,A,P,E,F,N,x,H=n&&i.rc===e.day?i.rk:0;if(s)h=z(s).min;u.wx.T=0;if(u.run){L();return}v=i.ev<0?null:w(i.ev);if(!v||!Q(v)||e.day-i.ev>60){i.s0=e.day;i.sa=0;i.sh=0;i.sm=0;i.sf=0}i.ev=e.day;i.rc=-1;i.rk=0;if(H===1||H===3){c=i.rf;m=H===3}else if(t&&t.tmin!==null)c=t.tmin<5?t.tmin:null;else{c=ue();if(c!==null){if(c>=5)c=null;else m=true}}g=t&&t.tnow!==null?t.tnow:fe();p=o(r);d=c===null?\"\":o(c);b=t?o(t.rain):\"\";y=T(h);k=T(750);M=i.pu?W(i.pu):\"\";if(t&&t.prob>=60&&!u.nf)f=Math.max(0,t.rain-1);A=Math.min(15,r-f);P=f>0&&A<Math.min(15,r);E=Y(A)*G()/3600;E=o(E);F=a(f);N=c===null?0:a(c);x=(Math.floor(h/60)+1)*60+5;if(!I())u.why=\"Automatik aus\";else if(q(e))u.why=\"Pause bis \"+M;else if(r<8)u.why=\"nicht n\\xC3\\xB6tig (\"+p+\" mm)\";else if(c!==null&&!(g>=5)){u.why=\"Frostsperre (\"+(m?\"gesch\\xC3\\xA4tzt \":\"\")+d+\" \\xC2\\xB0C), gie\\xC3\\x9Ft ab \"+5+\" \\xC2\\xB0C\";i.rc=e.day;i.rk=m?3:1;i.rf=N;u.rh=x}else{l=A;if(P){i.rd=e.day;i.rx=F}else if(i.rd===e.day)i.rd=-1;if(l<5&&f>0){u.why=\"Regen erwartet (\"+b+\" mm, \"+t.prob+\" %)\"+(H===2?\", \"+y+\" best\\xC3\\xA4tigt\":\"\");i.rc=e.day;i.rk=2;u.rh=x}else if(l<5)u.why=\"nicht n\\xC3\\xB6tig (\"+p+\" mm)\";else if(h>=750){u.why=k+\" vorbei, nicht mehr gestartet\";l=0}else u.why=(H===2?\"Regen abgesagt, \":H?\"Frost vorbei, \":\"\")+\"gegossen \"+E+\" mm\"+(u.nf?\" (gestern Regen ausgeblieben)\":\"\")}S(\"Tagespr\\xC3\\xBCfung: Defizit \"+a(r)+\" mm\"+(t?\"\":\" (ohne Internet)\")+\" -> \"+u.why);if(l>=5)u.want={k:\"auto\",mm:l,exp:(s||0)+7200};L()}function selfTest(){if(u.la===null)return\"FEHLER Ort unbekannt: \"+e.l;if(!u.st){u.st=\"l\\xC3\\xA4uft\";Shelly.call(\"HTTP.GET\",{url:Oe(14),timeout:20},y,Ve)}return u.st===\"ok\"?\"ok, Ort \"+u.la+\" \"+u.lo:u.st}function Ve(e,t,n){var r=false;try{r=!t&&e.code===200&&JSON.parse(e.body).daily.time.length===15}catch(e){r=false}u.st=r?\"ok\":\"FEHLER \"+(n||\"Antwort\");S(\"Selbsttest Wetter: \"+u.st)}function Ge(){var e=Shelly.getComponentStatus(\"sys\"),t=k(2026,4,1)*86400+600*60-(1+1)*3600;u.H=0;if(e&&typeof e.unixtime===\"number\"&&e.unixtime>1767225600)return;u.def=true;u.est=true;u.eb=t;u.eu=f();i.df=1;i.ce=1;i.cs=t;Shelly.call(\"Sys.SetTime\",{unixtime:t},b);S(\"Uhrzeit unbekannt \\xE2\\x80\\x93 Einstecken gilt als 1. April \"+T(600));L()}function Ie(){u.gn=f()+900;Shelly.call(\"HTTP.GET\",{url:\"https://geocoding-api.open-meteo.com/v1/search?count=1&name=\"+u.oq+\"&countryCode=\"+e.S,timeout:20},y,qe)}function je(e){var t=\"\",n=0,r,i,u,f=\"0123456789ABCDEF\";while(n<e.length){r=e.charCodeAt(n);i=e.charCodeAt(n+1);u=-1;if(r>47&&r<58||r>64&&r<91||r>96&&r<123)t+=e.charAt(n);else if(r<128)t+=\"%\"+f.charAt(r>>4)+f.charAt(r&15);else if(r>193&&r<224&&i>127&&i<192){u=i;n++}else{u=128|r&63;r=192|r>>6}if(u>=0)t+=\"%\"+f.charAt(r>>4)+f.charAt(r&15)+\"%\"+f.charAt(u>>4)+f.charAt(u&15);n++}return t}function qe(t,n,r){var f=null,l;try{if(!n&&t&&t.code===200)f=JSON.parse(t.body)}catch(e){f=null}if(!f)return;l=f.results&&f.results[0];if(!l){if(!u.gx)S(\"Ort \"+e.l+\" nicht gefunden \\xE2\\x80\\x93 Schreibweise pr\\xC3\\xBCfen oder LAT/LON eintragen\");u.gx=true;return}if(!c(l.latitude)||!c(l.longitude)||Math.abs(l.latitude)>90||Math.abs(l.longitude)>180)return;u.gx=false;u.la=i.la=s(l.latitude);u.lo=i.lo=s(l.longitude);i.pz=e.S+e.l;L();S(\"Ort \"+e.l+\": \"+u.la+\", \"+u.lo)}function Ke(e){var t=_();if(e&&!u.oa)u.oa=t||0;if(e&&!u.off)u.O=f()+900;if(!e){if(u.off&&u.oa&&t){i.io=Math.floor(u.oa);i.id=Math.max(0,l((t-u.oa)/60));u.ie=u.est}u.oa=0}u.off=e;i.os=e?Math.floor(u.oa)||1:0}function Qe(e){if(i.ev>=0)i.ev+=e;if(i.dp>=0)i.dp+=e;if(i.fd>=0)i.fd+=e;if(i.pu)i.pu+=e;if(i.xa>=0)i.xa+=e;if(i.rd>=0)i.rd+=e;if(i.rc>=0)i.rc+=e;if(i.fu>1)i.fu+=e*86400;if(i.io&&!u.ie)i.io+=e*86400;if(i.s0>0)i.s0+=e;i.rt=0;i.df=0;u.td=null;u.ty=null;u.z=null;S(\"Echte Uhrzeit da: Tagesmarken um \"+e+\" Tage verschoben\")}function Xe(){var e=u.kh;if(e>=0&&f()>62){u.kh=-1;u.kw=0;Shelly.removeStatusHandler(e)}if(u.H&&f()>=u.H)Ge();if(f()>=u.cfgAt){u.cfgAt=f()+3600;St();bt()}if(!u.h&&f()-u.hb>=(u.hn<10?60:3600))B();if(!u.h)j();if(u.la===null&&f()>=u.gn)Ie();var t=_();if(!t)return;var n=z(t),r=f();if(u.est&&!(u.cp&&r-u.cp<60)&&(Math.abs(t-(u.eb+r-u.eu))>5||E())){he(t,u.eb+r-u.eu)}if(i.ev>n.day||i.dp>n.day-1||i.pu>n.day+14){if(i.ev>n.day)i.ev=-1;if(i.dp>n.day-1)i.dp=n.day-1;if(i.pu>n.day+14)i.pu=0;i.rt=0;L()}if(t-i.t>=21600)L();re(n,r);if(u.off&&u.la!==null&&!u.wx.busy&&r>=u.O){u.O=r+900;Shelly.call(\"HTTP.GET\",{url:\"https://api.open-meteo.com/v1/forecast?latitude=\"+u.la+\"&longitude=\"+u.lo+\"&daily=temperature_2m_min&timezone=auto&forecast_days=1\",timeout:10},y,Ye)}if(i.pu&&n.day>i.pu){i.pu=0;L()}if(u.run&&(u.run.k===\"auto\"||u.run.k===\"retry\")&&(!I()||q(n)))me(\"aus\");var l=u.est&&r<600;var a=Q(n),s=!l&&n.min>=600&&n.min<750&&a;if(!l&&i.ev!==n.day&&n.min>=600&&n.min<750&&!u.wx.busy&&r>=u.wx.next&&!u.run&&!u.ps){Re(n)}if(s&&i.rc===n.day&&n.min>=u.rh&&!u.wx.busy&&!u.run&&!u.ps){u.rh=(Math.floor(n.min/60)+1)*60+5;if(u.off||u.la===null)Ze(n,null,true);else Ue(n,0,true)}if(u.want&&!l){if(t>u.want.exp||!I()||n.min>=750||!a)u.want=null;else if(s&&!ve(u.want.k,u.want.mm)){u.ps.exp=u.want.exp;u.want=null}}if(i.rt&&t>=i.rt&&!u.run&&!l){if(n.min>=750||!I()||q(n)||i.fd!==n.day||!a){i.rt=0;L()}else if(s&&!ve(\"retry\",i.rm)){i.rt=0;L()}}}function Ye(e,t,n){if(!t&&e&&e.code===200&&u.off){Ke(false);L()}}function $e(t){var n=[],r=T(600);if(!t)n.push(\"Uhrzeit unbekannt\");else if(u.def)n.push(\"Uhr angenommen: Einstecken = \"+r);else if(u.est)n.push(\"Uhr gesch\\xC3\\xA4tzt\");if(u.la===null)n.push(\"Ort \"+(u.gx?e.l+\" nicht gefunden\":\"unbekannt\"));else if(u.off)n.push(\"ohne Internet\");if(u.P)n.push(\"Speicher schreibt nicht\");return{e:u.weld?\"Relais klebt\":u.P?\"Speicher schreibt nicht\":i.fo?\"St\\xC3\\xB6rung: \"+i.ft:\"\",w:n}}function et(e){var t=u.run,n,r,f,l=i.fu>1?z(i.fu):null,a=i.rt?z(i.rt):null,s=Shelly.getUptimeMs()/1e3,h=T(600),c=T(750),m=i.pu?W(i.pu):\"\",g=l?T(l.min):\"\",S,p;if(u.weld)return\"ALARM: Pumpe zieht Strom trotz AUS \\xE2\\x80\\x93 Relais klebt? Stecker ziehen!\";if(t){n=t.sec-(s-t.t0);S=o(t.mm);p=Math.round(n/60);f=Math.round(u.sw.apower||0);if(t.k===\"kal\")return\"Anlernen: \"+(t.kp===1?\"Hahn offen lassen, Normalleistung messen\":t.kp===2?\"LED wei\\xC3\\x9F: jetzt Hahn zudrehen\":t.kp===3?\"Hahn-zu-Leistung messen\":\"wird beendet\")+\", \"+f+\" W\";return\"Beregnung (\"+ze[t.k]+\"): \"+S+\" mm, noch \"+(p>0?p:0)+\" min, \"+f+\" W\"}if(!e)return\"Uhrzeit unbekannt \\xE2\\x80\\x93 Automatik wartet auf Internet. Taster geht.\";if(i.fo&&(!l||l.day===e.day)){p=a?T(a.min):\"\";n=\"St\\xC3\\xB6rung\"+(l?\" \"+g:\"\")+\": \"+i.ft;S=i.ev!==e.day&&e.min<750?\"heute \":\"morgen \";n+=a?\". Nachlauf \"+p:u.want?\". Neuer Versuch bis \"+c:\". N\\xC3\\xA4chster Versuch \"+S+h}else if(!Q(e))n=\"Winterpause bis 01.\"+v(3)+\". \\xE2\\x80\\x93 Taster geht\";else if(!I())n=\"Automatik aus \\xE2\\x80\\x93 Taster geht\";else if(q(e))n=\"Pause bis \"+m;else if(i.ev===e.day)n=\"Heute: \"+(u.why||\"gepr\\xC3\\xBCft\");else if(e.min<600)n=\"Bereit, Pr\\xC3\\xBCfung \"+h;else n=e.min<750?\"Pr\\xC3\\xBCfung l\\xC3\\xA4uft\":\"Heute nicht gepr\\xC3\\xBCft, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen \"+h;if(i.fo&&l&&l.day!==e.day){S=W(l.day);n+=\" \\xC2\\xB7 St\\xC3\\xB6rung \"+S+\" \"+g+\": \"+i.ft}f=$e(e).w;for(r=0;r<f.length;r++)n+=\" \\xC2\\xB7 \"+f[r];if(i.lr)n+=\" \\xC2\\xB7 Zuletzt \"+i.lr;if(u.note&&s-u.W>43200)u.note=\"\";if(u.note)n+=\" \\xC2\\xB7 \"+u.note;else if(i.pn)n+=\" \\xC2\\xB7 Pumpe angelernt \"+i.pn+\" W\";while(n.length>230&&n.lastIndexOf(\" \\xC2\\xB7 \")>0)n=n.slice(0,n.lastIndexOf(\" \\xC2\\xB7 \"));return n.length>230?n.slice(0,230):n}function tt(){var e=_(),t=e?z(e):null,n;ft(t);if(!u.h)return;try{for(n in u.h)if(n!==\"re\"&&u.hl<3&&typeof u.h[n].getStatus===\"function\"&&u.h[n].getStatus()===undefined)throw\"fehlt \"+n;nt(t)}catch(e){S(\"Bedienfeld neu: \"+e);u.hl++;try{u.h.re.off(u.hr);u.hr=-1}catch(e){}u.h=null;u.hn=0;u.hb=0;u._=-1;u.F=\"\";u.N=-1;j()}}function nt(e){var t,n,r,f;j();r=u.h.pa.getValue();if(e&&c(r)&&u._>=0&&r!==u._){r=l(h(r,0,14));i.pu=r>0?e.day+r-1:0;i.rt=0;u.want=null;L();f=r>0?W(i.pu):\"\";S(\"Pause \"+(r>0?\"bis \"+f:\"aufgehoben\"))}n=e&&q(e)?i.pu-e.day+1:0;if(n!==u._){u.h.pa.setValue(n);u._=n}t=et(e);if(t!==u.F){u.h.st.setValue(t);u.F=t}n=e?a(X(e)):0;if(n!==u.N){u.h.bk.setValue(n);u.N=n}}function rt(e,t){return e&&t&&e[0]===t[0]&&e[1]===t[1]&&e[2]===t[2]}function it(){var e=Shelly.getComponentConfig(\"plugs_ui\"),t,n,i;u.led=\"?\";u.ledOn=\"?\";if(!e||!e.leds||e.leds.mode!==\"switch\"||!e.leds.colors||!e.leds.colors[\"switch:0\"])return;t=e.leds.colors[\"switch:0\"].off;n=e.leds.colors[\"switch:0\"].on;for(i in r)if(i!==\"run\"&&i!==\"cue\"&&t&&rt(t.rgb,r[i])&&t.brightness===100)u.led=i;if(n&&rt(n.rgb,r.run)&&n.brightness===100)u.ledOn=\"run\"}function ut(e){return e.e?\"err\":e.w.length?\"warn\":\"ok\"}function ft(e){var t=ut($e(e)),n=u.cue?\"cue\":\"run\",i=f(),l=[],a;if(t!==u.U){u.U=t;u.R=i}if(t===u.led&&n===u.ledOn){u.lx=0;return}if(!u.lx&&i-u.R<(t===\"err\"||u.led===\"?\"||u.ledOn===\"?\"?120:1800))return;for(a=0;a<u.ledN.length;a++)if(i-u.ledN[a]<86400)l.push(u.ledN[a]);u.ledN=l;if(l.length>=12&&t!==\"err\"&&!u.lx)return;Shelly.call(\"PLUGS_UI.SetConfig\",{config:{leds:{mode:\"switch\",colors:{\"switch:0\":{on:{rgb:r[n],brightness:100},off:{rgb:r[t],brightness:100}}}}}},y,lt);u.led=t;u.ledOn=n;u.ledN.push(i);u.nl++;u.lx=0}function lt(e,t,n){if(t){S(\"LED nicht gesetzt: \"+n);u.led=\"?\";u.ledOn=\"?\";u.R=f()+3480}}function at(e){var t=z(e);return W(t.day)+t.y+\" \"+T(t.min)}function st(){try{var e=Shelly.getDeviceInfo();return e&&e.ver||\"?\"}catch(e){return\"?\"}}function ot(e){var t=Math.round(e/60),n=Math.round(t/60),r=Math.round(t/1440);return t<120?t+\" min\":t<2880?n+\" h\":r+\" Tage\"}var ht={ok:\"gr\\xC3\\xBCn\",warn:\"gelb\",err:\"rot\"};function info(){var t=_(),n=t?z(t):null,r=$e(n),f=Shelly.getUptimeMs()/1e3,a,s,h,c=ut(r),m=et(n),g=r.w.join(\", \"),v=t?at(t):\"\\xE2\\x80\\x93 Uhrzeit unbekannt\",S=i.fu>1?at(i.fu)+\" \":\"\",p=i.s0>0?W(i.s0):\"-\",d=o(i.sm),b=n?X(n):i.d,y=i.ob>-50?o(i.ob):\"-\",k=i.oa>-50?o(i.oa):\"-\",w=u.off&&u.oa?at(u.oa):\"\",M=i.io?at(i.io):\"\",A=i.io?ot(i.id*60):\"\",T=st(),P=t?at(t-f):\"?\",E=ot(f),F=u.t0>1767225600?at(u.t0):\"\",L=ot(f-u.s0),N=l(ye()),x=l(ke()),H=i.kt>1?\" \"+at(i.kt):\"\";b=o(b);h=\"Bew\\xC3\\xA4sserung \"+v+\"\\n\\nStatus: \"+m+\"\\nLED: \"+(ht[u.led]||\"noch nicht gesetzt\")+(c!==u.led?\", wechselt bald auf \"+ht[c]:\"\")+\" \\xE2\\x80\\x93 \"+(r.e||g||\"alles in Ordnung\")+\"\\nLetzte St\\xC3\\xB6rung: \"+(i.ft?S+i.ft+(i.fo?\" (offen)\":\" (erledigt)\"):\"keine\")+\"\\nLetzter Lauf: \"+(i.lr||\"keiner\")+\"\\nSaison seit \"+p+\": Automatik \"+i.sa+\", Hand \"+i.sh+\", zusammen \"+d+\" mm, St\\xC3\\xB6rungen \"+i.sf+\"\\nPumpe: \"+(i.pn?\"angelernt\"+H+\", normal \"+i.pn+\" W, Hahn zu \"+(i.pc?i.pc+\" W\":i.kt?\"nicht erkannt\":\"nicht gemessen\"):\"Voreinstellung, nicht angelernt\")+\"; Untergrenze \"+N+\" W, Obergrenze \"+x+\" W\"+\"\\nBodenkonto \"+b+\" mm, Eigenw\\xC3\\xA4rme F\\xC3\\xBChler Nacht/Tag \"+y+\" / \"+k+\" K\"+\"\\nUhr: \"+(!t?\"unbekannt\":u.def?\"angenommen\":u.est?\"gesch\\xC3\\xA4tzt\":\"Zeitserver\")+\"\\nInternet: \"+(u.off?\"Wetterdienst fehlt\"+(u.oa?\" seit \"+w:\"\"):u.la===null?\"ohne Ort kein Wetterabruf\":\"ok\")+(i.io?\", letzter Ausfall \"+M+\", \"+A:\"\")+\"\\nOrt: \"+e.l+(u.la===null?u.gx?\" nicht gefunden\":\" noch unbekannt\":\" \"+u.la+\", \"+u.lo)+\"\\nGer\\xC3\\xA4t: Firmware \"+T+\", an seit \"+P+\" (\"+E+\")\"+(u.t0>1767225600?\", davor zuletzt gespeichert \"+F:\"\")+\"; Skript l\\xC3\\xA4uft seit \"+L+\"\\nFlash-Schreibvorg\\xC3\\xA4nge seit Skriptstart: Speicher \"+u.nw+\", Einstellungen \"+u.nc+\", LED \"+u.nl+\"\\n\\nSt\\xC3\\xB6rungen (gespeichert, neueste zuerst):\"+(u.fl.length?\"\":\" keine\");a=u.fl.length-1;while(a>=0){h+=ct(u.fl[a]);a--}h+=\"\\n\\nLetzte Meldungen (seit Skriptstart):\";s=u.lg.length;a=1;while(a<=s){h+=mt(u.lg[(u.li-a+s)%s]);a++}return h}function ct(e){var t=Number(e.slice(0,10)),n=e.indexOf(\":\"),r=e.slice(11,n),i=e.slice(n+1),u=t>1?at(t):\"\";return\"\\n\"+(u?(e.charAt(10)===\"~\"?\"~\":\"\")+u:\"Zeit unbekannt\")+\" \"+(Me[r]||Ae[r]||r)+(i?\" (\"+i+\")\":\"\")}function mt(e){var t=Number(e.slice(0,10)),n=t?z(t):null,r=n?W(n.day):\"\",i=n?T(n.min):\"\";return\"\\n\"+(n?r+(e.charAt(10)===\"~\"?\" ~\":\" \")+i:\"--.-- --:--\")+\" \"+e.slice(11)}function gt(e,t){try{t.body=info();t.code=200}catch(e){t.body=\"Fehler: \"+e;t.code=500}try{t.headers=[[\"Content-Type\",\"text/plain; charset=utf-8\"]];t.send()}catch(e){S(\"Diagnose-Seite: \"+e)}}function vt(){var e;u.k++;try{e=p();d(e);u.u=_()||0;if(u.kw&&u.run&&u.run.k===\"hand\"&&e.output)Ee();if(e.output&&!u.run)pe(e);else if(!e.output&&u.run)We(e);else if(e.output&&u.run&&u.run.k===\"kal\")Le(e);else if(e.output&&u.run)we(e);else if(u.ps&&f()>u.ps.B){pe(e,1);u.run.why=\"start\";We(e)}if(!e.output)Pe(e);u.boot=false}catch(e){S(\"Fehler Takt: \"+e)}if(u.k%30===1&&u.wx.busy&&f()-u.wx.t>60)Ce(null,-1,\"keine Antwort\",u.wx.q);if(u.k%30===1){try{Xe()}catch(e){S(\"Fehler Plan: \"+e)}}if(u.k%10===2||u.lx){try{tt()}catch(e){u.lx=0;S(\"Fehler Anzeige: \"+e)}}try{N()}catch(e){S(\"Fehler Speicher: \"+e)}}function St(){var e=Shelly.getComponentConfig(\"switch\",0)||{},t={},n=false;if(e.initial_state!==\"off\"){t.initial_state=\"off\";n=true}if(e.auto_off!==true){t.auto_off=true;n=true}if(e.auto_off_delay!==7800){t.auto_off_delay=7800;n=true}if(e.auto_on===true){t.auto_on=false;n=true}if(e.autorecover_voltage_errors===true){t.autorecover_voltage_errors=false;n=true}if(e.name!==\"Brunnenpumpe\"){t.name=\"Brunnenpumpe\";n=true}if(n){Shelly.call(\"Switch.SetConfig\",{id:0,config:t},b);u.nc++;S(\"Relais-Sicherung nachgestellt\")}}var pt=\"0 */5 * * * *\";var dt=\"0 23 3 * * *\";function bt(e){u.sn=e||0;Shelly.call(\"Schedule.List\",{},y,yt)}function yt(e,t,n){var r=e&&e.jobs||[],i,u,f,l,a=null,s=false;if(t){S(\"Zeitplan nicht lesbar: \"+n);return}for(i=0;i<r.length;i++){f=r[i]&&r[i].calls||[];for(u=0;u<f.length;u++){l=f[u]?String(f[u].method).toLowerCase():\"\";if(l===\"script.start\"&&f[u].params&&f[u].params.id===Script.id)a=r[i];if(l===\"shelly.update\")s=true}}if(!a){if(x(\"Schedule.Create\",{enable:true,timespec:pt,calls:[{method:\"Script.Start\",params:{id:Script.id}}]},kt)){S(\"W\\xC3\\xA4chter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht\")}}else if(a.enable!==true||a.timespec!==pt){x(\"Schedule.Update\",{id:a.id,enable:true,timespec:pt},kt)}else if(!s){if(x(\"Schedule.Create\",{enable:true,timespec:dt,calls:[{method:\"Shelly.Update\",params:{stage:\"stable\"}}]},kt)){S(\"Firmware-Update angelegt: t\\xC3\\xA4glich 03:23 die neueste stabile\")}}}function kt(e,t,n){if(t)S(\"Zeitplan nicht gesetzt: \"+n);else if(u.sn<2)bt(u.sn+1)}function wt(){var t,n;d(p());u.u=_()||0;u.oq=je(e.l);if(typeof e.p===\"number\"&&typeof e.M===\"number\"){u.la=e.p;u.lo=e.M}else if(i.la!==null){u.la=i.la;u.lo=i.lo}u.t0=i.t;u.s0=f();if(i.os){u.off=true;u.oa=i.os>1?i.os:0}t=Shelly.getComponentStatus(\"sys\");n=f();it();try{HTTPServer.registerEndpoint(\"info\",gt)}catch(e){S(\"Diagnose-Seite fehlt: \"+e)}if(n<60){try{u.ko=!!p().output;u.kts=u.ko?[n]:[];u.kh=Shelly.addStatusHandler(_e)}catch(e){S(\"Anlern-Geste fehlt: \"+e)}}if(i.wu>0&&n>=i.wu){u.sv=i.wu;u.wn=i.wn;u.w24=Math.min(i.wb,n)}if(t&&typeof t.unixtime===\"number\"&&t.unixtime>1767225600&&(!i.ce||n<i.tu||E())){if(i.ce||i.df){if(i.df===1)Qe(z(t.unixtime).day-z(i.t).day);i.ce=0;L()}}else if(i.t>1767225600){u.eb=i.t+(n>=i.tu?n-i.tu:n);u.eu=n;u.est=true;u.def=i.df===1;u.u=_()||0;if(i.ce!==1||n<i.tu||!(t&&t.unixtime>1767225600)){i.ce=1;i.cs=Math.floor(u.eb);S(\"Uhr aus Zeitanker gesch\\xC3\\xA4tzt\");L();Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},b)}}else u.H=n+120;St();bt();u.cfgAt=n+3600}function Mt(){F();try{wt()}catch(e){S(\"Fehler Start: \"+e)}try{B()}catch(e){S(\"Fehler Bedienfeld: \"+e)}Timer.set(1e3,true,vt);S(\"gestartet, Bodenkonto \"+a(i.d)+\" mm, Pumpe \"+(i.pn?\"angelernt \"+i.pn+\" W\":\"Voreinstellung\"))}Mt();";
window.__bw = { fertig: false, log: [] };
deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })
  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })
  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });
return "Aufspielen gestartet, 35853 Byte";
})();
