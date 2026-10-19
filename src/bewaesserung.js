/*
 * Bewässerung mit Brunnen- oder Gartenpumpe am Shelly Outdoor Plug S Gen3 (Shelly-Skript für Gen2/Gen3)
 * Eingestellt für: Tiefbrunnenpumpe IBO 3,5" SDM 5/14 (1100 W, 7,9 A), 3 Regner Rain Bird 5000, 500 m² Rasen.
 *
 * Was das Skript tut (Begründungen in der Bauanleitung, Kapitel in [Klammern]):
 *  - prüft täglich um START_MIN das Bodenkonto und gießt bei Bedarf; Automatik startet nur bis END_MIN [2]
 *  - rechnet mit Wetterdaten von Open-Meteo; ohne Internet mit Monatsmitteln und der Temperatur des
 *    eigenen Fühlers, korrigiert mit echten Daten, sobald das Internet zurück ist [2]
 *  - Taster oder App einschalten = Handgabe, nochmal = Stopp [3]
 *  - schützt die Pumpe über die gemessene Leistung, relativ zur selbst gelernten Normalleistung [4]
 *  - übersteht Stromausfälle: Zeitanker alle 6 h, Uhr am Tagesgang der Temperatur nachgestellt [5]
 *  - Bedienfeld in der Shelly-App: Status, Bodenkonto, Automatik, Pause, Regenrate, Neu einlernen [3]
 *
 * Lesehilfe: Einstellungen C, Klima -> Zustand S (gespeichert) und R (nur RAM) -> Helfer, Zeit, Speicher ->
 * Bodenkonto -> Gerätetemperatur und Uhr -> Relais und Pumpenschutz -> Wetter und Tagesentscheidung ->
 * Takt (tick jede s, schedule alle 30 s) -> Bedienfeld und LED -> Start (init).
 * Sprache: nur, was der Shelly-Interpreter sicher kann: ES5, keine Pfeilfunktionen, kein const, keine
 * Template-Strings, kein Hoisting, Rückrufe benannt und nicht verschachtelt.
 */

// ============================== Einstellungen ==============================
var C = {
  // Ort und Zeit
  ORT: "Ludwigshafen am Rhein", LAND: "DE", // Ortsname oder "auto" (Ort über die IP-Adresse). Koordinaten holt das
                                 // Skript einmal und speichert sie; eine IP-Ortung prüft täglich, ob der Ort passt.
                                 // Schreibweise prüfen, der erste Treffer zählt:
                                 // https://geocoding-api.open-meteo.com/v1/search?countryCode=DE&language=de&name=Ludwigshafen
  LAT: null, LON: null,          // oder direkt eintragen (z. B. 49.48, 8.45), dann ohne Ortssuche und IP-Ortung
  LOC_KM: 100,                   // Ort weiter als max(LOC_KM, 2 × Ungenauigkeit) von der IP-Ortung: „Ort prüfen“
  UTC_H: 1,                      // Normalzeit gegen UTC (Deutschland 1); Sommerzeit nach EU-Regel

  // Wann gegossen wird
  START_MIN: 600,                // 10:00 tägliche Prüfung (Minuten nach Mitternacht, Ortszeit)
  END_MIN: 750,                  // 12:30 danach startet keine Automatik mehr (Nachholen, Nachläufe, Nachprüfung);
                                 // haben Regen oder Frost die Gabe verhindert: stündlich nachsehen (11:05, 12:05)
  SEASON_FROM: 3, SEASON_TO: 11, // Monate mit Automatik, sonst Winterpause

  // Wie viel gegossen wird
  RATE_MM_H: 8.6,                // Regenrate der Regner (mm/h), Startwert fürs Bedienfeld; Becher-Test [6]
  KC: 0.85,                      // Pflanzenfaktor Rasen (FAO-56, sparsam gepflegt) [8]
  TRIGGER_MM: 8,                 // ab diesem Bodendefizit gießen
  DOSE_MIN_MM: 5,                // kleinere Gaben lohnen nicht
  DOSE_MAX_MM: 15,               // größte Gabe je Lauf
  D_MAX_MM: 25,                  // Bodenkonto ist nach oben begrenzt (Wurzelraum)
  HAND_MIN_MM: 6,                // Handgabe mindestens
  RAIN_PROB_MIN: 60,             // Regenprognose zählt ab 60 % Wahrscheinlichkeit
  RAIN_LOSS_MM: 1,               // so viel Regen je Tag erreicht den Boden nicht
  FROST_C: 5,                    // Tiefstwert der Prognose darunter: Frostnacht (am Boden ist es in klaren Nächten kälter)
  FROST_OFF_C: 5,                // ohne Internet: geschätzter Tiefstwert darunter (Gerätefühler minus Eigenwärme)
  FROST_THAW_C: 5,               // nach einer Frostnacht erst gießen, wenn die Luft so warm ist (stündlich geprüft)
  OFF_ET: 1.1,                   // ohne Internet lieber mehr: trockene Tage liegen 5 % zu tief, +5 % Reserve [2]

  // Pumpe: an die eigene Pumpe anpassen. I = Nennstrom laut Typenschild (A); gerechnet wird mit dem Strom, weil die
  // Watt-Angabe im Katalog oft die Leistung an der Welle ist. Tauchpumpe: P_LEARN_MIN 115·I, P_LEARN_MAX 240·I,
  // P_ABS_DRY 78·I, P_ABS_OVER 265·I, I_MAX 1,33·I (höchstens 11 A; Pumpen über 9 A passen nicht an diesen Stecker).
  // Oberflächen-/Jetpumpe: dieselben Formeln, BLANK_S = Ansaugzeit + 20 s. Hauswasserwerk mit Druckschalter: ungeeignet.
  // Nach dem ersten Lauf gilt die gelernte Normalleistung; Hahn-zu-Leistung messen, UNDER_REL = (P_HahnZu/P_normal + 1) / 2.
  P_LEARN_MIN: 900, P_LEARN_MAX: 1900, // erste Normalleistung nur in diesem Bereich übernehmen (W)
  P_ABS_DRY: 600,                // vor dem Einlernen: darunter Trockenlauf (W)
  P_ABS_OVER: 2100,              // vor dem Einlernen: darüber Überlast (W)
  I_MAX: 10.5,                   // Strom darüber = blockiert (A); Stecker selbst: 12 A
  MAX_RUN_MIN: 150,              // längster Lauf, den das Skript plant
  AUTO_OFF_S: 9600,              // Notabschaltung des Relais (160 min), wirkt auch ohne Skript
  MAX_STARTS_H: 10,              // Starts je Stunde: die Hälfte des Datenblattwerts (diese Pumpe verträgt 20)

  // Fachwerte: nur mit Grund ändern
  UNDER_REL: 0.75,               // darunter Unterlast (Trockenlauf / Hahn zu)
  OVER_REL: 1.30,                // darüber Überlast
  LEARN_GATE: 0.30,              // Nachlernen nur bei Abweichung bis 30 %
  NOLOAD_W: 50,                  // darunter zieht die Pumpe keinen Strom
  BLANK_S: 40,                   // Anlaufzeit ohne Über-/Unterlastprüfung
  UNDER_S: 8, OVER_S: 5, NOLOAD_S: 5, I_S: 2, // so viele Sekunden muss eine Abweichung anstehen
  MIN_OFF_S: 120,                // Automatik startet frühestens 2 min nach dem letzten Stopp
  RETRY_MIN: 60,                 // Nachlauf nach Störung frühestens nach 60 min (Brunnen läuft nach)
  RETRY_START_MIN: 6,            // Störung in den ersten 10 s (Anlauf): Nachlauf schon nach 6 min
  RETRIES_DRY: 2,                // Nachläufe je Tag nach Trockenlauf; sonst 1
  SELF_NIGHT_K: 15,              // Eigenwärme nachts, bis gelernt: eher hoch, Frost lieber zu früh erkennen [2]
  SELF_DAY_K: 10,                // Eigenwärme tags, bis gelernt: eher niedrig, lieber etwas mehr Wasser [2]
  ET_K: 0.06,                    // ohne Internet: Verdunstung +6 % je K Tageshöchstwert über dem Monatsmittel [2]
  CLOCK_S: 5400,                 // geschätzte Uhr am Tagesgang erst ab 1,5 h Abweichung stellen [5]
  CLOCK_LATE_S: 3600,            // dabei 1 h hinter den errechneten Wert: in 95 % der Fälle nicht zu früh [5]
  ANCHOR_S: 21600,               // Zeitanker alle 6 h speichern: 4 Schreibvorgänge am Tag [5]
  WRITES_DAY: 48,                // Schreibbremse Speicher: höchstens 1 je Minute, nach 48 in 24 h 1 je Stunde [5]
  CFG_DAY: 30,                   // Schreibbremse Bedienfeld und Zeitpläne: höchstens 30 in 24 h; LED hat eigene 12 am Tag,
                                 // die Relais-Sicherungen bremst nichts (höchstens stündlich, nur wenn verstellt) [5]
  RUN_SAVE_S: 3600,              // laufende Gabe stündlich gutschreiben
  T_MIN: 1767225600              // frühere Uhrzeiten sind ungültig (vor 2026)
};

// Klima des Ortes, Monatsmittel Januar bis Dezember, nur ohne Internet benutzt [2].
// Hier DWD Mannheim 2016–2025; für einen anderen Ort: python3 tools/klima.py "Ortsname" [LAND]
var ET0_CLIM = [0.6, 0.9, 1.6, 2.6, 3.5, 4.5, 4.4, 3.8, 2.4, 1.1, 0.5, 0.5];   // Grasreferenzverdunstung (mm/Tag)
var TMAX_CLIM = [6.1, 9.3, 13.0, 17.0, 21.1, 26.3, 27.4, 27.4, 22.8, 16.7, 9.6, 6.8]; // Tageshöchstwert (°C)

// LED des Steckers (Farben 0..100, volle Helligkeit, auch in der Sonne zu sehen): grün = alles gut, gelb = Daten
// fehlen (Wetterdienst, Uhr, Ort, Speicher), violett = der letzte Lauf hatte eine Störung (bleibt, bis ein Lauf wieder
// fehlerfrei war, auch über Neustarts), blau = Pumpe läuft. Rot belegt die Firmware (WLAN weg, Update), Blau blinkend den AP.
// Jede Änderung ist ein Flash-Schreibvorgang: nur bei Zustandswechsel, nach 2 min Bestand, höchstens 12 am Tag [3]
var LED = { ok: [0, 100, 0], warn: [100, 70, 0], err: [100, 0, 100], run: [0, 0, 100] };
// IP-Ortung (MaxMind GeoLite über GeoJS): https, ohne Schlüssel; für ORT "auto" und die tägliche Ortsprüfung [2]
var IP_URL = "https://get.geojs.io/v1/ip/geo.json";

// ============================== Zustand ==============================
// S wird gespeichert (Script.storage, ein Eintrag), R lebt nur im RAM.
var S = null;
var R = {
  k: 0,              // Takt-Zähler
  eb: 0, eu: 0,      // Uhr-Schätzung: Basis-Unixzeit und Uptime dazu
  est: false,        // Uhr ist geschätzt (kein Internet seit Neustart)
  run: null,         // laufende Beregnung
  ps: null,          // eigener Start ist unterwegs
  want: null,        // aufgeschobener Automatik-Start
  starts: [],        // Uptimes der Starts der letzten Stunde
  lastStop: 0,       // Uptime des letzten Stopps
  wc: 0, weld: false,// Relais-Prüfung bei AUS
  wx: { busy: false, next: 0, tries: 0, L: null, n: 0, rc: false, t: 0, q: 0, cg: 0 },  // Wetterabruf: läuft seit t, Nummer q
  off: false,        // letzte Wetterabfrage gescheitert
  pf: false, pk: false, // letzter Verbindungstest gescheitert; seit dem Start schon einer gelaufen
  lw: "", ia: 60,    // Hinweis der Ortsprüfung; nächste IP-Ortung (Uptime)
  sv: -1e9, sd: false, wn: 0, w24: 0, // Schreibbremse Speicher: letztes Schreiben, noch zu schreiben, Anzahl, Fensterbeginn
  cn: 0, c24: 0,     // Schreibbremse Bedienfeld und Zeitpläne: Anzahl, Fensterbeginn
  why: "",           // Ergebnis der heutigen Prüfung
  note: "", noteU: 0,// Hinweis (Einlernen usw.), verschwindet nach 12 h
  noStore: false,
  h: null,           // Bedienfeld-Handles
  paShown: -1, lastTxt: "", lastD: -1,
  boot: true,
  def: false, defAt: 0,  // Uhrzeit angenommen (15. April 10:00), weil nichts bekannt war
  pbNext: 0,         // nächste Internetprobe (Uptime), solange die Uhr geschätzt ist oder Internet fehlte
  cfgAt: 0, sn: 0,   // nächstes Nachstellen von Relais-Einstellungen und Zeitplänen (Uptime); Schritt dabei
  cg: 0,             // Uhr-Generation: zählt jedes Stellen der Uhr; ein Wetterabruf von davor wird verworfen
  hp: 0, ht: 0, hc: 0, // Uhr aus dem Wetterdienst: Stellen läuft seit (Uptime), Zeit minus Uptime, nächster Versuch ab
  hb: 0, hn: 0, hr: 0, hl: 0, // Bedienfeld: letzter Versuch anzulegen und zu binden (Uptime); Versuche; Taster-Abo; Verluste
  led: "", ledWant: "", ledSince: 0, ledN: [],
  td: null, ty: null, ts: -1e9, // Gerätetemperatur heute / gestern {d, n, mn, mx}, letzte Messung
  z: null, zf: -1e9, zl: 0, zn: 0, cp: 0, co: 0, // Tagesgang-Uhr: letzte Korrektur, Betrag, schon gestellt, Stellen läuft
  rh: 0, nf: false,  // Minute der nächsten Nachprüfung nach Regen oder Frost (0 = gleich, auch nach Neustart); Prognose heute nicht zählen
  la: null, lo: null, gn: 0,  // Koordinaten; nächste Ortsabfrage (Uptime)
  st: ""                 // Ergebnis des Selbsttests fürs Aufspielwerkzeug
};

// ============================== Kleine Helfer ==============================
function upS() { return Shelly.getUptimeMs() / 1000; }
function r0(x) { return Math.round(x); }
function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }
function f1(x) { return String(r1(x)).replace(".", ","); }   // Anzeige mit Dezimalkomma
function lim(x, a, b) { return x < a ? a : (x > b ? b : x); }
function p2(n) { return (n < 10 ? "0" : "") + n; }
function log(t) { print("[BW] " + t); }
function sw() { return Shelly.getComponentStatus("switch", 0) || {}; }
function cbNone(res, err, msg) { if (err) log("RPC-Fehler " + err + " " + msg); }
// Ein Fehler in einem Rückruf beendet ein Shelly-Skript (der Wächter startet es erst nach bis zu 5 min neu). Darum
// laufen die Rückrufe über cbSafe (Rückruf als userdata): Fehler werden gemeldet, die Wiederholung kommt vom Takt.
function cbSafe(res, err, msg, f) {
  try { f(res, err, msg); } catch (e) { log("Fehler im Rückruf: " + e); }
}

// ============================== Zeit (C.UTC_H mit EU-Sommerzeit, ohne Firmware-Zeitzone) ==============================
function dfc(y, m, d) {                   // Tagesnummer seit 1970-01-01
  y -= m <= 2 ? 1 : 0;
  var era = Math.floor(y / 400), yoe = y - era * 400;
  var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function cfd(z) {                         // Tagesnummer -> {y, m, d}
  z += 719468;
  var era = Math.floor(z / 146097), doe = z - era * 146097;
  var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  var mp = Math.floor((5 * doy + 2) / 153);
  var m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m: m, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}
function lastSun(y, m) {                  // Tagesnummer des letzten Sonntags im Monat
  var last = dfc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1;
  return last - ((last + 4) % 7);         // 1970-01-01 war ein Donnerstag
}
function utcOff(u) {                      // Sommerzeit vom letzten So im März bis letzten So im Oktober, je 01:00 UTC
  var y = cfd(Math.floor(u / 86400)).y;
  var a = lastSun(y, 3) * 86400 + 3600, b = lastSun(y, 10) * 86400 + 3600;
  return (C.UTC_H + (u >= a && u < b ? 1 : 0)) * 3600;
}
function loc(u) {                         // Ortszeit: Tagesnummer, Minute, Datum
  var t = u + utcOff(u), day = Math.floor(t / 86400), c = cfd(day);
  return { day: day, min: Math.floor((t - day * 86400) / 60), y: c.y, m: c.m, d: c.d };
}
function ymd(L) { return L.y + "-" + p2(L.m) + "-" + p2(L.d); }
function hm(min) { return p2(Math.floor(min / 60)) + ":" + p2(min % 60); }
function dmy(day) { var c = cfd(day); return p2(c.d) + "." + p2(c.m) + "."; }
function sunUtc(day) {                    // Sonnenaufgang in Minuten nach Mitternacht UTC (NOAA-Näherung) [5]
  var c = cfd(day), g = 2 * Math.PI / 365 * (day - dfc(c.y, 1, 1));
  var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) -
    0.040849 * Math.sin(2 * g));
  var de = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g);
  var la = (R.la === null ? 50 : R.la) * Math.PI / 180;   // Ort noch unbekannt: Mitte der Zeitzone
  var ha = Math.acos(Math.cos(1.58534) / (Math.cos(la) * Math.cos(de)) - Math.tan(la) * Math.tan(de));
  return 720 - 4 * ((R.lo === null ? 15 * C.UTC_H : R.lo) + ha * 180 / Math.PI) - eq;
}

function nowU() {                         // Unixzeit; geschätzt ab Zeitanker, wenn keine echte Zeit da ist
  var s = Shelly.getComponentStatus("sys");
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN) return s.unixtime;
  if (R.eb) return R.eb + upS() - R.eu;
  return null;
}

function ntpSet() {                       // Zeitserver hat gestellt (nicht unser Sys.SetTime)?
  var s = Shelly.getComponentStatus("sys");
  return !!s && typeof s.last_sync_ts === "number" && Math.abs(s.last_sync_ts - S.cs) > 5;
}

// ============================== Speicher ==============================
function load() {
  var v = null;
  try { v = JSON.parse(Script.storage.getItem("s")); } catch (e) { v = null; }
  if (!v || v.v !== 1) v = { v: 1 };
  if (typeof v.t !== "number") v.t = 0;     // Zeitanker
  if (typeof v.d !== "number" || !(v.d >= 0 && v.d <= C.D_MAX_MM)) v.d = 0;   // Bodendefizit am Ende des letzten verbuchten Tages
  if (typeof v.dp !== "number") v.dp = -1;  // letzter verbuchter Tag
  if (typeof v.pi !== "number" || !(v.pi >= 0)) v.pi = 0;   // seither gegossen (mm)
  if (typeof v.ev !== "number") v.ev = -1;  // Tag der letzten Tagesprüfung
  if (typeof v.pn !== "number") v.pn = 0;   // gelernte Normalleistung (W), 0 = noch nicht
  if (typeof v.ln !== "number") v.ln = 0;
  if (typeof v.pu !== "number") v.pu = 0;   // Pause bis einschließlich Tag
  if (typeof v.fd !== "number") v.fd = -1;  // Tag der Störungszählung
  if (typeof v.fc !== "number") v.fc = 0;   // Störungen an diesem Tag
  if (typeof v.rt !== "number") v.rt = 0;   // Nachlauf ab Unixzeit
  if (typeof v.rm !== "number") v.rm = 0;   // Nachlauf-Menge (mm)
  if (typeof v.lr !== "string") v.lr = "";  // letzter Lauf, für die Anzeige
  if (typeof v.xa !== "number") v.xa = -1;  // erster Tag, der ohne Internet geschätzt verbucht wurde
  if (!v.xe || typeof v.xe.length !== "number") v.xe = [];  // die Schätzungen dieser Tage (mm), für die Korrektur
  if (!v.xw || typeof v.xw.length !== "number" || v.xw.length !== v.xe.length) { v.xw = []; v.xe = []; v.xa = -1; }  // davor gegossen
  if (typeof v.xd !== "number") v.xd = 0;   // Konto vor dem ersten geschätzten Tag: die Korrektur rechnet von hier neu
  if (typeof v.ob !== "number") v.ob = -99; // gelernte Eigenwärme beim Tiefstwert (K), -99 = noch nicht
  if (typeof v.oa !== "number") v.oa = -99; // gelernte Eigenwärme beim Höchstwert (K)
  if (typeof v.df !== "number") v.df = 0;   // 1 = Uhrzeit beruht auf der Annahme 15. April 10:00
  if (typeof v.rd !== "number") v.rd = -1;  // Tag, an dem die Regenprognose die Gabe gekürzt hat
  if (typeof v.rx !== "number") v.rx = 0;   // dabei erwarteter Regen (mm)
  if (typeof v.rc !== "number") v.rc = -1;  // Tag, an dem Regen oder Frost die Gabe verhindert hat: stündlich nachsehen
  if (typeof v.rk !== "number") v.rk = 0;   // warum: 1 Frost laut Prognose, 3 Frost geschätzt, 2 Regen
  if (typeof v.rf !== "number") v.rf = 0;   // Tiefstwert dieser Frostnacht (°C)
  if (typeof v.tu !== "number") v.tu = 0;   // Laufzeit des Geräts beim Zeitanker (s): Skript-Neustart erkennen
  if (typeof v.ce !== "number") v.ce = 0;   // 1 = Geräteuhr vom Skript geschätzt, Zeitserver hat sie seither nicht gestellt
  if (typeof v.cs !== "number") v.cs = 0;   // zuletzt vom Skript gestellte Uhrzeit, vom Zeitserver zu unterscheiden
  if (typeof v.fu !== "number") v.fu = 0;   // letzte Störung (Unixzeit, 1 = Zeit unbekannt), bis ein Lauf fehlerfrei war
  if (typeof v.ft !== "string") v.ft = "";  // ihr Text
  if (typeof v.lf !== "number") v.lf = 0;   // 1 = Ortsname nicht gefunden, Ort per IP
  if (typeof v.lc !== "string") v.lc = "";  // Ort laut IP-Ortung, für die Anzeige
  if (typeof v.lq !== "number") v.lq = 999; // seine Ungenauigkeit (km)
  if (typeof v.wu !== "number") v.wu = 0;   // Schreibbremse über Skript-Neustarts: Laufzeit beim letzten Schreiben (s),
  if (typeof v.wn !== "number") v.wn = 0;   // Anzahl im Fenster
  if (typeof v.wb !== "number") v.wb = 0;   // und Fensterbeginn (Laufzeit, s)
  if (v.pz !== C.LAND + C.ORT || typeof v.la !== "number" || typeof v.lo !== "number") {   // Ort neu bestimmen
    v.la = null; v.lo = null; v.pz = ""; v.lf = 0; v.lc = ""; v.lq = 999;
  }
  S = v;
}
function save() { R.sd = true; flush(); }   // gleich schreiben oder, von der Schreibbremse gehalten, im Takt
function flush() {                        // Schreibbremse: höchstens 1 je Minute, nach WRITES_DAY in 24 h 1 je Stunde;
  var now = upS(), u;                     // fängt auch einen Fehler ab, der save() in Schleife riefe [5]
  if (!R.sd) return;
  if (now - R.w24 >= 86400) { R.w24 = now; R.wn = 0; }
  if (now - R.sv < (R.wn >= C.WRITES_DAY ? 3600 : 60)) return;
  u = nowU();
  if (u) { S.t = Math.floor(u); S.tu = Math.floor(now); }
  S.d = r2(S.d); S.pi = r2(S.pi);
  S.wu = Math.floor(now); S.wn = R.wn + 1; S.wb = Math.floor(R.w24);   // gilt so auch nach einem Skript-Neustart
  try { Script.storage.setItem("s", JSON.stringify(S)); R.noStore = false; R.sd = false; }
  catch (e) { R.noStore = true; }
  R.sv = now; R.wn++;                     // auch ein Fehlversuch zählt: kein Dauerversuch
}
function cfgCall(m, p, f) {               // Bedienfeld und Zeitpläne schreiben (Flash): höchstens CFG_DAY in 24 h; false = gebremst
  var now = upS();
  if (now - R.c24 >= 86400) { R.c24 = now; R.cn = 0; }
  if (R.cn >= C.CFG_DAY) { if (R.cn++ === C.CFG_DAY) log("Schreibbremse Einstellungen: " + m); return false; }
  Shelly.call(m, p, cbSafe, f);
  R.cn++;
  return true;
}

// ============================== Bedienfeld (Virtual Components) ==============================
var VC = [
  ["text", 200, "st", { name: "Status", default_value: "", persisted: false, max_len: 255,
    meta: { ui: { view: "label" } } }],
  ["number", 200, "bk", { name: "Wasserdefizit", default_value: 0, persisted: false, min: 0, max: 25,
    meta: { ui: { view: "progressbar", unit: "mm", step: 0.1 } } }],
  ["boolean", 200, "au", { name: "Automatik", default_value: true, persisted: true,
    meta: { ui: { view: "toggle", titles: ["Aus", "An"] } } }],
  ["number", 201, "pa", { name: "Pause", default_value: 0, persisted: false, min: 0, max: 14,
    meta: { ui: { view: "field", unit: "Tage", step: 1 } } }],
  ["number", 202, "ra", { name: "Regenrate", default_value: C.RATE_MM_H, persisted: true, min: 1, max: 40,
    meta: { ui: { view: "field", unit: "mm/h", step: 0.1 } } }],
  ["button", 200, "re", { name: "Pumpe neu einlernen", meta: { ui: { view: "button" } } }]
];
var vcI = 0;

function vcNext() {
  if (vcI < VC.length) {
    var s = VC[vcI];
    if (Shelly.getComponentConfig(s[0], s[1])) { vcI++; vcNext(); return; }
    cfgCall("Virtual.Add", { type: s[0], id: s[1], config: s[3] }, vcAdded);
    return;
  }
  if (!Shelly.getComponentConfig("group", 200)) {
    cfgCall("Virtual.Add", { type: "group", id: 200,
      config: { name: "Bewässerung", meta: { ui: { view: "group" } } } }, vcGroupAdded);
    return;
  }
  vcGroupAdded(null, 0, "");
}
function vcStart() { R.hb = upS(); R.hn++; vcI = 0; vcNext(); }   // Bedienfeld anlegen (was fehlt) und binden
function vcAdded(res, err, msg) {
  if (err) log("Bedienfeld " + VC[vcI][2] + ": " + msg);
  vcI++; vcNext();
}
function vcGroupAdded(res, err, msg) {
  var want = [], i, g = Shelly.getComponentStatus("group", 200);
  for (i = 0; i < VC.length; i++) want.push(VC[i][0] + ":" + VC[i][1]);
  if (!g || JSON.stringify(g.value) !== JSON.stringify(want)) {
    cfgCall("Group.Set", { id: 200, value: want }, cbNone);
  }
  vcBind();
}
function vcBind() {
  var h = {}, i, ok = true;
  if (R.h) return;                        // schon gebunden (zwei Durchläufe gleichzeitig)
  try {
    for (i = 0; i < VC.length; i++) {
      h[VC[i][2]] = Virtual.getHandle(VC[i][0] + ":" + VC[i][1]);
      if (!h[VC[i][2]]) ok = false;
    }
    if (ok) R.hr = h.re.on("single_push", onRelearn);
  } catch (e) { ok = false; }
  if (!ok) {                              // ohne Anzeige weiter; schedule() versucht es erst minütlich, dann stündlich
    if (R.hn === 1) log("Bedienfeld unvollständig – ohne Anzeige weiter");
    return;
  }
  R.h = h;
  if (R.hn > 1) log("Bedienfeld verbunden");
}
function onRelearn(ev) {
  try { S.pn = 0; S.ln = 0; save(); note("Pumpe wird beim nächsten Lauf neu eingelernt"); }
  catch (e) { log("Fehler Taster: " + e); }
}
function rate() {
  var v = R.h ? R.h.ra.getValue() : null;
  return (typeof v === "number" && v >= 1 && v <= 40) ? v : C.RATE_MM_H;
}
function autoOn() { return !R.h || R.h.au.getValue() !== false; }
function paused(L) { return S.pu && L.day <= S.pu; }

// ============================== Bodenkonto ==============================
function climEt(m) { return ET0_CLIM[m - 1]; }
function inSeason(L) {                    // auch über den Jahreswechsel (Südhalbkugel: FROM > TO)
  var a = C.SEASON_FROM, b = C.SEASON_TO;
  return a <= b ? L.m >= a && L.m <= b : L.m >= a || L.m <= b;
}
function pending(L) { return S.dp < 0 ? 0 : lim(L.day - 1 - S.dp, 0, 14); }
function prov(L) {                        // aktuelles Defizit inkl. noch nicht verbuchter Tage
  return lim(lim(S.d - S.pi, 0, C.D_MAX_MM) + pending(L) * climEt(L.m) * C.KC, 0, C.D_MAX_MM);
}
function secsFor(mm) { return Math.min(C.MAX_RUN_MIN * 60, r0(mm / rate() * 3600)); }
function selfK(mx) { var o = mx ? S.oa : S.ob; return o > -50 ? o : (mx ? C.SELF_DAY_K : C.SELF_NIGHT_K); }
function estEt(day) {                     // ohne Internet: Monatsmittel, an heißen Tagen mehr (Gerätetemperatur) [2]
  var m = cfd(day).m, t = R.ty, f = 1;
  if (t && t.d === day && t.n >= 100) f = lim(1 + C.ET_K * (t.mx - selfK(1) - TMAX_CLIM[m - 1]), 0.5, 1.6);
  return climEt(m) * f * C.OFF_ET;
}
// Gegossenes zuerst abziehen, dann die Tage buchen: Die Gabe kommt morgens, die Verdunstung danach. Umgekehrt
// schnitte die 25-mm-Grenze die Verdunstung ab, und nach jeder Gabe am Deckel fehlte ein Tag.
// Für die Korrektur merkt es sich den Stand davor (xd), je Tag das vorher Gegossene (xw) und die Schätzung (xe).
// Mit echten Daten rechnet es die Tage dann neu durch: Ein Regentag setzt das Konto auf 0, die Tage danach zählen.
function xDrop() {                        // ältester geschätzter Tag fällt aus der Korrektur: Startwert nachziehen
  S.xd = lim(S.xd - S.xw[0], 0, C.D_MAX_MM) + S.xe[0];
  S.xe.shift(); S.xw.shift(); S.xa++;
}
function bookEst(L) {                     // ohne Internet: offene Tage geschätzt verbuchen, für die Korrektur merken
  var d, b, w0 = S.pi;
  if (S.xa < 0 && S.dp + 1 < L.day) { S.xd = S.d; S.xe = []; S.xw = []; }
  S.d = lim(S.d - S.pi, 0, C.D_MAX_MM); S.pi = 0;
  for (d = S.dp + 1; d < L.day; d++) {
    b = S.d;
    S.d = lim(S.d + r1(estEt(d) * C.KC), 0, C.D_MAX_MM);
    if (S.xa < 0) S.xa = d;
    S.xe.push(r1(S.d - b)); S.xw.push(r1(w0)); w0 = 0;   // xe: was nach der Grenze wirklich dazukam
    if (S.xe.length > 14) xDrop();
  }
  S.dp = L.day - 1;
}

// ============================== Gerätetemperatur ==============================
function temp(L, now) {                   // alle 10 min, nur wenn das Relais seit 30 min aus ist (Eigenwärme) [2]
  var st, c, v, t;
  if (now - R.ts < 600) return;
  R.ts = now; st = sw(); c = st.temperature;
  if (st.output || R.run || now - R.lastStop < 1800 || !c || typeof c.tC !== "number") return;
  v = c.tC; t = R.td;
  if (!t || t.d !== L.day) {
    R.ty = (t && t.d === L.day - 1) ? t : null;
    t = R.td = { d: L.day, n: 0, mn: v, mx: v };
  }
  t.n++;
  if (R.est) t.x = 1;                     // Uhr geschätzt: Tagesgrenze unsicher, nicht zum Lernen
  if (v < t.mn) t.mn = v;
  if (v > t.mx) t.mx = v;
  if (R.est) zSample(v, now); else R.z = null;
}
function learnSelf(L, tn, tx) {           // Eigenwärme lernen: gestern, ganzer Tag, Gerät gegen Wetterdienst [2]
  var t = R.ty;
  var dn, dx;
  if (!t || t.x || t.d !== L.day - 1 || t.n < 100 || tn === null || tx === null) return;
  dn = t.mn - tn; dx = t.mx - tx;         // Chip über Luft; im Ruhezustand heizt nur der Eigenverbrauch (~1 W)
  if (dn > -5 && dn < 50) S.ob = S.ob > -50 ? r1(S.ob + (dn - S.ob) * 0.3) : r1(dn);   // Unplausibles nicht lernen
  if (dx > -5 && dx < 50) S.oa = S.oa > -50 ? r1(S.oa + (dx - S.oa) * 0.3) : r1(dx);
}
function frostEst() {                     // ohne Internet: Tiefstwert der Nacht = Gerät minus Eigenwärme [2]
  var t = R.td, c = sw().temperature, v = null;
  if (t && t.n) v = t.mn;
  else if (c && typeof c.tC === "number") v = c.tC;
  if (v === null) return null;
  return v - selfK(0) - (t && t.n >= 36 ? 0 : 5);   // weniger als 6 h Messwerte (Neustart): 5 K Reserve
}
function airNow() {                       // ohne Internet: Luft jetzt = Gerät minus Eigenwärme, nur bei ruhendem Relais;
  var st = sw(), c = st.temperature;      // für den Frost vorsichtig: die größere Eigenwärme, ungelernt keine Angabe
  if (S.oa < -50 || st.output || R.run || upS() - R.lastStop < 1800 || !c || typeof c.tC !== "number") return null;
  return c.tC - Math.max(selfK(0), selfK(1));
}
// Tiefpunkt-Erkennung mit 3 K Schwelle. Gilt nur, wenn vorher mindestens 6 K über mindestens 6 h abgekühlt
// und danach binnen 3 h um 5 K erwärmt wurde: dann liegt er nahe am Sonnenaufgang (DWD Mannheim) [5]
function zSample(v, now) {
  var z = R.z;
  if (!z) { R.z = { s: -1, v: v, t: now, mv: v, mt: now, e: null }; return; }   // Abkühlung zählt ab dem ersten Wert
  if (z.e && now - z.e.t > 10800) z.e = null;
  if (z.e && v >= z.e.v + 5) { clockFix(z.e.t); z.e = null; }
  if (z.s < 0) {
    if (v < z.v) { z.v = v; z.t = now; }
    else if (v > z.v + 3) {
      if (z.mv - z.v >= 6 && z.t - z.mt >= 21600) z.e = { t: z.t, v: z.v };
      z.s = 1; z.v = v; z.t = now;
    }
  } else if (v > z.v) { z.v = v; z.t = now; }
  else if (v < z.v - 3) { z.mv = z.v; z.mt = z.t; z.s = -1; z.v = v; z.t = now; }
}
function clockFix(tUp) {                  // geschätzte Uhr auf Sonnenaufgang + 10 min am Tiefpunkt stellen [5]
  var u = R.eb + tUp - R.eu, d = Math.floor(u / 86400), i, e, t, lag = null;
  if (!R.est || upS() - R.zf < 72000) return;
  for (i = -1; i <= 1; i++) {
    e = (d + i) * 86400 + sunUtc(d + i) * 60 + 600 - u;
    if (R.def ? (e > -43200 && e <= 43200) : (e >= -10800 && e < 75600)) lag = e;
  }
  if (lag === null) return;
  e = lag - C.CLOCK_LATE_S;               // lieber zu spät als zu früh (ohne Anker ist auch das Datum geraten)
  // erstes Stellen ab 1,5 h Abweichung (Anker-Uhr nur vor); danach nur, wenn ein Morgen 1,5 h vom Ziel abweicht:
  // kein Nachrutschen durch Messrauschen, ein Ausreißer heilt am nächsten klaren Morgen
  if ((R.zn ? Math.abs(e) : (R.def ? Math.abs(lag) : lag)) < C.CLOCK_S) return;
  t = Math.floor(R.eb + e + upS() - R.eu);
  Shelly.call("Sys.SetTime", { unixtime: t }, cbSafe, onClockSet);   // wirft der Aufruf, bleibt alles beim Alten
  R.zf = upS(); R.zl = e; R.co = S.cs; R.cp = upS(); S.cs = t;
}
function onClockSet(res, err, msg) {      // Schätzung erst nachziehen, wenn die Geräteuhr wirklich gestellt ist
  R.cp = 0;
  if (err) { S.cs = R.co; log("Uhr nicht stellbar: " + msg); return; }
  R.eb += R.zl; R.zn = 1; R.cg++; save();
  log("Uhr nach Tagesgang um " + f1(R.zl / 3600) + " h gestellt");
}
// Zweiter Weg zur Uhrzeit neben dem Zeitserver: Jede https-Antwort (Wetterdienst, Ortssuche, IP-Ortung) trägt die
// Uhrzeit im Kopf (Date, auf die Sekunde). Ist die Uhr geschätzt oder ganz unbekannt und weicht mehr als 60 s ab,
// stellt das Skript die Geräteuhr; erst wenn das geklappt hat, gilt die Uhr als echt (clockReal).
// Rückgabe true: Uhr wird gestellt, eine Wetterantwort von davor nicht verwenden.
function httpClock(res) {
  var h = res && res.headers, s = null, k, p, m, c, t, u = nowU(), now = upS();
  if (!(R.est || !u) || !h) return false;
  if (R.hp && now - R.hp < 60) return true;                        // Stellen läuft noch
  if ((R.cp && now - R.cp < 60) || now < R.hc) return false;     // Tagesgang stellt gerade; nach Fehlschlag Pause
  for (k in h) if (String(k).toLowerCase() === "date") s = h[k];   // Schreibweise je nach Server
  if (typeof s !== "string") return false;
  p = s.split(" ");                       // "Sun, 18 Oct 2026 16:05:12 GMT"
  m = p.length > 4 ? "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(p[2]) : -1;
  c = p.length > 4 ? p[4].split(":") : [];
  if (m < 0 || m % 3 || c.length !== 3) return false;
  t = dfc(+p[3], m / 3 + 1, +p[1]) * 86400 + c[0] * 3600 + c[1] * 60 + +c[2];
  if (!(t > C.T_MIN)) return false;
  if (u && Math.abs(t - u) <= 60) { clockReal(u, u); log("Uhr von Internet-Antwort bestätigt"); return false; }
  Shelly.call("Sys.SetTime", { unixtime: t }, cbSafe, onHttpClock);   // wirft der Aufruf, bleibt alles beim Alten
  R.hp = now; R.ht = t - now; R.cg++;     // ein laufender Wetterabruf gilt nicht mehr
  return true;
}
function onHttpClock(res, err, msg) {
  var now = upS(), t = R.ht + now;
  R.hp = 0;
  if (err) { R.hc = now + 900; log("Uhr nicht stellbar: " + msg); return; }   // die Uhr bleibt, wie sie war
  if (R.est) { S.cs = Math.floor(t); clockReal(t, R.eb + now - R.eu); }      // schon von schedule() erkannt: fertig
  else if (!R.eb) { S.cs = Math.floor(t); R.defAt = 0; clockReal(t, t); }   // Uhr war noch ganz unbekannt
  log("Uhr aus Internet-Antwort gestellt");
}
function clockReal(t, old) {              // die Uhr gilt ab jetzt als echt (Zeitserver oder Wetterdienst)
  if (R.def && old) shiftDays(loc(t).day - loc(old).day);
  if (!(Math.abs(t - old) <= 60)) R.cg++; // Uhr wirklich gesprungen: laufender Wetterabruf gilt nicht
  R.eb = t; R.eu = upS(); R.est = false; R.def = false; S.ce = 0; R.td = null; R.ty = null; save();
}

// ============================== Relais und Läufe ==============================
function startsLastHour(now) {
  var a = [], i;
  for (i = 0; i < R.starts.length; i++) if (now - R.starts[i] < 3600) a.push(R.starts[i]);
  R.starts = a;
  return a.length;
}
function relayOff(why) {
  if (R.run && !R.run.why) R.run.why = why;
  Shelly.call("Switch.Set", { id: 0, on: false }, cbNone);
}
function onSetResult(res, err, msg) {
  var p = R.ps, u, t;
  if (!err) return;
  u = nowU(); t = ("Einschalten abgelehnt: " + msg).slice(0, 60);
  R.ps = null; log(t);
  if (p && p.k !== "hand") R.want = { k: p.k, mm: p.mm, exp: (u || 0) + 1800 };  // später nochmal, bis END_MIN
  if (S.ft !== t || !(u && S.fu > 1 && loc(S.fu).day === loc(u).day)) {   // wie eine Störung: Statuszeile, LED
    S.fu = u ? Math.floor(u) : 1; S.ft = t; save();                       // violett; je Tag einmal gespeichert
  }
}
// Startet eine eigene Gabe. Rückgabe null = gestartet, sonst Grund.
function startRun(kind, mm) {
  var now = upS(), st = sw();
  if (R.ps && now > R.ps.until) R.ps = null;          // Befehl kam nie an
  if (R.run || st.output || R.ps) return "läuft";
  if (R.weld) return "Relais";
  if (R.lastStop && now - R.lastStop < C.MIN_OFF_S) return "Pause";
  if (startsLastHour(now) >= C.MAX_STARTS_H) return "Starts";
  var sec = secsFor(mm);
  if (sec < 60) return "kurz";
  Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: sec }, cbSafe, onSetResult);   // wirft er, bleibt R.ps leer
  R.ps = { k: kind, mm: mm, sec: sec, until: now + 15 };
  log("Start " + kind + " " + r1(mm) + " mm, " + r0(sec / 60) + " min");
  return null;
}
function note(t) { R.note = t; R.noteU = upS(); log(t); }
function runBegin(st, gone) {            // gone: eigener Start, der nie als Lauf zu sehen war
  var now = upS(), p = R.ps, u = nowU(), kind, mm, sec, left = 0;
  R.ps = null;
  if (p && (gone || now <= p.until)) { kind = p.k; mm = p.mm; sec = p.sec; }
  else {                                  // Taster, App oder fremder Befehl = Handgabe
    kind = "hand";
    if (startsLastHour(now) >= C.MAX_STARTS_H) {
      note("Zu viele Starts in einer Stunde – Pumpe geschützt");
      R.starts.push(now);
      relayOff("starts");
      return;
    }
    if (R.boot && st.timer_duration) {    // Skript neu gestartet während eines Laufs: Firmware-Timer läuft, übernehmen
      left = (u && st.timer_started_at) ? st.timer_started_at + st.timer_duration - u : st.timer_duration;
      sec = r0(lim(left, 1, st.timer_duration));
      mm = sec * rate() / 3600;
    } else {
      mm = lim(u ? prov(loc(u)) : C.HAND_MIN_MM, C.HAND_MIN_MM, C.DOSE_MAX_MM);
      sec = secsFor(mm);
      Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: sec }, cbNone);
    }
    R.want = null;                        // Handgabe ersetzt einen aufgeschobenen Automatiklauf
    if (S.rt) { S.rt = 0; save(); }       // und einen geplanten Nachlauf
  }
  R.starts.push(now);
  R.run = { k: kind, t0: now, lt: now, u0: u || 0, sec: sec, mm: mm, ps: 0, cr: 0, ck: now, sp: 0, np: 0,
            pf: -1, u: 0, o: 0, n: 0, i: 0, why: "", det: "" };
  log("Pumpe an (" + kind + "), Ziel " + r1(mm) + " mm in " + r0(sec / 60) + " min");
}
function credit(r) {                      // geförderte Zeit -> mm aufs Bodenkonto
  var mm = r.ps * rate() / 3600, add = mm - r.cr;
  if (add > 0) { S.pi = S.pi + add; r.cr = mm; }
}
function trip(code, det) {
  R.run.why = code; R.run.det = det;
  log("Schutz: " + code + " (" + det + ")");
  relayOff(code);
}
function monitor(st) {
  var r = R.run, now = upS(), el = now - r.t0, dt = lim(now - r.lt, 0, 5);
  var P = st.apower || 0, I = st.current || 0;
  var lo = S.pn ? S.pn * C.UNDER_REL : C.P_ABS_DRY;
  var hi = S.pn ? S.pn * C.OVER_REL : C.P_ABS_OVER;
  r.lt = now;
  if (r.why) return;                      // Abschaltung läuft schon
  if (el > r.sec + 60) { relayOff("ende"); return; } // Firmware-Timer fehlte
  r.pf = r.pf < 0 ? P : r.pf + (P - r.pf) * 0.3;     // geglättet: Luft-Wasser-Gemisch flattert
  r.i = (el >= 2 && I > C.I_MAX) ? r.i + 1 : 0;
  if (r.i >= C.I_S) { trip("blockiert", f1(I) + " A"); return; }
  r.n = (el >= 3 && P < C.NOLOAD_W) ? r.n + 1 : 0;
  if (r.n >= C.NOLOAD_S) { trip("keinStrom", r0(P) + " W"); return; }
  r.o = (el >= C.BLANK_S && r.pf > hi) ? r.o + 1 : 0;
  if (r.o >= C.OVER_S) { trip("ueberlast", r0(r.pf) + " W > " + r0(hi) + " W"); return; }
  r.u = (el >= C.BLANK_S && P >= C.NOLOAD_W && r.pf < lo) ? r.u + 1 : 0;
  if (r.u >= C.UNDER_S) { trip("unterlast", r0(r.pf) + " W < " + r0(lo) + " W"); return; }
  if (r.pf >= lo) r.ps += dt;
  if (el >= 60 && el < 300) { r.sp += P; r.np++; }
  if (now - r.ck >= C.RUN_SAVE_S) { credit(r); save(); r.ck = now; }
}
function learn(P) {
  if (!S.pn) {
    if (P >= C.P_LEARN_MIN && P <= C.P_LEARN_MAX) {
      S.pn = r0(P); S.ln = 1; note("Normalleistung eingelernt: " + S.pn + " W");
    } else {
      note("Leistung " + r0(P) + " W unplausibel – nicht eingelernt (Hahn zu?)");
    }
  } else if (Math.abs(P / S.pn - 1) <= C.LEARN_GATE) {
    S.pn = r0(S.pn * 0.8 + P * 0.2); S.ln++;
  }
}
var WHY = { unterlast: "Trockenlauf oder Hahn zu", ueberlast: "Überlast", blockiert: "Pumpe blockiert",
            keinStrom: "Pumpe zieht keinen Strom", start: "Pumpe lief nicht an" };   // Störungen; "ende", "aus" sind keine
function runEnd(st) {
  var r = R.run, now = upS(), u = nowU(), why = r.why, fw = st.errors && st.errors.length;
  R.run = null; R.lastStop = now;
  credit(r);
  if ((!why || why === "start") && fw) why = "fw";
  var fault = why === "fw" || !!WHY[why];
  if (!fault && r.np >= 30) learn(r.sp / r.np);
  var txt = fault ? (why === "fw" ? "Firmware-Schutz: " + st.errors.join(",") : WHY[why] + (r.det ? " (" + r.det + ")" : "")) : "";
  if (fault) { S.fu = u ? Math.floor(u) : 1; S.ft = txt.slice(0, 60); }   // LED violett, bis ein Lauf fehlerfrei war
  else if (r.ps >= 60) { S.fu = 0; S.ft = ""; }                          // eine Minute normal gepumpt: erledigt
  if (u) {
    var L = loc(u), L0 = loc(r.u0 || u);
    S.lr = dmy(L0.day) + " " + hm(L0.min) + " " + (r.k === "hand" ? "Hand" : (r.k === "retry" ? "Nachlauf" : "Automatik")) +
      " " + f1(r.cr) + " mm" + (fault ? " – abgebrochen" : "");
    if (fault) {
      if (S.fd !== L.day) { S.fd = L.day; S.fc = 0; }
      S.fc++;
      var rem = r.mm - r.cr, maxR = why === "unterlast" ? C.RETRIES_DRY : 1;
      S.rt = 0;
      if ((r.k === "auto" || r.k === "retry") && rem >= 2 && S.fc <= maxR) {
        S.rt = Math.floor(u) + (now - r.t0 < 10 ? C.RETRY_START_MIN : C.RETRY_MIN) * 60; S.rm = r1(rem);
      }
    }
  }
  log("Pumpe aus: " + (why || "Ende/Stopp") + ", " + r1(r.cr) + " mm gegeben");
  save();
}
function weldCheck(st) {
  var now = upS(), P = st.apower || 0;
  if (R.lastStop && now - R.lastStop < 5) return;   // Messwert hinkt nach
  if (P > C.NOLOAD_W) {
    R.wc++;
    if (R.wc >= 5) {
      if (!R.weld) log("Relais klebt? " + r0(P) + " W bei AUS");
      R.weld = true;
      if (R.wc % 30 === 5) Shelly.call("Switch.Set", { id: 0, on: false }, cbNone);
    }
  } else { R.wc = 0; R.weld = false; }
}

// ============================== Wetter und Tagesentscheidung ==============================
function wxUrl(n) {
  return "https://api.open-meteo.com/v1/forecast?latitude=" + R.la + "&longitude=" + R.lo +
    "&daily=et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,temperature_2m_min," +
    "temperature_2m_max&current=temperature_2m&timezone=auto&forecast_days=1&past_days=" + n;
}
function fetchWx(L, n, rc) {              // rc = Regen-Nachprüfung (nur heute, nichts verbuchen)
  R.wx.busy = true; R.wx.L = L; R.wx.n = n; R.wx.rc = rc; R.wx.t = upS(); R.wx.q++; R.wx.cg = R.cg;
  Shelly.call("HTTP.GET", { url: wxUrl(n), timeout: 20 }, onWx, R.wx.q);   // Nummer: späte Antworten erkennen
}
function evaluate(L) {
  if (!inSeason(L)) {                     // Winterpause: Konto ruht und startet im März bei 0
    S.ev = L.day; S.d = 0; S.pi = 0; S.dp = L.day - 1; S.rt = 0; S.xa = -1; S.xe = []; S.xw = [];
    R.why = "Winterpause"; save(); return;
  }
  if (S.dp < 0 || L.day - 1 - S.dp > 14) {  // erster Tag oder über 14 Tage aus (etwa über Winter): Konto neu,
    S.d = 0; S.pi = 0;                        // die letzten 14 Tage werden gebucht
    S.dp = L.day - 1 - (S.dp < 0 ? 0 : 14);
  }
  while (S.xe.length && L.day - S.xa > 14) xDrop();                 // ältere Schätzungen bleiben stehen
  if (!S.xe.length) S.xa = -1;
  if (R.la === null) { R.off = true; bookEst(L); decide(L, null, false); return; }   // Ort noch unbekannt
  fetchWx(L, L.day - (S.xa >= 0 ? S.xa : S.dp + 1), false);           // offene und geschätzte Tage holen
}
function num(a, i) { return (a && typeof a[i] === "number") ? a[i] : null; }
function today(j, n, c) {                 // c = aktuelle Werte (Lufttemperatur jetzt)
  return { rain: num(j.precipitation_sum, n) || 0, prob: num(j.precipitation_probability_max, n) || 0,
           tmin: num(j.temperature_2m_min, n), tnow: c && typeof c.temperature_2m === "number" ? c.temperature_2m : null };
}
// Fehler beim Verarbeiten der Wetterantwort (wie cbSafe, mit eigener Folge): Halbverbuchtes wird verworfen (Stand
// vor dieser Antwort), dann gilt die Antwort als ausgeblieben, also später nochmal, zuletzt ohne Internet. Geht auch
// das schief, ist für heute Schluss.
function onWx(res, err, msg, q) {
  var L = R.wx.L, rc = R.wx.rc, s0 = JSON.stringify(S);
  try { wxIn(res, err, msg, q); }
  catch (e) {
    log("Fehler Wetterantwort: " + e); S = JSON.parse(s0);
    R.wx.busy = true; R.wx.rc = rc;
    try { wxIn(null, -1, "Fehler", q); }
    catch (e2) {
      log("Fehler Tagesprüfung: " + e2); S = JSON.parse(s0); R.wx.busy = false; R.wx.rc = false;
      if (L && !rc) { S.ev = L.day; R.why = "Fehler, nächste Prüfung morgen"; save(); }
    }
  }
}
function wxIn(res, err, msg, q) {
  var L = R.wx.L, n = R.wx.n, ok = false, o = null, j = null, i, day, et, rn, v, uw;
  if (q !== R.wx.q || !R.wx.busy) return;  // Antwort eines schon aufgegebenen Abrufs
  R.wx.busy = false;
  if (!err && res && res.code === 200) {
    try { if (httpClock(res)) R.cg++; } catch (e) { log("Fehler Uhr: " + e); }
  }
  if (R.wx.cg !== R.cg) {                 // Uhr seit dem Abruf gestellt: L stimmt nicht mehr, gleich neu mit richtiger Uhr;
    if (R.wx.rc) { R.wx.rc = false; R.rh = 0; }   // verbucht ist noch nichts, das Stellen hat die Tage schon verschoben
    return;
  }
  try {
    if (!err && res && res.code === 200) {
      o = JSON.parse(res.body); j = o.daily;
      ok = j && j.time && j.time.length === n + 1 && j.time[n] === ymd(L);
    }
  } catch (e) { ok = false; }
  if (R.wx.rc) {                          // Nachprüfung ohne Antwort: nach Regen bleibt es bei der Entscheidung,
    R.wx.rc = false;                      // nach Frost misst der Gerätefühler die Luft
    if (ok) decide(L, today(j, n, o.current), true);
    else if (S.rc === L.day && (S.rk === 1 || S.rk === 3)) decide(L, null, true);
    return;
  }
  if (!ok) {
    R.wx.tries++;
    uw = nowU();                          // Ausfälle des Dienstes dauern oft bis 1 h: 4 Versuche im Abstand von 20 min
    if (R.wx.tries < ((R.est || R.off) ? 1 : 4) && uw && loc(uw).min + 21 < C.END_MIN) {
      R.wx.next = upS() + 1200; return;
    }
    R.off = true;
    bookEst(L);
    decide(L, null, false);
    return;
  }
  for (i = 0; i < n; i++) {               // offene Tage verbuchen, geschätzte mit echten Daten neu rechnen
    day = L.day - n + i;
    et = num(j.et0_fao_evapotranspiration, i);
    rn = num(j.precipitation_sum, i);
    if (et === null) et = climEt(cfd(day).m);
    if (rn === null) rn = 0;
    v = et * C.KC - Math.max(0, rn - C.RAIN_LOSS_MM);
    if (day > S.dp) {                     // offener Tag; davor das seither Gegossene (wie bookEst)
      S.d = lim(lim(S.d - S.pi, 0, C.D_MAX_MM) + v, 0, C.D_MAX_MM); S.pi = 0;
    } else if (S.xa >= 0 && day >= S.xa) {  // geschätzter Tag: ab dem Stand davor neu, mit dem damals Gegossenen
      if (day === S.xa) S.d = S.xd;
      S.d = lim(lim(S.d - (S.xw[day - S.xa] || 0), 0, C.D_MAX_MM) + v, 0, C.D_MAX_MM);
    }
  }
  S.xa = -1; S.xe = []; S.xw = [];
  S.d = lim(S.d - S.pi, 0, C.D_MAX_MM); S.pi = 0; S.dp = L.day - 1;
  R.nf = false;
  if (n >= 1) {                           // gestern: kam der angekündigte Regen? Eigenwärme lernen
    rn = num(j.precipitation_sum, n - 1);
    R.nf = S.rd === L.day - 1 && rn !== null && rn - C.RAIN_LOSS_MM < S.rx / 2;
    learnSelf(L, num(j.temperature_2m_min, n - 1), num(j.temperature_2m_max, n - 1));
  }
  R.off = false; R.pf = false;            // eine geschätzte Uhr stellt httpClock oder der Zeitserver
  decide(L, today(j, n, o.current), false);
}
// Frost sperrt nicht den ganzen Tag: Nach einer Frostnacht gießt die Automatik, sobald die Luft FROST_THAW_C hat
// (Nachprüfung stündlich bis END_MIN). Eine noch gefrorene Leitung wirkt wie ein zugedrehter Hahn: Unterlast [4].
// Bei der Nachprüfung bleibt die Frostnacht von 10:00 stehen, neu sind nur die Luft und die Regenprognose.
function decide(L, w, rc) {               // w = Prognose heute oder null (ohne Internet); rc = Nachprüfung
  var D = prov(L), rainExp = 0, dose = 0, t = nowU(), nm = t ? loc(t).min : L.min, res, fr = null, est = false, air,
      k = rc && S.rc === L.day ? S.rk : 0;  // Grund der Nachprüfung: 1 Frost (Prognose), 3 Frost (geschätzt), 2 Regen
  R.wx.tries = 0;
  if (R.run) { save(); return; }          // Handgabe läuft: geprüft wird danach, der Tag bleibt offen
  S.ev = L.day; S.rc = -1; S.rk = 0;
  if (k === 1 || k === 3) { fr = S.rf; est = k === 3; }
  else if (w && w.tmin !== null) fr = w.tmin < C.FROST_C ? w.tmin : null;   // Frostnacht laut Prognose
  else if ((fr = frostEst()) !== null) {  // sonst Gerätefühler, auch wenn der Wert fehlt
    if (fr >= C.FROST_OFF_C) fr = null; else est = true;
  }
  air = (w && w.tnow !== null) ? w.tnow : airNow();                       // Luft jetzt
  if (!autoOn()) R.why = "Automatik aus";
  else if (paused(L)) R.why = "Pause bis " + dmy(S.pu);
  else if (D < C.TRIGGER_MM) R.why = "nicht nötig (" + f1(D) + " mm)";
  else if (fr !== null && !(air >= C.FROST_THAW_C)) {
    R.why = "Frostsperre (" + (est ? "geschätzt " : "") + f1(fr) + " °C), gießt ab " + C.FROST_THAW_C + " °C";
    S.rc = L.day; S.rk = est ? 3 : 1; S.rf = r1(fr); R.rh = (Math.floor(nm / 60) + 1) * 60 + 5;
  }
  else {
    if (w && w.prob >= C.RAIN_PROB_MIN && !R.nf) rainExp = Math.max(0, w.rain - C.RAIN_LOSS_MM);
    dose = Math.min(C.DOSE_MAX_MM, D - rainExp);
    if (rainExp > 0 && dose < Math.min(C.DOSE_MAX_MM, D)) { S.rd = L.day; S.rx = r1(rainExp); }   // Prognose kürzt
    else if (S.rd === L.day) S.rd = -1;   // volle Gabe, etwa nach Absage bei der Nachprüfung
    if (dose < C.DOSE_MIN_MM && rainExp > 0) {
      R.why = "Regen erwartet (" + f1(w.rain) + " mm, " + w.prob + " %)" + (k === 2 ? ", " + hm(nm) + " bestätigt" : "");
      S.rc = L.day; S.rk = 2; R.rh = (Math.floor(nm / 60) + 1) * 60 + 5;   // stündlich nachsehen, 5 min nach der vollen Stunde
    } else if (dose < C.DOSE_MIN_MM) R.why = "nicht nötig (" + f1(D) + " mm)";   // nur wenn TRIGGER_MM < DOSE_MIN_MM
    else if (nm >= C.END_MIN) { R.why = hm(C.END_MIN) + " vorbei, nicht mehr gestartet"; dose = 0; }
    else R.why = (k === 2 ? "Regen abgesagt, " : (k ? "Frost vorbei, " : "")) + "gegossen " + f1(secsFor(dose) * rate() / 3600) + " mm" +
      (R.nf ? " (gestern Regen ausgeblieben)" : "");   // Menge nach der Laufzeitgrenze (MAX_RUN_MIN)
  }
  log("Tagesprüfung: Defizit " + r1(D) + " mm" + (w ? "" : " (ohne Internet)") + " -> " + R.why);
  if (dose >= C.DOSE_MIN_MM) {
    res = startRun("auto", dose);
    if (res) R.want = { k: "auto", mm: dose, exp: nowU() + 7200 };
  }
  save();
}
// Fürs Aufspielwerkzeug (Script.Eval): der erste Aufruf holt die größte Wetterantwort (15 Tage) und liest sie,
// jeder weitere meldet das Ergebnis. Der Name bleibt in der Gerätefassung erhalten (tools/build.js).
function selfTest() {
  if (R.la === null) return "FEHLER Ort unbekannt: " + C.ORT;
  if (!R.st) { R.st = "läuft"; Shelly.call("HTTP.GET", { url: wxUrl(14), timeout: 20 }, cbSafe, onSelfTest); }
  return R.st === "ok" ? "ok, Ort " + R.la + " " + R.lo : R.st;
}
function onSelfTest(res, err, msg) {
  var ok = false;
  try { ok = !err && res.code === 200 && JSON.parse(res.body).daily.time.length === 15; } catch (e) { ok = false; }
  R.st = ok ? "ok" : "FEHLER " + (msg || "Antwort");
  log("Selbsttest Wetter: " + R.st);
}

// ============================== Takt ==============================
function defTime() {                      // ohne Anker und ohne Zeitserver: Einstecken gilt als 15. April, START_MIN [5]
  var s = Shelly.getComponentStatus("sys"), t = dfc(2026, 4, 15) * 86400 + C.START_MIN * 60 - (C.UTC_H + 1) * 3600;
  R.defAt = 0;
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN) return;
  R.def = true; R.est = true; R.eb = t; R.eu = upS(); S.df = 1; S.ce = 1; S.cs = t;
  Shelly.call("Sys.SetTime", { unixtime: t }, cbNone);
  log("Uhrzeit unbekannt – Einstecken gilt als 15. April " + hm(C.START_MIN));
  save();
}
function auto() { return C.ORT === "auto"; }
function geo() {                          // Ort -> Koordinaten, einmal, dann gespeichert: "auto" und ein nicht
  if (auto() || S.lf) ipCheck(); else geoName();   // gefundener Name über die IP-Ortung, sonst über den Namen
  R.gn = upS() + 900;
}
function geoName() {                      // Ortssuche von Open-Meteo; Postleitzahlen kennt sie nicht, Ortsnamen schon
  Shelly.call("HTTP.GET", { url: "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + uenc(C.ORT) +
    "&countryCode=" + C.LAND, timeout: 20 }, cbSafe, onGeo);
}
function uenc(t) {                        // für die URL: UTF-8 mit Prozentzeichen (Umlaute, ß, Leerzeichen; bis U+07FF)
  var o = "", i, c, d, b = [];            // auf dem Gerät sind Umlaute schon UTF-8-Bytes (tools/build.js)
  for (i = 0; i < t.length; i++) {
    c = t.charCodeAt(i); d = t.charCodeAt(i + 1);
    if ((c > 47 && c < 58) || (c > 64 && c < 91) || (c > 96 && c < 123)) { o += t.charAt(i); continue; }
    if (c < 128) b = [c];
    else if (c > 193 && c < 224 && d > 127 && d < 192) { b = [c, d]; i++; }   // schon UTF-8-Bytes
    else b = [192 | (c >> 6), 128 | (c & 63)];                              // Zeichen -> UTF-8
    for (c = 0; c < b.length; c++) o += "%" + ("0" + b[c].toString(16)).slice(-2).toUpperCase();
  }
  return o;
}
function onGeo(res, err, msg) {
  var j = null, g;
  if (!err && res && res.code === 200) {
    httpClock(res);
    try { j = JSON.parse(res.body); } catch (e) { j = null; }
  }
  if (!j) return;                         // Dienst nicht erreichbar: in 15 min nochmal
  g = j.results && j.results[0];
  if (!g) {                               // Name unbekannt: Ort per IP, der Name wird täglich nochmal gesucht
    if (!S.lf) { S.lf = 1; save(); log("Ort " + C.ORT + " nicht gefunden – nehme die IP-Ortung"); }
    R.gn = 0; return;
  }
  if (typeof g.latitude !== "number" || typeof g.longitude !== "number") return;
  S.lf = 0; setLoc(g.latitude, g.longitude, "");
  R.ia = 0;                               // gleich gegen die IP-Ortung prüfen
  log("Ort " + C.ORT + ": " + R.la + ", " + R.lo);
}
function setLoc(la, lo, c) {
  R.la = S.la = r2(la); R.lo = S.lo = r2(lo); S.pz = C.LAND + C.ORT; S.lc = c; R.off = false; save();
}
function ipCheck() {                      // IP-Ortung: Ort für "auto" und Rückfall, sonst Gegenprobe; auch Uhrzeit
  Shelly.call("HTTP.GET", { url: IP_URL, timeout: 15 }, cbSafe, onIp);
  R.ia = upS() + 86400;                   // einmal am Tag, nach einem Fehlschlag in 1 h (onIp)
}
function onIp(res, err, msg) {
  var j = null, la, lo, a, c, d;
  if (!err && res && res.code === 200) {
    httpClock(res);
    try { j = JSON.parse(res.body); } catch (e) { j = null; }
  }
  la = j ? +j.latitude : NaN; lo = j ? +j.longitude : NaN;   // GeoJS liefert Text
  if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180) || (!la && !lo)) { R.ia = upS() + 3600; return; }
  a = +j.accuracy > 0 ? r0(+j.accuracy) : 999;                 // Ungenauigkeit (km)
  c = typeof j.city === "string" ? asc(j.city) : "";
  if ((auto() || S.lf) && (R.la === null || (S.lq > C.LOC_KM && a < S.lq))) {   // Ort per IP; ein ungenauer weicht
    S.lq = a; setLoc(la, lo, c); log("Ort per IP: " + c + " " + R.la + ", " + R.lo + " (±" + a + " km)");   // einem genaueren
  }
  if (R.la === null) return;
  if (auto() || S.lf) R.lw = S.lq > C.LOC_KM ? "Ort per IP ungenau (±" + S.lq + " km) – ORT eintragen" : "";
  else {
    d = km(R.la, R.lo, la, lo);
    R.lw = d > Math.max(C.LOC_KM, 2 * a) ? "Ort prüfen: " + C.ORT + " liegt " + r0(d) + " km von der IP-Ortung (" + c + ")" : "";
  }
  if (R.lw) log(R.lw);
}
function asc(t) {                         // Stadtname der IP-Ortung nur in ASCII: Umlaute umschreiben, ob sie als
  var o = "", i, k, m = { 196: "Ae", 214: "Oe", 220: "Ue", 223: "ss", 228: "ae", 246: "oe", 252: "ue" };   // Zeichen
  for (i = 0; i < t.length && o.length < 30; i++) {                    // oder als UTF-8-Bytes ankommen; Rest weglassen
    k = t.charCodeAt(i);
    if (k === 195 && i + 1 < t.length) { i++; k = t.charCodeAt(i) + 64; }   // UTF-8 C3 xx
    if (k > 31 && k < 127) o += String.fromCharCode(k);
    else if (m[k]) o += m[k];
  }
  return o;
}
function km(a, b, c, d) {                 // Abstand zweier Orte (km); die Näherung genügt für den Vergleich
  var x = (d - b) * Math.cos((a + c) * Math.PI / 360) * 111.3, y = (c - a) * 111.3;
  return Math.sqrt(x * x + y * y);
}
function shiftDays(k) {                   // die Annahme 15. April war falsch: Tagesmarken mitverschieben [5]
  if (S.ev >= 0) S.ev += k;
  if (S.dp >= 0) S.dp += k;
  if (S.fd >= 0) S.fd += k;
  if (S.pu) S.pu += k;
  if (S.xa >= 0) S.xa += k;
  if (S.rd >= 0) S.rd += k;
  if (S.rc >= 0) S.rc += k;
  if (S.fu > 1) S.fu += k * 86400;
  S.rt = 0; S.df = 0; R.td = null; R.ty = null; R.z = null;
  log("Echte Uhrzeit da: Tagesmarken um " + k + " Tage verschoben");
}
function schedule() {
  flush();                                // von der Schreibbremse gehaltenen Stand schreiben, sobald erlaubt
  if (R.defAt && upS() >= R.defAt) defTime();
  if (upS() >= R.cfgAt) { R.cfgAt = upS() + 3600; applyCfg(); watchdog(); }   // stündlich: Notabschaltung, Zeitpläne
  if (!R.h && upS() - R.hb >= (R.hn < 10 ? 60 : 3600)) vcStart();          // Bedienfeld fehlt: nochmal versuchen
  if (R.la === null && upS() >= R.gn) geo();                    // Ort noch unbekannt: alle 15 min fragen
  else if (upS() >= R.ia) { ipCheck(); if (S.lf) geoName(); }  // täglich: Ortsprüfung (bringt auch die Uhrzeit, schon
                                                                // ohne Ort) und den nicht gefundenen Namen nochmal suchen
  var u = nowU();
  if (!u) return;
  var L = loc(u), now = upS();
  if (R.wx.busy && now - R.wx.t > 60) onWx(null, -1, "keine Antwort", R.wx.q);   // Rückruf kam nie: wie ein Fehlschlag
  if (R.est && !(R.cp && now - R.cp < 60) && (Math.abs(u - (R.eb + now - R.eu)) > 5 || ntpSet())) {   // Zeitserver
    clockReal(u, R.eb + now - R.eu);
  }
  if (S.ev > L.day || S.dp > L.day - 1 || S.pu > L.day + 14) {  // Uhr zurückgesprungen: Tagesmarken begrenzen
    if (S.ev > L.day) S.ev = -1;
    if (S.dp > L.day - 1) S.dp = L.day - 1;
    if (S.pu > L.day + 14) S.pu = 0;
    S.rt = 0; save();
  }
  if (u - S.t >= C.ANCHOR_S) save();                       // Zeitanker
  temp(L, now);
  if ((R.est || R.off || R.pf || !R.pk) && R.la !== null && !R.wx.busy && now >= R.pbNext) {   // Wetterdienst da?
    Shelly.call("HTTP.GET", { url: "https://api.open-meteo.com/v1/forecast?latitude=" + R.la + "&longitude=" + R.lo +
      "&daily=temperature_2m_min&timezone=auto&forecast_days=1", timeout: 10 }, cbSafe, onProbe);
    R.pbNext = now + 900;                 // nach dem Start einmal, dann alle 15 min, solange etwas fehlt
  }
  if (S.pu && L.day > S.pu) { S.pu = 0; save(); }
  if (R.run && R.run.k !== "hand" && (!autoOn() || paused(L))) relayOff("aus");   // Automatik aus: Lauf beenden
  if (S.ev !== L.day && L.min >= C.START_MIN && L.min < C.END_MIN && !R.wx.busy && now >= R.wx.next && !R.run && !R.ps) {
    evaluate(L);
  }
  if (S.rc === L.day && L.min >= R.rh && L.min < C.END_MIN && !R.wx.busy && !R.run && !R.ps) {
    R.rh = (Math.floor(L.min / 60) + 1) * 60 + 5;        // klappt der Abruf nicht: nächste Stunde
    if (R.off) decide(L, null, true); else fetchWx(L, 0, true);   // ohne Internet: Frost nach Gerätefühler
  }
  if (R.want) {
    if (u > R.want.exp || !autoOn() || L.min >= C.END_MIN) R.want = null;
    else if (!startRun(R.want.k, R.want.mm)) R.want = null;
  }
  if (S.rt && u >= S.rt && !R.run) {
    if (L.min >= C.END_MIN || !autoOn() || paused(L) || S.fd !== L.day) { S.rt = 0; save(); }
    else if (!startRun("retry", S.rm)) { S.rt = 0; save(); }
  }
}
function onProbe(res, err, msg) {
  R.pk = true;
  if (!err && res && res.code === 200) { R.off = false; R.pf = false; httpClock(res); }
  else {                                  // LED gelb, bis der Wetterdienst wieder antwortet; gleich nach dem
    R.pf = true;                          // Hochfahren steht das WLAN vielleicht noch nicht: nach 1 min nochmal
    if (upS() < 600) R.pbNext = upS() + 60;
  }
}
function statusText(L) {
  var r = R.run, t, f = S.fu > 1 ? loc(S.fu) : null;
  if (R.weld) return "ALARM: Pumpe zieht Strom trotz AUS – Relais klebt? Stecker ziehen!";
  if (r) {
    t = r.sec - (upS() - r.t0);
    return "Beregnung (" + (r.k === "hand" ? "Hand" : (r.k === "retry" ? "Nachlauf" : "Automatik")) + "): " +
      f1(r.mm) + " mm, noch " + Math.max(0, r0(t / 60)) + " min, " + r0(sw().apower || 0) + " W";
  }
  if (!L) return "Uhrzeit unbekannt – Automatik wartet auf Internet. Taster geht.";
  if (S.fu && (!f || f.day === L.day)) {    // Störung heute; ältere stehen hinten, bis ein Lauf fehlerfrei war
    t = "Störung" + (f ? " " + hm(f.min) : "") + ": " + S.ft;
    t += S.rt ? ". Nachlauf " + hm(loc(S.rt).min) : (R.want ? ". Neuer Versuch bis " + hm(C.END_MIN) :
      ". Nächster Versuch morgen " + hm(C.START_MIN));
  } else if (!inSeason(L)) t = "Winterpause bis 01." + p2(C.SEASON_FROM) + ". – Taster geht";
  else if (!autoOn()) t = "Automatik aus – Taster geht";
  else if (paused(L)) t = "Pause bis " + dmy(S.pu);
  else if (S.ev === L.day) t = "Heute: " + (R.why || "geprüft");
  else if (L.min < C.START_MIN) t = "Bereit, Prüfung " + hm(C.START_MIN);
  else t = L.min < C.END_MIN ? "Prüfung läuft" : "Heute nicht geprüft, nächste Prüfung morgen " + hm(C.START_MIN);
  if (f && f.day !== L.day) t += " · Störung " + dmy(f.day) + " " + hm(f.min) + ": " + S.ft;
  if (R.def) t += " · Uhr angenommen: Einstecken = " + hm(C.START_MIN);   // Hinweise vor den Infos: gekürzt wird hinten
  else if (R.est) t += " · Uhr geschätzt";
  if (R.la === null) t += " · Ort " + (S.lf ? C.ORT + " nicht gefunden" : "unbekannt");
  else if (S.lf) t += " · Ort " + C.ORT + " nicht gefunden, Ort per IP: " + S.lc;
  if (R.lw) t += " · " + R.lw;
  if ((R.off || R.pf) && R.la !== null) t += " · ohne Internet";   // ohne Ort gibt es kein Wetter, egal ob Internet
  if (R.noStore) t += " · Speicher fehlt (Firmware alt)";
  if (S.lr) t += " · Zuletzt " + S.lr;
  if (R.note && upS() - R.noteU > 43200) R.note = "";
  if (R.note) t += " · " + R.note;
  else if (S.pn) t += " · Pumpe normal " + S.pn + " W";
  while (t.length > 230 && t.lastIndexOf(" · ") > 0) t = t.slice(0, t.lastIndexOf(" · "));   // Textfeld: 255 Byte
  return t.length > 230 ? t.slice(0, 230) : t;
}
function ui() {
  var u = nowU(), L = u ? loc(u) : null, k;
  ledUpdate(L);                           // die LED auch ohne Bedienfeld
  if (!R.h) return;
  try {
    for (k in R.h) if (k !== "re" && R.hl < 3 && typeof R.h[k].getStatus === "function" &&
        R.h[k].getStatus() === undefined) throw "fehlt " + k;   // in der App gelöscht (Shelly-Doku: undefined)
    uiSet(L);
  } catch (e) {                           // Bedienfeld verloren: neu anlegen und binden (schedule), höchstens 3-mal
    log("Bedienfeld neu: " + e); R.hl++;
    try { R.h.re.off(R.hr); } catch (e2) { /* Taster schon weg */ }
    R.h = null; R.hn = 0; R.hb = 0; R.paShown = -1; R.lastTxt = ""; R.lastD = -1;
  }
}
function uiSet(L) {
  var t, d, pv = R.h.pa.getValue();
  if (L && typeof pv === "number" && R.paShown >= 0 && pv !== R.paShown) {  // Pause im Bedienfeld geändert
    S.pu = pv > 0 ? L.day + r0(pv) - 1 : 0; S.rt = 0; R.want = null; save();
    log("Pause " + (pv > 0 ? "bis " + dmy(S.pu) : "aufgehoben"));
  }
  d = L && paused(L) ? S.pu - L.day + 1 : 0;
  if (d !== R.paShown) { R.h.pa.setValue(d); R.paShown = d; }
  t = statusText(L);
  if (t !== R.lastTxt) { R.h.st.setValue(t); R.lastTxt = t; }
  d = L ? r1(prov(L)) : 0;
  if (d !== R.lastD) { R.h.bk.setValue(d); R.lastD = d; }
}
function same(a, b) { return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }
function ledInit() {                       // aktuellen LED-Zustand lesen, damit ein Neustart nichts schreibt
  var c = Shelly.getComponentConfig("plugs_ui"), o, k;
  R.led = "?";
  if (!c || !c.leds || c.leds.mode !== "switch" || !c.leds.colors || !c.leds.colors["switch:0"]) return;
  o = c.leds.colors["switch:0"].off;
  for (k in LED) if (k !== "run" && o && same(o.rgb, LED[k]) && o.brightness === 100) R.led = k;   // alte Helligkeit: neu setzen
}
function ledUpdate(L) {
  var want = "ok", now = upS(), a = [], i;
  if (R.weld || S.fu) want = "err";
  else if (!L || R.off || R.pf || R.est || R.la === null || S.lf || R.lw || R.noStore) want = "warn";
  if (want !== R.ledWant) { R.ledWant = want; R.ledSince = now; }
  if (want === R.led || now - R.ledSince < 120) return;
  for (i = 0; i < R.ledN.length; i++) if (now - R.ledN[i] < 86400) a.push(R.ledN[i]);
  R.ledN = a;
  if (a.length >= 12) return;
  Shelly.call("PLUGS_UI.SetConfig", { config: { leds: { mode: "switch", colors: { "switch:0": {
    on: { rgb: LED.run, brightness: 100 }, off: { rgb: LED[want], brightness: 100 } } } } } }, cbSafe, onLed);
  R.led = want; R.ledN.push(now);         // erst nach dem Aufruf: wirft er, kommt der nächste Versuch
}
function onLed(res, err, msg) {           // nicht geklappt: in 1 h nochmal (höchstens 12 Versuche am Tag)
  if (err) { log("LED nicht gesetzt: " + msg); R.led = "?"; R.ledSince = upS() + 3480; }
}
function tick() {
  var st;
  R.k++;
  try {
    st = sw();
    if (st.output && !R.run) runBegin(st);
    else if (!st.output && R.run) runEnd(st);
    else if (st.output && R.run) monitor(st);
    else if (R.ps && upS() > R.ps.until) {   // eigener Start nie zu sehen: Firmware schaltete binnen 1 s ab (Anlaufstrom?)
      runBegin(st, 1); R.run.why = "start"; runEnd(st);   // oder Befehl verloren: als Störung werten, sonst bliebe R.ps stehen
    }
    if (!st.output) weldCheck(st);
    R.boot = false;
  } catch (e) { log("Fehler Takt: " + e); }
  if (R.k % 30 === 1) { try { schedule(); } catch (e2) { log("Fehler Plan: " + e2); } }
  if (R.k % 10 === 2) { try { ui(); } catch (e3) { log("Fehler Anzeige: " + e3); } }
}

// ============================== Start ==============================
function applyCfg() {                     // Firmware-Sicherungen, nur schreiben wenn abweichend
  var c = Shelly.getComponentConfig("switch", 0) || {}, want = {}, need = false;
  if (c.initial_state !== "off") { want.initial_state = "off"; need = true; }
  if (c.auto_off !== true) { want.auto_off = true; need = true; }
  if (c.auto_off_delay !== C.AUTO_OFF_S) { want.auto_off_delay = C.AUTO_OFF_S; need = true; }
  if (c.auto_on === true) { want.auto_on = false; need = true; }   // schaltete nach jedem Aus wieder ein
  if (c.autorecover_voltage_errors === true) { want.autorecover_voltage_errors = false; need = true; }   // ebenso nach Spannungsfehler
  if (c.name !== "Brunnenpumpe") { want.name = "Brunnenpumpe"; need = true; }
  if (need) Shelly.call("Switch.SetConfig", { id: 0, config: want }, cbNone);   // Sicherung: nie gebremst
}
var WD_SPEC = "0 */5 * * * *";            // Wächter: alle 5 min Script.Start (läuft es schon, passiert nichts)
var UP_SPEC = "0 23 3 * * *";             // Firmware: täglich 03:23 die neueste stabile, falls es eine gibt
function watchdog(n) { R.sn = n || 0; Shelly.call("Schedule.List", {}, cbSafe, onSchedList); }
// Zwei Gerätezeitpläne, die ohne Skript wirken: der Wächter [4] und das Firmware-Update (wie „automatisches Update“
// in der Shelly-App). Den Wächter richtet das Skript stündlich wieder; das Update legt es nur an, wenn es keines gibt
// (in der App abgeschaltet bleibt es aus). Ein Schritt je Aufruf, danach gleich der nächste (höchstens 3).
function onSchedList(res, err, msg) {
  var jobs = (res && res.jobs) || [], i, j, c, m, wd = null, up = false;
  if (err) { log("Zeitplan nicht lesbar: " + msg); return; }
  for (i = 0; i < jobs.length; i++) {
    c = jobs[i].calls || [];
    for (j = 0; j < c.length; j++) {
      m = c[j] ? String(c[j].method).toLowerCase() : "";
      if (m === "script.start" && c[j].params && c[j].params.id === Script.id) wd = jobs[i];
      if (m === "shelly.update") up = true;   // auch eines aus der App
    }
  }
  if (!wd) {
    if (cfgCall("Schedule.Create", { enable: true, timespec: WD_SPEC,
      calls: [{ method: "Script.Start", params: { id: Script.id } }] }, onSchedSet)) {
      log("Wächter angelegt: Zeitplan startet das Skript alle 5 min, falls es steht");
    }
  } else if (wd.enable !== true || wd.timespec !== WD_SPEC) {   // abgeschaltet oder alter Takt: richten
    cfgCall("Schedule.Update", { id: wd.id, enable: true, timespec: WD_SPEC }, onSchedSet);
  } else if (!up) {
    if (cfgCall("Schedule.Create", { enable: true, timespec: UP_SPEC,
      calls: [{ method: "Shelly.Update", params: { stage: "stable" } }] }, onSchedSet)) {
      log("Firmware-Update angelegt: täglich 03:23 die neueste stabile");
    }
  }
}
function onSchedSet(res, err, msg) {
  if (err) log("Zeitplan nicht gesetzt: " + msg);
  else if (R.sn < 2) watchdog(R.sn + 1);
}
function init() {
  load();
  if (typeof C.LAT === "number" && typeof C.LON === "number") {   // eingetragen: keine Ortssuche, keine Ortsprüfung
    R.la = C.LAT; R.lo = C.LON; R.ia = 1e12; S.lf = 0; S.lc = "";
  }
  else if (S.la !== null) { R.la = S.la; R.lo = S.lo; }                                        // Ort gespeichert
  var s = Shelly.getComponentStatus("sys"), up = upS();
  if (S.wu > 0 && up >= S.wu) { R.sv = S.wu; R.wn = S.wn; R.w24 = Math.min(S.wb, up); }   // Skript-Neustart: Bremse zählt weiter
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN && (!S.ce || up < S.tu || ntpSet())) {   // echte Zeit
    if (S.ce || S.df) {                    // Zeitserver hat gestellt, bevor das Skript lief
      if (S.df === 1) shiftDays(loc(s.unixtime).day - loc(S.t).day);
      S.ce = 0; save();
    }
  } else if (S.t > C.T_MIN) {              // Zeitanker: untere Schranke, nie zu früh; nach Skript-Neustart genau
    R.eb = S.t + (up >= S.tu ? up - S.tu : up); R.eu = up; R.est = true; R.def = S.df === 1;
    if (S.ce !== 1 || up < S.tu || !(s && s.unixtime > C.T_MIN)) {   // nach einem Skript-Neustart läuft die
      S.ce = 1; S.cs = Math.floor(R.eb);                              // gestellte Geräteuhr weiter: nichts zu schreiben
      Shelly.call("Sys.SetTime", { unixtime: S.cs }, cbNone);
      log("Uhr aus Zeitanker geschätzt"); save();
    }
  } else R.defAt = up + 120;               // kein Anker: 2 min auf den Zeitserver warten
  applyCfg(); watchdog(); R.cfgAt = up + 3600;   // danach stündlich aus schedule()
  ledInit();
  vcStart();
  Timer.set(1000, true, tick);
  log("gestartet, Bodenkonto " + r1(S.d) + " mm, Normalleistung " + (S.pn || "noch nicht gelernt"));
}
init();
