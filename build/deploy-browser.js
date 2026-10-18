(function () {
'use strict';
/*
 * Spielt das Bewässerungsskript auf den Shelly Outdoor Plug S Gen3 und prüft das Ergebnis.
 * Ein Ablauf, zwei Wege:
 *   Node (ab 18):   node tools/deploy.js <ip-des-shelly> [build/bewaesserung.min.js] [--passwort <pw>] [--ohne-waechtertest]
 *   Browser:        auf der Weboberfläche des Shelly (http(s)://<ip>/) in der Konsole den Inhalt von
 *                   build/deploy-browser.js einfügen (gleiche Herkunft, kein CORS; ohne Gerätepasswort)
 * Schritte: Gerät prüfen -> neueste stabile Firmware -> Matter aus -> Wächter anhalten -> Skript anlegen/ersetzen
 *           -> Autostart an -> starten, Bedienfeld anlegen lassen, Skript neu starten -> Selbsttest -> prüfen:
 *           Skript läuft fehlerfrei, Einschaltzustand aus, Notabschaltung 9600 s, kein Wiedereinschalten,
 *           Bedienfeld vollständig, Statuszeile da, Wetterdienst erreichbar, Speicherreserve >= 2 KB,
 *           Sicherheit (Passwort, Access Point, Bluetooth), Wächter startet ein angehaltenes Skript neu.
 * Hat der Shelly ein Passwort (Benutzer admin), meldet er sich per Digest mit SHA-256 an (Shelly-Doku,
 * General/Authentication); im Browserweg ist das nicht vorgesehen.
 */
async function deployShelly(base, code, log, opt) {
  log = log || function (t) { (typeof console !== 'undefined') && console.log(t); };
  opt = opt || {};
  const NAME = 'bewaesserung', WD = '0 */5 * * * *';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let auth = null;                                   // Anmeldung: { realm, nonce, nc, legacy, ha1 }
  async function sha256(t) {
    if (!(typeof crypto !== 'undefined' && crypto.subtle)) throw new Error('Passwort nur über https oder Node');
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
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
    step('Sicherheit: Gerätepasswort ' + (info.auth_en ? 'an' : 'AUS – Empfehlung: in der App setzen') + ', Access Point ' +
      (ap.enable ? 'an (mit Passwort)' : 'aus') + ', Steuerung über Bluetooth ' + (out.sicherheit.bluetoothSteuerung ? 'an (ab Firmware 2.0 nur gekoppelt)' : 'aus'));
  } catch (e) { step('Sicherheit nicht lesbar: ' + e.message); }

  // 8. Wächter: Zeitplan aktiv? Danach das Skript anhalten; der Zeitplan muss es binnen 5 min neu starten
  const wd = ((await rpc('Schedule.List')).jobs || []).filter((j) => isWd(j, s.id));
  out.waechterPlan = wd.length === 1 && wd[0].enable === true && wd[0].timespec === WD;
  step('Wächter-Zeitplan: ' + (out.waechterPlan ? 'alle 5 min, aktiv' : 'FEHLT oder falsch: ' + JSON.stringify(wd)));
  out.waechter = !!opt.ohneWaechter;
  if (!opt.ohneWaechter && out.waechterPlan && out.uhr) {
    await rpc('Script.Stop', { id: s.id });
    step('Wächtertest: Skript angehalten, warte bis zu 5,5 min');
    const t0 = Date.now();
    for (let i = 0; i < 66 && !out.waechter; i++) { await sleep(5000); out.waechter = (await rpc('Script.GetStatus', { id: s.id })).running; }
    step(out.waechter ? 'Wächter: Skript nach ' + Math.round((Date.now() - t0) / 1000) + ' s wieder gestartet' : 'FEHLER: Wächter startet das Skript nicht');
    if (!out.waechter) await rpc('Script.Start', { id: s.id });
  } else if (!opt.ohneWaechter) step('Wächtertest übersprungen (Zeitplan oder Uhr fehlt)');

  out.ok = st.running && !st.errors && cfg.initial_state === 'off' && cfg.auto_off === true &&
    cfg.auto_off_delay === 9600 && cfg.auto_on !== true && fehlt.length === 0 && !!out.status && /^ok/.test(out.wetter) && reserve >= 2048 &&
    /^ok/.test(selbst) && out.waechterPlan && out.waechter && out.firmwareNeu;
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
  if (pw >= 0) { opt.pass = args[pw + 1]; args.splice(pw, 2); }
  const ow = args.indexOf('--ohne-waechtertest');
  if (ow >= 0) { opt.ohneWaechter = true; args.splice(ow, 1); }
  if (!args[0]) { console.log('Aufruf: node tools/deploy.js <ip> [gerätefassung.js] [--passwort <pw>] [--ohne-waechtertest]'); process.exit(2); }
  const file = args[1] || path.join(__dirname, '..', 'build', 'bewaesserung.min.js');
  shellyBasis(args[0])
    .then((base) => deployShelly(base, fs.readFileSync(file, 'utf8'), null, opt))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error('ABBRUCH: ' + e.message); process.exit(1); });
}
if (typeof module !== 'undefined') module.exports = { deployShelly, shellyBasis };

var CODE = "var e={l:\"Ludwigshafen am Rhein\",p:\"DE\",S:null,_:null,M:1,A:600,T:750,R:3,N:11,O:8.6,P:.85,F:8,I:5,U:15,H:25,W:6,C:60,D:1,B:3,G:4,V:5,J:1.1,K:900,X:1900,Z:600,Y:2100,j:10.5,$:150,ee:9600,te:10,ne:.75,ie:1.3,ue:.3,fe:50,le:40,ae:8,oe:5,se:5,he:2,me:120,pe:60,Se:6,ye:2,ve:15,be:10,ge:.06,_e:5400,Me:3600,de:21600,Ae:3600,Te:1767225600};var t=[.6,.9,1.6,2.6,3.5,4.5,4.4,3.8,2.4,1.1,.5,.5];var n=[6.1,9.3,13,17,21.1,26.3,27.4,27.4,22.8,16.7,9.6,6.8];var r={ok:[0,100,0],warn:[100,70,0],err:[100,0,100],run:[0,0,100]};var i=null;var u={k:0,eb:0,eu:0,est:false,run:null,ps:null,want:null,starts:[],Re:0,wc:0,weld:false,wx:{busy:false,next:0,Ne:0,L:null,n:0,rc:false,t:0,q:0},off:false,why:\"\",note:\"\",Ee:0,ke:null,we:false,h:null,Oe:-1,Pe:\"\",ze:-1,boot:true,def:false,Le:0,Fe:0,cfgAt:0,led:\"\",Ie:\"\",Ue:0,ledN:[],td:null,ty:null,ts:-1e9,z:null,zf:-1e9,zl:0,zn:0,cp:0,co:0,rh:0,nf:false,la:null,lo:null,gn:0,st:\"\"};function f(){return Shelly.getUptimeMs()/1e3}function l(e){return Math.round(e)}function a(e){return Math.round(e*10)/10}function o(e){return Math.round(e*100)/100}function s(e){return String(a(e)).replace(\".\",\",\")}function c(e,t,n){return e<t?t:e>n?n:e}function h(e){return(e<10?\"0\":\"\")+e}function m(e){print(\"[BW] \"+e)}function p(){return Shelly.getComponentStatus(\"switch\",0)||{}}function S(e,t,n){if(t)m(\"RPC-Fehler \"+t+\" \"+n)}function y(e,t,n){e-=t<=2?1:0;var r=Math.floor(e/400),i=e-r*400;var u=Math.floor((153*(t+(t>2?-3:9))+2)/5)+n-1;var f=i*365+Math.floor(i/4)-Math.floor(i/100)+u;return r*146097+f-719468}function v(e){e+=719468;var t=Math.floor(e/146097),n=e-t*146097;var r=Math.floor((n-Math.floor(n/1460)+Math.floor(n/36524)-Math.floor(n/146096))/365);var i=n-(365*r+Math.floor(r/4)-Math.floor(r/100));var u=Math.floor((5*i+2)/153);var f=u<10?u+3:u-9;return{y:r+t*400+(f<=2?1:0),m:f,d:i-Math.floor((153*u+2)/5)+1}}function b(e,t){var n=y(t===12?e+1:e,t===12?1:t+1,1)-1;return n-(n+4)%7}function g(t){var n=v(Math.floor(t/86400)).y;var r=b(n,3)*86400+3600,i=b(n,10)*86400+3600;return(e.M+(t>=r&&t<i?1:0))*3600}function _(e){var t=e+g(e),n=Math.floor(t/86400),r=v(n);return{day:n,min:Math.floor((t-n*86400)/60),y:r.y,m:r.m,d:r.d}}function M(e){return e.y+\"-\"+h(e.m)+\"-\"+h(e.d)}function d(e){return h(Math.floor(e/60))+\":\"+h(e%60)}function A(e){var t=v(e);return h(t.d)+\".\"+h(t.m)+\".\"}function T(t){var n=v(t),r=2*Math.PI/365*(t-y(n.y,1,1));var i=229.18*(75e-6+.001868*Math.cos(r)-.032077*Math.sin(r)-.014615*Math.cos(2*r)-.040849*Math.sin(2*r));var f=.006918-.399912*Math.cos(r)+.070257*Math.sin(r)-.006758*Math.cos(2*r)+907e-6*Math.sin(2*r);var l=(u.la===null?50:u.la)*Math.PI/180;var a=Math.acos(Math.cos(1.58534)/(Math.cos(l)*Math.cos(f))-Math.tan(l)*Math.tan(f));return 720-4*((u.lo===null?15*e.M:u.lo)+a*180/Math.PI)-i}function R(){var t=Shelly.getComponentStatus(\"sys\");if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Te)return t.unixtime;if(u.eb)return u.eb+f()-u.eu;return null}function N(){var e=Shelly.getComponentStatus(\"sys\");return!!e&&typeof e.last_sync_ts===\"number\"&&Math.abs(e.last_sync_ts-i.cs)>5}function E(){var t=null;try{t=JSON.parse(Script.storage.getItem(\"s\"))}catch(e){t=null}if(!t||t.v!==1)t={v:1};if(typeof t.t!==\"number\")t.t=0;if(typeof t.d!==\"number\"||!(t.d>=0&&t.d<=e.H))t.d=0;if(typeof t.dp!==\"number\")t.dp=-1;if(typeof t.pi!==\"number\"||!(t.pi>=0))t.pi=0;if(typeof t.ev!==\"number\")t.ev=-1;if(typeof t.pn!==\"number\")t.pn=0;if(typeof t.ln!==\"number\")t.ln=0;if(typeof t.pu!==\"number\")t.pu=0;if(typeof t.fd!==\"number\")t.fd=-1;if(typeof t.fc!==\"number\")t.fc=0;if(typeof t.rt!==\"number\")t.rt=0;if(typeof t.rm!==\"number\")t.rm=0;if(typeof t.lr!==\"string\")t.lr=\"\";if(typeof t.xa!==\"number\")t.xa=-1;if(!t.xe||typeof t.xe.length!==\"number\")t.xe=[];if(!t.xw||typeof t.xw.length!==\"number\"||t.xw.length!==t.xe.length){t.xw=[];t.xe=[];t.xa=-1}if(typeof t.xd!==\"number\")t.xd=0;if(typeof t.ob!==\"number\")t.ob=-99;if(typeof t.oa!==\"number\")t.oa=-99;if(typeof t.df!==\"number\")t.df=0;if(typeof t.rd!==\"number\")t.rd=-1;if(typeof t.rx!==\"number\")t.rx=0;if(typeof t.rc!==\"number\")t.rc=-1;if(typeof t.rk!==\"number\")t.rk=0;if(typeof t.rf!==\"number\")t.rf=0;if(typeof t.tu!==\"number\")t.tu=0;if(typeof t.ce!==\"number\")t.ce=0;if(typeof t.cs!==\"number\")t.cs=0;if(t.pz!==e.p+e.l||typeof t.la!==\"number\"||typeof t.lo!==\"number\"){t.la=null;t.lo=null;t.pz=\"\"}i=t}function k(){var e=R();if(e){i.t=Math.floor(e);i.tu=Math.floor(f())}i.d=o(i.d);i.pi=o(i.pi);try{Script.storage.setItem(\"s\",JSON.stringify(i));u.we=false}catch(e){u.we=true}}var w=[[\"text\",200,\"st\",{name:\"Status\",default_value:\"\",persisted:false,max_len:255,meta:{ui:{view:\"label\"}}}],[\"number\",200,\"bk\",{name:\"Wasserdefizit\",default_value:0,persisted:false,min:0,max:25,meta:{ui:{view:\"progressbar\",unit:\"mm\",step:.1}}}],[\"boolean\",200,\"au\",{name:\"Automatik\",default_value:true,persisted:true,meta:{ui:{view:\"toggle\",titles:[\"Aus\",\"An\"]}}}],[\"number\",201,\"pa\",{name:\"Pause\",default_value:0,persisted:false,min:0,max:14,meta:{ui:{view:\"field\",unit:\"Tage\",step:1}}}],[\"number\",202,\"ra\",{name:\"Regenrate\",default_value:e.O,persisted:true,min:1,max:40,meta:{ui:{view:\"field\",unit:\"mm/h\",step:.1}}}],[\"button\",200,\"re\",{name:\"Pumpe neu einlernen\",meta:{ui:{view:\"button\"}}}]];var O=0;function P(){if(O<w.length){var e=w[O];if(Shelly.getComponentConfig(e[0],e[1])){O++;P();return}Shelly.call(\"Virtual.Add\",{type:e[0],id:e[1],config:e[3]},z);return}if(!Shelly.getComponentConfig(\"group\",200)){Shelly.call(\"Virtual.Add\",{type:\"group\",id:200,config:{name:\"Bew\\xC3\\xA4sserung\",meta:{ui:{view:\"group\"}}}},L);return}L(null,0,\"\")}function z(e,t,n){if(t)m(\"Bedienfeld \"+w[O][2]+\": \"+n);O++;P()}function L(e,t,n){var r=[],i,u=Shelly.getComponentStatus(\"group\",200);for(i=0;i<w.length;i++)r.push(w[i][0]+\":\"+w[i][1]);if(!u||JSON.stringify(u.value)!==JSON.stringify(r)){Shelly.call(\"Group.Set\",{id:200,value:r},S)}F()}function F(){var e={},t,n=true;for(t=0;t<w.length;t++){e[w[t][2]]=Virtual.getHandle(w[t][0]+\":\"+w[t][1]);if(!e[w[t][2]])n=false}if(!n){m(\"Bedienfeld unvollst\\xC3\\xA4ndig \\xE2\\x80\\x93 ohne Anzeige weiter\");return}e.re.on(\"single_push\",I);u.h=e}function I(e){i.pn=0;i.ln=0;k();ue(\"Pumpe wird beim n\\xC3\\xA4chsten Lauf neu eingelernt\")}function U(){var t=u.h?u.h.ra.getValue():null;return typeof t===\"number\"&&t>=1&&t<=40?t:e.O}function H(){return!u.h||u.h.au.getValue()!==false}function W(e){return i.pu&&e.day<=i.pu}function x(e){return t[e-1]}function C(t){var n=e.R,r=e.N;return n<=r?t.m>=n&&t.m<=r:t.m>=n||t.m<=r}function D(e){return i.dp<0?0:c(e.day-1-i.dp,0,14)}function B(t){return c(c(i.d-i.pi,0,e.H)+D(t)*x(t.m)*e.P,0,e.H)}function G(t){return Math.min(e.$*60,l(t/U()*3600))}function V(t){var n=t?i.oa:i.ob;return n>-50?n:t?e.be:e.ve}function J(t){var r=v(t).m,i=u.ty,f=1;if(i&&i.d===t&&i.n>=100)f=c(1+e.ge*(i.mx-V(1)-n[r-1]),.5,1.6);return x(r)*f*e.J}function K(){i.xd=c(i.xd-i.xw[0],0,e.H)+i.xe[0];i.xe.shift();i.xw.shift();i.xa++}function X(t){var n,r,u=i.pi;if(i.xa<0&&i.dp+1<t.day){i.xd=i.d;i.xe=[];i.xw=[]}i.d=c(i.d-i.pi,0,e.H);i.pi=0;for(n=i.dp+1;n<t.day;n++){r=i.d;i.d=c(i.d+a(J(n)*e.P),0,e.H);if(i.xa<0)i.xa=n;i.xe.push(a(i.d-r));i.xw.push(a(u));u=0;if(i.xe.length>14)K()}i.dp=t.day-1}function Z(e,t){var n,r,i,f;if(t-u.ts<600)return;u.ts=t;n=p();r=n.temperature;if(n.output||u.run||t-u.Re<1800||!r||typeof r.tC!==\"number\")return;i=r.tC;f=u.td;if(!f||f.d!==e.day){u.ty=f&&f.d===e.day-1?f:null;f=u.td={d:e.day,n:0,mn:i,mx:i}}f.n++;if(u.est)f.x=1;if(i<f.mn)f.mn=i;if(i>f.mx)f.mx=i;if(u.est)Q(i,t);else u.z=null}function Y(e,t,n){var r=u.ty;var f,l;if(!r||r.x||r.d!==e.day-1||r.n<100||t===null||n===null)return;f=r.mn-t;l=r.mx-n;if(f>-5&&f<50)i.ob=i.ob>-50?a(i.ob+(f-i.ob)*.3):a(f);if(l>-5&&l<50)i.oa=i.oa>-50?a(i.oa+(l-i.oa)*.3):a(l)}function q(){var e=u.td,t=p().temperature,n=null;if(e&&e.n)n=e.mn;else if(t&&typeof t.tC===\"number\")n=t.tC;if(n===null)return null;return n-V(0)-(e&&e.n>=36?0:5)}function j(){var e=p(),t=e.temperature;if(i.oa<-50||e.output||u.run||f()-u.Re<1800||!t||typeof t.tC!==\"number\")return null;return t.tC-Math.max(V(0),V(1))}function Q(e,t){var n=u.z;if(!n){u.z={s:-1,v:e,t:t,mv:e,mt:t,e:null};return}if(n.e&&t-n.e.t>10800)n.e=null;if(n.e&&e>=n.e.v+5){$(n.e.t);n.e=null}if(n.s<0){if(e<n.v){n.v=e;n.t=t}else if(e>n.v+3){if(n.mv-n.v>=6&&n.t-n.mt>=21600)n.e={t:n.t,v:n.v};n.s=1;n.v=e;n.t=t}}else if(e>n.v){n.v=e;n.t=t}else if(e<n.v-3){n.mv=n.v;n.mt=n.t;n.s=-1;n.v=e;n.t=t}}function $(t){var n=u.eb+t-u.eu,r=Math.floor(n/86400),l,a,o=null;if(!u.est||f()-u.zf<72e3)return;for(l=-1;l<=1;l++){a=(r+l)*86400+T(r+l)*60+600-n;if(u.def?a>-43200&&a<=43200:a>=-10800&&a<75600)o=a}if(o===null)return;a=o-e.Me;if((u.zn?Math.abs(a):u.def?Math.abs(o):o)<e._e)return;u.zf=f();u.zl=a;u.co=i.cs;u.cp=f();i.cs=Math.floor(u.eb+a+f()-u.eu);Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},ee)}function ee(e,t,n){u.cp=0;if(t){i.cs=u.co;m(\"Uhr nicht stellbar: \"+n);return}u.eb+=u.zl;u.zn=1;k();m(\"Uhr nach Tagesgang um \"+s(u.zl/3600)+\" h gestellt\")}function te(e){var t=[],n;for(n=0;n<u.starts.length;n++)if(e-u.starts[n]<3600)t.push(u.starts[n]);u.starts=t;return t.length}function ne(e){if(u.run&&!u.run.why)u.run.why=e;Shelly.call(\"Switch.Set\",{id:0,on:false},S)}function re(e,t,n){var r=u.ps;if(!t)return;u.ps=null;u.why=\"Einschalten abgelehnt: \"+n;m(u.why);if(r&&r.k!==\"hand\")u.want={k:r.k,mm:r.mm,exp:(R()||0)+1800}}function ie(t,n){var r=f(),i=p();if(u.ps&&r>u.ps.He)u.ps=null;if(u.run||i.output||u.ps)return\"l\\xC3\\xA4uft\";if(u.weld)return\"Relais\";if(u.Re&&r-u.Re<e.me)return\"Pause\";if(te(r)>=e.te)return\"Starts\";var o=G(n);if(o<60)return\"kurz\";u.ps={k:t,mm:n,sec:o,He:r+15};Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:o},re);m(\"Start \"+t+\" \"+a(n)+\" mm, \"+l(o/60)+\" min\");return null}function ue(e){u.note=e;u.Ee=f();m(e)}function fe(t,n){var r=f(),o=u.ps,s=R(),h,p,y,v=0;u.ps=null;if(o&&(n||r<=o.He)){h=o.k;p=o.mm;y=o.sec}else{h=\"hand\";if(te(r)>=e.te){ue(\"Zu viele Starts in einer Stunde \\xE2\\x80\\x93 Pumpe gesch\\xC3\\xBCtzt\");u.starts.push(r);ne(\"starts\");return}if(u.boot&&t.timer_duration){v=s&&t.timer_started_at?t.timer_started_at+t.timer_duration-s:t.timer_duration;y=l(c(v,1,t.timer_duration));p=y*U()/3600}else{p=c(s?B(_(s)):e.W,e.W,e.U);y=G(p);Shelly.call(\"Switch.Set\",{id:0,on:true,toggle_after:y},S)}u.want=null;if(i.rt){i.rt=0;k()}}u.starts.push(r);u.run={k:h,t0:r,lt:r,u0:s||0,sec:y,mm:p,ps:0,cr:0,ck:r,sp:0,np:0,pf:-1,u:0,o:0,n:0,i:0,why:\"\",det:\"\"};m(\"Pumpe an (\"+h+\"), Ziel \"+a(p)+\" mm in \"+l(y/60)+\" min\")}function le(e){var t=e.ps*U()/3600,n=t-e.cr;if(n>0){i.pi=i.pi+n;e.cr=t}}function ae(e,t){u.run.why=e;u.run.det=t;m(\"Schutz: \"+e+\" (\"+t+\")\");ne(e)}function oe(t){var n=u.run,r=f(),a=r-n.t0,o=c(r-n.lt,0,5);var h=t.apower||0,m=t.current||0;var p=i.pn?i.pn*e.ne:e.Z;var S=i.pn?i.pn*e.ie:e.Y;n.lt=r;if(n.why)return;if(a>n.sec+60){ne(\"ende\");return}n.pf=n.pf<0?h:n.pf+(h-n.pf)*.3;n.i=a>=2&&m>e.j?n.i+1:0;if(n.i>=e.he){ae(\"blockiert\",s(m)+\" A\");return}n.n=a>=3&&h<e.fe?n.n+1:0;if(n.n>=e.se){ae(\"keinStrom\",l(h)+\" W\");return}n.o=a>=e.le&&n.pf>S?n.o+1:0;if(n.o>=e.oe){ae(\"ueberlast\",l(n.pf)+\" W > \"+l(S)+\" W\");return}n.u=a>=e.le&&h>=e.fe&&n.pf<p?n.u+1:0;if(n.u>=e.ae){ae(\"unterlast\",l(n.pf)+\" W < \"+l(p)+\" W\");return}if(n.pf>=p)n.ps+=o;if(a>=60&&a<300){n.sp+=h;n.np++}if(r-n.ck>=e.Ae){le(n);k();n.ck=r}}function se(t){if(!i.pn){if(t>=e.K&&t<=e.X){i.pn=l(t);i.ln=1;ue(\"Normalleistung eingelernt: \"+i.pn+\" W\")}else{ue(\"Leistung \"+l(t)+\" W unplausibel \\xE2\\x80\\x93 nicht eingelernt (Hahn zu?)\")}}else if(Math.abs(t/i.pn-1)<=e.ue){i.pn=l(i.pn*.8+t*.2);i.ln++}}var ce={unterlast:\"Trockenlauf oder Hahn zu\",ueberlast:\"\\xC3\\x9Cberlast\",blockiert:\"Pumpe blockiert\",keinStrom:\"Pumpe zieht keinen Strom\",start:\"Pumpe lief nicht an\"};function he(t){var n=u.run,r=f(),l=R(),o=n.why,c=t.errors&&t.errors.length;u.run=null;u.Re=r;le(n);if((!o||o===\"start\")&&c)o=\"fw\";var h=o===\"fw\"||!!ce[o];if(!h&&n.np>=30)se(n.sp/n.np);var p=h?o===\"fw\"?\"Firmware-Schutz: \"+t.errors.join(\",\"):ce[o]+(n.det?\" (\"+n.det+\")\":\"\"):\"\";if(l){var S=_(l),y=_(n.u0||l);i.lr=A(y.day)+\" \"+d(y.min)+\" \"+(n.k===\"hand\"?\"Hand\":n.k===\"retry\"?\"Nachlauf\":\"Automatik\")+\" \"+s(n.cr)+\" mm\"+(h?\" \\xE2\\x80\\x93 abgebrochen\":\"\");if(h){if(i.fd!==S.day){i.fd=S.day;i.fc=0}i.fc++;var v=n.mm-n.cr,b=o===\"unterlast\"?e.ye:1;i.rt=0;if((n.k===\"auto\"||n.k===\"retry\")&&v>=2&&i.fc<=b){i.rt=Math.floor(l)+(r-n.t0<10?e.Se:e.pe)*60;i.rm=a(v)}u.ke={txt:p,u:l}}}m(\"Pumpe aus: \"+(o||\"Ende/Stopp\")+\", \"+a(n.cr)+\" mm gegeben\");k()}function me(t){var n=f(),r=t.apower||0;if(u.Re&&n-u.Re<5)return;if(r>e.fe){u.wc++;if(u.wc>=5){if(!u.weld)m(\"Relais klebt? \"+l(r)+\" W bei AUS\");u.weld=true;if(u.wc%30===5)Shelly.call(\"Switch.Set\",{id:0,on:false},S)}}else{u.wc=0;u.weld=false}}function pe(e){return\"https://api.open-meteo.com/v1/forecast?latitude=\"+u.la+\"&longitude=\"+u.lo+\"&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min,\"+\"temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=\"+e}function Se(e,t,n){u.wx.busy=true;u.wx.L=e;u.wx.n=t;u.wx.rc=n;u.wx.t=f();u.wx.q++;Shelly.call(\"HTTP.GET\",{url:pe(t),timeout:20},ge,u.wx.q)}function ye(e){if(!C(e)){i.ev=e.day;i.d=0;i.pi=0;i.dp=e.day-1;i.rt=0;i.xa=-1;i.xe=[];i.xw=[];u.why=\"Winterpause\";k();return}if(i.dp<0||e.day-1-i.dp>14){i.d=0;i.pi=0;i.dp=e.day-1-(i.dp<0?0:14)}while(i.xe.length&&e.day-i.xa>14)K();if(!i.xe.length)i.xa=-1;if(u.la===null){u.off=true;X(e);_e(e,null,false);return}Se(e,e.day-(i.xa>=0?i.xa:i.dp+1),false)}function ve(e,t){return e&&typeof e[t]===\"number\"?e[t]:null}function be(e,t,n){return{rain:ve(e.precipitation_sum,t)||0,prob:ve(e.precipitation_probability_max,t)||0,tmin:ve(e.temperature_2m_min,t),tnow:n&&typeof n.temperature_2m===\"number\"?n.temperature_2m:null}}function ge(t,n,r,l){var a=u.wx.L,o=u.wx.n,s=false,h=null,m=null,p,S,y,b,g,d;if(l!==u.wx.q||!u.wx.busy)return;u.wx.busy=false;try{if(!n&&t&&t.code===200){h=JSON.parse(t.body);m=h.daily;s=m&&m.time&&m.time.length===o+1&&m.time[o]===M(a)}}catch(e){s=false}if(u.wx.rc){u.wx.rc=false;if(s)_e(a,be(m,o,h.current),true);else if(i.rc===a.day&&(i.rk===1||i.rk===3))_e(a,null,true);return}if(!s){u.wx.Ne++;d=R();if(u.wx.Ne<(u.est||u.off?1:4)&&d&&_(d).min+21<e.T){u.wx.next=f()+1200;return}u.off=true;X(a);_e(a,null,false);return}for(p=0;p<o;p++){S=a.day-o+p;y=ve(m.et0_fao_evapotranspiration,p);b=ve(m.precipitation_sum,p);if(y===null)y=x(v(S).m);if(b===null)b=0;g=y*e.P-Math.max(0,b-e.D);if(S>i.dp){i.d=c(c(i.d-i.pi,0,e.H)+g,0,e.H);i.pi=0}else if(i.xa>=0&&S>=i.xa){if(S===i.xa)i.d=i.xd;i.d=c(c(i.d-(i.xw[S-i.xa]||0),0,e.H)+g,0,e.H)}}i.xa=-1;i.xe=[];i.xw=[];i.d=c(i.d-i.pi,0,e.H);i.pi=0;i.dp=a.day-1;u.nf=false;if(o>=1){b=ve(m.precipitation_sum,o-1);u.nf=i.rd===a.day-1&&b!==null&&b-e.D<i.rx/2;Y(a,ve(m.temperature_2m_min,o-1),ve(m.temperature_2m_max,o-1))}u.off=false;_e(a,be(m,o,h.current),false)}function _e(t,n,r){var f=B(t),l=0,o=0,c=R(),h=c?_(c).min:t.min,p,S=null,y=false,v,b=r&&i.rc===t.day?i.rk:0;u.wx.Ne=0;if(u.run){k();return}i.ev=t.day;i.rc=-1;i.rk=0;if(b===1||b===3){S=i.rf;y=b===3}else if(n&&n.tmin!==null)S=n.tmin<e.B?n.tmin:null;else if((S=q())!==null){if(S>=e.G)S=null;else y=true}v=n&&n.tnow!==null?n.tnow:j();if(!H())u.why=\"Automatik aus\";else if(W(t))u.why=\"Pause bis \"+A(i.pu);else if(f<e.F)u.why=\"nicht n\\xC3\\xB6tig (\"+s(f)+\" mm)\";else if(S!==null&&!(v>=e.V)){u.why=\"Frostsperre (\"+(y?\"gesch\\xC3\\xA4tzt \":\"\")+s(S)+\" \\xC2\\xB0C), gie\\xC3\\x9Ft ab \"+e.V+\" \\xC2\\xB0C\";i.rc=t.day;i.rk=y?3:1;i.rf=a(S);u.rh=(Math.floor(h/60)+1)*60+5}else{if(n&&n.prob>=e.C&&!u.nf)l=Math.max(0,n.rain-e.D);o=Math.min(e.U,f-l);if(l>0&&o<Math.min(e.U,f)){i.rd=t.day;i.rx=a(l)}else if(i.rd===t.day)i.rd=-1;if(o<e.I&&l>0){u.why=\"Regen erwartet (\"+s(n.rain)+\" mm, \"+n.prob+\" %)\"+(b===2?\", \"+d(h)+\" best\\xC3\\xA4tigt\":\"\");i.rc=t.day;i.rk=2;u.rh=(Math.floor(h/60)+1)*60+5}else if(o<e.I)u.why=\"nicht n\\xC3\\xB6tig (\"+s(f)+\" mm)\";else if(h>=e.T){u.why=d(e.T)+\" vorbei, nicht mehr gestartet\";o=0}else u.why=(b===2?\"Regen abgesagt, \":b?\"Frost vorbei, \":\"\")+\"gegossen \"+s(G(o)*U()/3600)+\" mm\"+(u.nf?\" (gestern Regen ausgeblieben)\":\"\")}m(\"Tagespr\\xC3\\xBCfung: Defizit \"+a(f)+\" mm\"+(n?\"\":\" (ohne Internet)\")+\" -> \"+u.why);if(o>=e.I){p=ie(\"auto\",o);if(p)u.want={k:\"auto\",mm:o,exp:R()+7200}}k()}function selfTest(){if(u.la===null)return\"FEHLER Ort unbekannt: \"+e.l;if(!u.st){u.st=\"l\\xC3\\xA4uft\";Shelly.call(\"HTTP.GET\",{url:pe(14),timeout:20},Me)}return u.st===\"ok\"?\"ok, Ort \"+u.la+\" \"+u.lo:u.st}function Me(e,t,n){var r=false;try{r=!t&&e.code===200&&JSON.parse(e.body).daily.time.length===15}catch(e){r=false}u.st=r?\"ok\":\"FEHLER \"+(n||\"Antwort\");m(\"Selbsttest Wetter: \"+u.st)}function de(){var t=Shelly.getComponentStatus(\"sys\"),n=y(2026,4,15)*86400+e.A*60-(e.M+1)*3600;u.Le=0;if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Te)return;u.def=true;u.est=true;u.eb=n;u.eu=f();i.df=1;i.ce=1;i.cs=n;Shelly.call(\"Sys.SetTime\",{unixtime:n},S);m(\"Uhrzeit unbekannt \\xE2\\x80\\x93 Einstecken gilt als 15. April \"+d(e.A));k()}function Ae(){u.gn=f()+900;Shelly.call(\"HTTP.GET\",{url:\"https://geocoding-api.open-meteo.com/v1/search?count=1&name=\"+Te(e.l)+\"&countryCode=\"+e.p,timeout:20},Re)}function Te(e){var t=\"\",n,r,i,u=[];for(n=0;n<e.length;n++){r=e.charCodeAt(n);i=e.charCodeAt(n+1);if(r>47&&r<58||r>64&&r<91||r>96&&r<123){t+=e.charAt(n);continue}if(r<128)u=[r];else if(r>193&&r<224&&i>127&&i<192){u=[r,i];n++}else u=[192|r>>6,128|r&63];for(r=0;r<u.length;r++)t+=\"%\"+(\"0\"+u[r].toString(16)).slice(-2).toUpperCase()}return t}function Re(t,n,r){var f=null;try{if(!n&&t&&t.code===200)f=JSON.parse(t.body).results[0]}catch(e){f=null}if(!f||typeof f.latitude!==\"number\"||typeof f.longitude!==\"number\")return;u.la=i.la=o(f.latitude);u.lo=i.lo=o(f.longitude);i.pz=e.p+e.l;u.off=false;m(\"Ort \"+e.l+\": \"+u.la+\", \"+u.lo);k()}function Ne(e){if(i.ev>=0)i.ev+=e;if(i.dp>=0)i.dp+=e;if(i.fd>=0)i.fd+=e;if(i.pu)i.pu+=e;if(i.xa>=0)i.xa+=e;if(i.rd>=0)i.rd+=e;if(i.rc>=0)i.rc+=e;i.rt=0;i.df=0;u.ke=null;u.td=null;u.ty=null;u.z=null;m(\"Echte Uhrzeit da: Tagesmarken um \"+e+\" Tage verschoben\")}function Ee(){if(u.Le&&f()>=u.Le)de();if(f()>=u.cfgAt){u.cfgAt=f()+3600;Ue();We()}var t=R();if(!t)return;var n=_(t),r=f();if(u.wx.busy&&r-u.wx.t>60)ge(null,-1,\"keine Antwort\",u.wx.q);if(u.est&&!(u.cp&&r-u.cp<60)&&(Math.abs(t-(u.eb+r-u.eu))>5||N())){if(u.def)Ne(n.day-_(u.eb+r-u.eu).day);u.est=false;u.def=false;i.ce=0;u.td=null;u.ty=null;k()}if(i.ev>n.day||i.dp>n.day-1||i.pu>n.day+14){if(i.ev>n.day)i.ev=-1;if(i.dp>n.day-1)i.dp=n.day-1;if(i.pu>n.day+14)i.pu=0;i.rt=0;k()}if(t-i.t>=e.de)k();Z(n,r);if(u.la===null&&r>=u.gn)Ae();if((u.est||u.off)&&u.la!==null&&!u.wx.busy&&r>=u.Fe){u.Fe=r+900;Shelly.call(\"HTTP.GET\",{url:\"https://api.open-meteo.com/v1/forecast?latitude=\"+u.la+\"&longitude=\"+u.lo+\"&daily=temperature_2m_min&timezone=auto&forecast_days=1\",timeout:10},ke)}if(i.pu&&n.day>i.pu){i.pu=0;k()}if(u.run&&u.run.k!==\"hand\"&&(!H()||W(n)))ne(\"aus\");if(i.ev!==n.day&&n.min>=e.A&&n.min<e.T&&!u.wx.busy&&r>=u.wx.next&&!u.run&&!u.ps){ye(n)}if(i.rc===n.day&&n.min>=u.rh&&n.min<e.T&&!u.wx.busy&&!u.run&&!u.ps){u.rh=(Math.floor(n.min/60)+1)*60+5;if(u.off)_e(n,null,true);else Se(n,0,true)}if(u.want){if(t>u.want.exp||!H()||n.min>=e.T)u.want=null;else if(!ie(u.want.k,u.want.mm))u.want=null}if(i.rt&&t>=i.rt&&!u.run){if(n.min>=e.T||!H()||W(n)||i.fd!==n.day){i.rt=0;k()}else if(!ie(\"retry\",i.rm)){i.rt=0;k()}}}function ke(e,t,n){if(!t&&e&&e.code===200)u.off=false}function we(t){var n=u.run,r;if(u.weld)return\"ALARM: Pumpe zieht Strom trotz AUS \\xE2\\x80\\x93 Relais klebt? Stecker ziehen!\";if(n){r=n.sec-(f()-n.t0);return\"Beregnung (\"+(n.k===\"hand\"?\"Hand\":n.k===\"retry\"?\"Nachlauf\":\"Automatik\")+\"): \"+s(n.mm)+\" mm, noch \"+Math.max(0,l(r/60))+\" min, \"+l(p().apower||0)+\" W\"}if(!t)return\"Uhrzeit unbekannt \\xE2\\x80\\x93 Automatik wartet auf Internet. Taster geht.\";if(u.ke&&t.day===_(u.ke.u).day){r=\"St\\xC3\\xB6rung \"+d(_(u.ke.u).min)+\": \"+u.ke.txt;r+=i.rt?\". Nachlauf \"+d(_(i.rt).min):\". N\\xC3\\xA4chster Versuch morgen \"+d(e.A)}else if(!C(t))r=\"Winterpause bis 01.\"+h(e.R)+\". \\xE2\\x80\\x93 Taster geht\";else if(!H())r=\"Automatik aus \\xE2\\x80\\x93 Taster geht\";else if(W(t))r=\"Pause bis \"+A(i.pu);else if(i.ev===t.day)r=\"Heute: \"+(u.why||\"gepr\\xC3\\xBCft\");else if(t.min<e.A)r=\"Bereit, Pr\\xC3\\xBCfung \"+d(e.A);else r=t.min<e.T?\"Pr\\xC3\\xBCfung l\\xC3\\xA4uft\":\"Heute nicht gepr\\xC3\\xBCft, n\\xC3\\xA4chste Pr\\xC3\\xBCfung morgen \"+d(e.A);if(i.lr)r+=\" \\xC2\\xB7 Zuletzt \"+i.lr;if(u.note&&f()-u.Ee>43200)u.note=\"\";if(u.note)r+=\" \\xC2\\xB7 \"+u.note;else if(i.pn)r+=\" \\xC2\\xB7 Pumpe normal \"+i.pn+\" W\";if(u.def)r+=\" \\xC2\\xB7 Uhr angenommen: Einstecken = \"+d(e.A);else if(u.est)r+=\" \\xC2\\xB7 Uhr gesch\\xC3\\xA4tzt\";if(u.la===null)r+=\" \\xC2\\xB7 Ort unbekannt\";else if(u.off)r+=\" \\xC2\\xB7 ohne Internet\";if(u.we)r+=\" \\xC2\\xB7 Speicher fehlt (Firmware alt)\";return r}function Oe(){if(!u.h)return;var e=R(),t=e?_(e):null,n,r,f;f=u.h.pa.getValue();if(t&&typeof f===\"number\"&&u.Oe>=0&&f!==u.Oe){i.pu=f>0?t.day+l(f)-1:0;i.rt=0;u.want=null;k();m(\"Pause \"+(f>0?\"bis \"+A(i.pu):\"aufgehoben\"))}r=t&&W(t)?i.pu-t.day+1:0;if(r!==u.Oe){u.h.pa.setValue(r);u.Oe=r}n=we(t);if(n!==u.Pe){u.h.st.setValue(n);u.Pe=n}r=t?a(B(t)):0;if(r!==u.ze){u.h.bk.setValue(r);u.ze=r}Le(t)}function Pe(e,t){return e&&t&&e[0]===t[0]&&e[1]===t[1]&&e[2]===t[2]}function ze(){var e=Shelly.getComponentConfig(\"plugs_ui\"),t,n;u.led=\"?\";if(!e||!e.leds||e.leds.mode!==\"switch\"||!e.leds.colors||!e.leds.colors[\"switch:0\"])return;t=e.leds.colors[\"switch:0\"].off;for(n in r)if(n!==\"run\"&&t&&Pe(t.rgb,r[n]))u.led=n}function Le(e){var t=\"ok\",n=f(),i=[],l;if(u.weld||u.ke&&e&&e.day===_(u.ke.u).day)t=\"err\";else if(!e||u.off||u.est)t=\"warn\";if(t!==u.Ie){u.Ie=t;u.Ue=n}if(t===u.led||n-u.Ue<120)return;for(l=0;l<u.ledN.length;l++)if(n-u.ledN[l]<86400)i.push(u.ledN[l]);u.ledN=i;if(i.length>=12)return;u.led=t;u.ledN.push(n);Shelly.call(\"PLUGS_UI.SetConfig\",{config:{leds:{mode:\"switch\",colors:{\"switch:0\":{on:{rgb:r.run,brightness:60},off:{rgb:r[t],brightness:t===\"ok\"?20:60}}}}}},Fe)}function Fe(e,t,n){if(t){m(\"LED nicht gesetzt: \"+n);u.led=\"?\";u.Ue=f()+3480}}function Ie(){var e;u.k++;try{e=p();if(e.output&&!u.run)fe(e);else if(!e.output&&u.run)he(e);else if(e.output&&u.run)oe(e);else if(u.ps&&f()>u.ps.He){fe(e,1);u.run.why=\"start\";he(e)}if(!e.output)me(e);u.boot=false}catch(e){m(\"Fehler Takt: \"+e)}if(u.k%30===1){try{Ee()}catch(e){m(\"Fehler Plan: \"+e)}}if(u.k%10===2){try{Oe()}catch(e){m(\"Fehler Anzeige: \"+e)}}}function Ue(){var t=Shelly.getComponentConfig(\"switch\",0)||{},n={},r=false;if(t.initial_state!==\"off\"){n.initial_state=\"off\";r=true}if(t.auto_off!==true){n.auto_off=true;r=true}if(t.auto_off_delay!==e.ee){n.auto_off_delay=e.ee;r=true}if(t.auto_on===true){n.auto_on=false;r=true}if(t.autorecover_voltage_errors===true){n.autorecover_voltage_errors=false;r=true}if(t.name!==\"Brunnenpumpe\"){n.name=\"Brunnenpumpe\";r=true}if(r)Shelly.call(\"Switch.SetConfig\",{id:0,config:n},S)}var He=\"0 */5 * * * *\";function We(){Shelly.call(\"Schedule.List\",{},xe)}function xe(e,t,n){var r=e&&e.jobs||[],i,u,f;if(t){m(\"Zeitplan nicht lesbar: \"+n);return}for(i=0;i<r.length;i++){f=r[i].calls||[];for(u=0;u<f.length;u++){if(String(f[u].method).toLowerCase()===\"script.start\"&&f[u].params&&f[u].params.id===Script.id){if(r[i].enable!==true||r[i].timespec!==He){Shelly.call(\"Schedule.Update\",{id:r[i].id,enable:true,timespec:He},S)}return}}}Shelly.call(\"Schedule.Create\",{enable:true,timespec:He,calls:[{method:\"Script.Start\",params:{id:Script.id}}]},S);m(\"W\\xC3\\xA4chter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht\")}function Ce(){E();if(typeof e.S===\"number\"&&typeof e._===\"number\"){u.la=e.S;u.lo=e._}else if(i.la!==null){u.la=i.la;u.lo=i.lo}var t=Shelly.getComponentStatus(\"sys\"),n=f();if(t&&typeof t.unixtime===\"number\"&&t.unixtime>e.Te&&(!i.ce||n<i.tu||N())){if(i.ce||i.df){if(i.df===1)Ne(_(t.unixtime).day-_(i.t).day);i.ce=0;k()}}else if(i.t>e.Te){u.eb=i.t+(n>=i.tu?n-i.tu:n);u.eu=n;u.est=true;u.def=i.df===1;i.ce=1;i.cs=Math.floor(u.eb);Shelly.call(\"Sys.SetTime\",{unixtime:i.cs},S);m(\"Uhr aus Zeitanker gesch\\xC3\\xA4tzt\");k()}else u.Le=n+120;Ue();We();u.cfgAt=n+3600;ze();P();Timer.set(1e3,true,Ie);m(\"gestartet, Bodenkonto \"+a(i.d)+\" mm, Normalleistung \"+(i.pn||\"noch nicht gelernt\"))}Ce();";
window.__bw = { fertig: false, log: [] };
deployShelly("", CODE, function (t) { console.log(t); window.__bw.log.push(t); })
  .then(function (r) { window.__bw.ergebnis = r; window.__bw.fertig = true; })
  .catch(function (e) { window.__bw.fehler = String((e && e.message) || e); window.__bw.fertig = true; });
return "Aufspielen gestartet, 23914 Byte";
})();
