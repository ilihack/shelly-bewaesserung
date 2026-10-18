'use strict';
/*
 * Spielt das Bewässerungsskript auf den Shelly Outdoor Plug S Gen3 und prüft das Ergebnis.
 * Ein Ablauf, zwei Wege:
 *   Node (ab 18):   node tools/deploy.js <ip-des-shelly> [build/bewaesserung.min.js]
 *   Browser:        auf der Weboberfläche des Shelly (http://<ip>/) in der Konsole
 *                   deployShelly("", CODE).then(console.log)   (gleiche Herkunft, kein CORS)
 * Schritte: Gerät prüfen -> Firmware >= 2.0.1 (sonst Update, mindestens 1.5) -> Matter aus -> Skript anlegen/ersetzen
 *           -> Autostart an -> starten, Bedienfeld anlegen lassen, Skript neu starten -> Ergebnis prüfen:
 *           Skript läuft fehlerfrei, Einschaltzustand aus, Notabschaltung 9600 s, Bedienfeld vollständig,
 *           Statuszeile da, Wetterdienst vom Gerät erreichbar, Selbsttest im Skript ok, Speicherreserve >= 2 KB.
 */
async function deployShelly(base, code, log) {
  log = log || function (t) { (typeof console !== 'undefined') && console.log(t); };
  const NAME = 'bewaesserung';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpc(method, params) {
    const r = await fetch(base + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, method: method, params: params || {} }) });
    if (r.status === 401) throw new Error('Gerät hat ein Passwort – erst im Browser anmelden');
    const j = await r.json();
    if (j.error) throw new Error(method + ': ' + j.error.message);
    return j.result;
  }
  async function waitOnline(maxS) {
    for (let i = 0; i < maxS / 5; i++) {
      await sleep(5000);
      try { return await rpc('Shelly.GetDeviceInfo'); } catch (e) { /* bootet noch */ }
    }
    throw new Error('Gerät kommt nicht wieder');
  }
  const verNum = (v) => (v || '0.0.0').split('-')[0].split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
  const out = { schritte: [] };
  const step = (t) => { out.schritte.push(t); log(t); };

  // 1. Gerät
  if (/[^\x00-\x7F]/.test(code)) throw new Error('Code enthält Nicht-ASCII – bitte die Gerätefassung (build) nehmen');
  let info = await rpc('Shelly.GetDeviceInfo');
  step('Gerät: ' + info.model + ' (' + info.app + '), Firmware ' + info.ver + ', Gen ' + info.gen);
  if (info.model !== 'S3PL-20112EU') step('WARNUNG: kein Outdoor Plug S Gen3 – Modell ' + info.model);

  // 2. Firmware: Script.storage braucht 1.5.0; 2.0.1 behebt u. a. Messfehler des Strommesschips (1.7.4) und einen
  //    Pufferüberlauf bei gestückelten HTTP-Antworten (2.0.1), wie sie Open-Meteo schickt
  if (verNum(info.ver) < verNum('2.0.1')) {
    step('Firmware ' + info.ver + ' älter als 2.0.1 – Update auf stabil wird angestoßen');
    try {
      await rpc('Shelly.Update', { stage: 'stable' });
      info = await waitOnline(300);
      step('Firmware jetzt ' + info.ver);
    } catch (e) { step('Update nicht möglich: ' + e.message); }
    if (verNum(info.ver) < verNum('1.5.0')) throw new Error('Firmware weiterhin < 1.5.0');
    if (verNum(info.ver) < verNum('2.0.1')) step('WARNUNG: Firmware unter 2.0.1 – läuft, aber bitte später aktualisieren');
  }

  // 3. Matter aus (Skripte laufen nur ohne Matter)
  try {
    const m = await rpc('Matter.GetConfig');
    if (m && m.enable) {
      const r = await rpc('Matter.SetConfig', { config: { enable: false } });
      step('Matter abgeschaltet');
      if (r && r.restart_required) { await rpc('Shelly.Reboot'); await waitOnline(120); step('Neustart nach Matter'); }
    } else step('Matter ist aus');
  } catch (e) { step('Matter: ' + e.message); }

  // 4. Skript anlegen oder ersetzen
  const list = (await rpc('Script.List')).scripts || [];
  let s = list.find((x) => x.name === NAME);
  if (s && s.running) { await rpc('Script.Stop', { id: s.id }); step('altes Skript gestoppt'); }
  if (!s) { s = { id: (await rpc('Script.Create', { name: NAME })).id }; step('Skriptplatz angelegt: ' + s.id); }
  let len = 0;
  for (let i = 0; i < code.length; i += 1024) {
    len = (await rpc('Script.PutCode', { id: s.id, code: code.slice(i, i + 1024), append: i > 0 })).len;
  }
  if (len !== code.length) throw new Error('Hochladen unvollständig: ' + len + ' von ' + code.length);
  step('Code hochgeladen: ' + len + ' Byte');
  await rpc('Script.SetConfig', { id: s.id, config: { enable: true } });
  step('Autostart an');

  // 5. Starten, Bedienfeld anlegen lassen, einmal neu starten (Handles nach dem Anlegen)
  await rpc('Script.Start', { id: s.id });
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
  out.ok = st.running && !st.errors && cfg.initial_state === 'off' && cfg.auto_off === true &&
    cfg.auto_off_delay === 9600 && cfg.auto_on !== true && fehlt.length === 0 && !!out.status && /^ok/.test(out.wetter) && reserve >= 2048 &&
    /^ok/.test(selbst);
  step(out.ok ? 'FERTIG – alles in Ordnung' : 'PRÜFEN – siehe oben');
  return out;
}

if (typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const ip = process.argv[2];
  if (!ip) { console.log('Aufruf: node tools/deploy.js <ip> [gerätefassung.js]'); process.exit(2); }
  const file = process.argv[3] || path.join(__dirname, '..', 'build', 'bewaesserung.min.js');
  deployShelly('http://' + ip, fs.readFileSync(file, 'utf8'))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error('ABBRUCH: ' + e.message); process.exit(1); });
}
if (typeof module !== 'undefined') module.exports = { deployShelly };
