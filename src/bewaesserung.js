/*
 * Bewässerung mit Brunnen- oder Gartenpumpe am Shelly Outdoor Plug S Gen3 (Shelly-Skript für Gen2/Gen3)
 * Eingestellt für: Tiefbrunnenpumpe IBO 3,5" SDM 5/14 (1100 W, 7,9 A), 3 Regner Rain Bird 5000, 500 m² Rasen.
 *
 * Was das Skript tut (die [Ziffern] verweisen auf Kapitel der Bauanleitung des Projekts, die nicht im Repository liegt;
 * das Wichtigste daraus steht in der README):
 *  - prüft täglich um START_MIN das Bodenkonto und gießt bei Bedarf; Automatik startet nur bis END_MIN [2]
 *  - rechnet mit Wetterdaten von Open-Meteo; ohne Internet mit Monatsmitteln und der Temperatur des
 *    eigenen Fühlers, korrigiert mit echten Daten, sobald das Internet zurück ist [2]
 *  - Taster oder App einschalten = Handgabe, nochmal = Stopp [3]
 *  - schützt die Pumpe über die gemessene Leistung: Voreinstellung, bis sie per Taster angelernt ist [4]
 *  - Anlernen: einstecken, 10 s warten, 5× drücken binnen 10 s; wird die LED weiß, Hahn zudrehen [4]
 *  - übersteht Stromausfälle: Zeitanker alle 6 h, Uhr am Tagesgang der Temperatur nachgestellt [5]
 *  - Bedienfeld in der Shelly-App: Status, Wasserdefizit, Automatik, Pause, Regenrate, Pumpe neu einlernen [3]
 *  - Diagnose im Browser: http://<IP>/script/<id>/info, mit dem Gerätepasswort [3]
 *
 * Lesehilfe: Einstellungen C, Klima -> Zustand S (gespeichert) und R (nur RAM) -> Helfer, Zeit, Speicher ->
 * Bodenkonto -> Gerätetemperatur und Uhr -> Relais und Pumpenschutz -> Wetter und Tagesentscheidung ->
 * Takt (tick jede s, schedule alle 30 s) -> Bedienfeld und LED -> Start (init).
 * Sprache: nur, was der Shelly-Interpreter sicher kann: ES5, keine Pfeilfunktionen, kein const, keine
 * Template-Strings, kein Hoisting, Rückrufe benannt und nicht verschachtelt.
 * Stapel: Der Shelly hat Platz für nur etwa 15 Aufrufe ineinander; Schleifen, Blöcke und Klammern kosten mit, ein
 * Überlauf beendet das Skript oder startet den Shelly neu. Darum flach: Zwischenwerte in eigene Anweisungen, Helfer
 * rufen kaum weiter, kein Selbstaufruf. tools/stapel.js prüft das beim Bauen.
 * Methoden: Das Espruino des Shelly ist abgespeckt (kein Array.shift). Der Bau lässt nur am Gerät nachgewiesene durch.
 */

// ============================== Einstellungen ==============================
var C = {
  // Ort und Zeit
  ORT: "Ludwigshafen am Rhein", LAND: "DE", // Koordinaten holt das Skript einmal von Open-Meteo und speichert sie;
                                 // Schreibweise prüfen, der erste Treffer zählt:
                                 // https://geocoding-api.open-meteo.com/v1/search?countryCode=DE&language=de&name=Ludwigshafen
  LAT: null, LON: null,          // oder direkt eintragen (z. B. 49.48, 8.45), dann ohne Ortssuche
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
  OFF_ET: 1.21,                  // ohne Internet lieber mehr: trockene Tage liegen 5 % zu tief, +5 % Reserve, darauf
                                 // nochmals +10 %: zu viel Wasser schadet nicht, zu wenig schon [2]

  // Pumpe: Voreinstellung für die eigene Pumpe, bis sie angelernt ist. I = Nennstrom laut Typenschild (A); gerechnet
  // wird mit dem Strom, weil die Watt-Angabe im Katalog oft die Leistung an der Welle ist. Tauchpumpe: P_LEARN_MAX 240·I,
  // P_ABS_DRY 78·I, P_ABS_OVER 265·I, I_MAX 1,33·I (höchstens 11 A; Pumpen über 9 A passen nicht an diesen Stecker).
  // Oberflächen-/Jetpumpe: dieselben Formeln, BLANK_S = Ansaugzeit + 20 s. Hauswasserwerk mit Druckschalter: ungeeignet.
  // Das Anlernen per Taster ersetzt die Voreinstellung durch gemessene Werte (siehe Anlernen).
  P_LEARN_MIN: 300, P_LEARN_MAX: 1900, // Anlernen übernimmt nur diese Normalleistung (W); kleinste Tauchpumpen ~400 W
  P_ABS_DRY: 600,                // nicht angelernt: darunter Trockenlauf (W); so wenig übernimmt das Anlernen nur
                                 // mit Hahn-zu-Messung, denn auch eine trockenlaufende Pumpe zieht so wenig
  P_ABS_OVER: 2100,              // nicht angelernt: darüber Überlast (W)
  I_MAX: 10.5,                   // Strom darüber = blockiert (A); Stecker selbst: 12 A
  MAX_RUN_MIN: 120,              // längster Lauf, Hand wie Automatik; zweite Grenze, falls ein zugedrehter Hahn
                                 // unerkannt bleibt. Den Timer hält die Firmware, er wirkt auch ohne Skript
  AUTO_OFF_S: 7800,              // Notabschaltung des Relais (130 min), wirkt auch ohne Skript
  MAX_STARTS_H: 10,              // Starts je Stunde: die Hälfte des Datenblattwerts (diese Pumpe verträgt 20)

  // Fachwerte: nur mit Grund ändern
  UNDER_REL: 0.75,               // darunter Unterlast (Trockenlauf / Hahn zu)
  OVER_REL: 1.30,                // darüber Überlast
  GAP_MIN: 0.2,                  // Hahn zu muss beim Anlernen mindestens 20 % weniger ziehen, sonst nicht erkennbar
  KAL_S: 300,                    // Anlernen höchstens 5 min (Timer der Firmware; plus Anlaufzeit über 40 s); das Skript
                                 // ist nach gut 3 min fertig
  KAL_WIN_S: 10,                 // die 5 Drücke müssen binnen 10 s fallen (in der ersten Minute nach dem Einstecken)
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
  NTP_WAIT_S: 600,               // nach dem Hochfahren mit geschätzter Uhr bis zu 10 min auf den Zeitserver warten,
                                 // bevor die Tagesprüfung läuft (der Router braucht nach einem Stromausfall Minuten) [5]
  ANCHOR_S: 21600,               // Zeitanker alle 6 h speichern: 4 Schreibvorgänge am Tag [5]
  WRITES_DAY: 48,                // Schreibbremse Speicher: höchstens 1 je Minute, nach 48 in 24 h 1 je Stunde [5]
  CFG_DAY: 30,                   // Schreibbremse Bedienfeld und Zeitpläne: höchstens 30 in 24 h; LED hat eigene 12 am Tag
                                 // (Rot und Anlernen ausgenommen),
                                 // die Relais-Sicherungen bremst nichts (höchstens stündlich, nur wenn verstellt) [5]
  RUN_SAVE_S: 1800,              // laufende Gabe halbstündlich gutschreiben: ein Stromausfall im Lauf kostet so höchstens
                                 // eine halbe Stunde Gutschrift
  T_MIN: 1767225600              // frühere Uhrzeiten sind ungültig (vor 2026)
};

// Klima des Ortes, Monatsmittel Januar bis Dezember, nur ohne Internet benutzt [2].
// Hier DWD Mannheim 2016–2025; für einen anderen Ort: python3 tools/klima.py "Ortsname" [LAND]
var ET0_CLIM = [0.6, 0.9, 1.6, 2.6, 3.5, 4.5, 4.4, 3.8, 2.4, 1.1, 0.5, 0.5];   // Grasreferenzverdunstung (mm/Tag)
var TMAX_CLIM = [6.1, 9.3, 13.0, 17.0, 21.1, 26.3, 27.4, 27.4, 22.8, 16.7, 9.6, 6.8]; // Tageshöchstwert (°C)

// LED des Steckers (Farben 0..100, volle Helligkeit, auch in der Sonne zu sehen): grün = alles gut, gelb = Daten
// fehlen (Wetterdienst, Uhr, Ort), rot = der letzte Lauf hatte eine Störung (bleibt, bis ein Lauf wieder fehlerfrei war,
// auch über Neustarts), ebenso Relais klebt oder Speicher schreibt nicht; blau = Pumpe läuft, weiß = beim Anlernen jetzt
// den Hahn zudrehen. Die Firmware blinkt rot (WLAN, Update) und blau (AP), das Skript leuchtet dauernd. Jede Änderung
// ist ein Flash-Schreibvorgang: rot nach 2 min Bestand, jede andere Farbe erst nach 30 min, höchstens 12 am Tag (Rot und
// Anlernen ausgenommen); das Anlernen zeigt sich sofort [3]
var LED = { ok: [0, 100, 0], warn: [100, 70, 0], err: [100, 0, 0], run: [0, 0, 100], cue: [100, 100, 100] };

// ============================== Zustand ==============================
// S wird gespeichert (Script.storage "s"), ebenso das Störungsprotokoll R.fl ("f"); der Rest von R lebt nur im RAM.
var S = null;
var R = {
  k: 0,              // Takt-Zähler
  u: 0,              // Uhrzeit dieses Takts (0 = unbekannt), für log()
  sw: { output: false, apower: 0, tC: null },   // Relais dieses Takts (nur das Nötige, Arbeitsspeicher): tiefe Aufrufe
                                                 // lesen hier statt selbst die Firmware zu fragen (Stapel)
  ra: 0, au: true,   // Regenrate aus dem Bedienfeld (0 = Startwert C.RATE_MM_H), Automatik an
  oq: "",            // Ortsname für die URL der Ortssuche
  eb: 0, eu: 0,      // Uhr-Schätzung: Basis-Unixzeit und Uptime dazu
  est: false,        // Uhr ist geschätzt (kein Internet seit Neustart)
  run: null,         // laufende Beregnung
  ps: null,          // eigener Start ist unterwegs
  want: null,        // aufgeschobener Automatik-Start
  starts: [],        // Uptimes der Starts der letzten Stunde
  lastStop: 0,       // Uptime des letzten Stopps
  wc: 0, weld: false,// Relais-Prüfung bei AUS
  wx: { busy: false, next: 0, tries: 0, L: null, n: 0, rc: false, t: 0, q: 0, cg: 0 },  // Wetterabruf: läuft seit t, Nummer q
  off: false, oa: 0, // letzte Wetterabfrage gescheitert, seit (Unixzeit)
  ie: false,         // der letzte Ausfall (S.io) endete mit geschätzter Uhr: beim Stellen mitverschieben
  sv: -1e9, sd: false, wn: 0, w24: 0, // Schreibbremse Speicher: letztes Schreiben, noch zu schreiben, Anzahl, Fensterbeginn
  cn: 0, c24: 0,     // Schreibbremse Bedienfeld und Zeitpläne: Anzahl, Fensterbeginn
  why: "",           // Ergebnis der heutigen Prüfung
  note: "", noteU: 0,// Hinweis (Einlernen usw.), verschwindet nach 12 h
  noStore: false,
  h: null,           // Bedienfeld-Handles
  paShown: -1, lastTxt: "", lastD: -1,
  boot: true,
  def: false, defAt: 0,  // Uhrzeit angenommen (1. April 10:00), weil nichts bekannt war
  kh: -1, kts: [], ko: false, kw: 0, // Anlern-Geste: Status-Abo (-1 = keines), Zeiten der letzten 5 Drücke, Relais
                                     // zuletzt, 5 erreicht
  pbNext: 0,        // nächster Verbindungstest (Uptime), solange der Wetterdienst fehlte
  cfgAt: 0, sn: 0,   // nächstes Nachstellen von Relais-Einstellungen und Zeitplänen (Uptime); Schritt dabei
  cg: 0,             // Uhr-Generation: zählt jedes Stellen der Uhr; ein Wetterabruf von davor wird verworfen
  hb: 0, hn: 0, hr: -1, hl: 0, // Bedienfeld: letzter Versuch anzulegen und zu binden (Uptime); Versuche; Taster-Abo; Verluste
  led: "", ledOn: "", ledWant: "", ledSince: 0, ledN: [], lx: 0, cue: 0, // LED aus/im Lauf; lx: Anlernen gleich zeigen,
                                                                          // ohne Wartezeit; cue: im Lauf weiß (Hahn zu)
  td: null, ty: null, ts: -1e9, // Gerätetemperatur heute / gestern {d, n, mn, mx}, letzte Messung
  z: null, zf: -1e9, zl: 0, zn: 0, cp: 0, co: 0, // Tagesgang-Uhr: letzte Korrektur, Betrag, schon gestellt, Stellen läuft
  rh: 0, nf: false,  // Minute der nächsten Nachprüfung nach Regen oder Frost (0 = gleich, auch nach Neustart); Prognose heute nicht zählen
  la: null, lo: null, gn: 0, gx: false, // Koordinaten; nächste Ortsabfrage (Uptime); Ortsname nicht gefunden
  st: "",            // Ergebnis des Selbsttests fürs Aufspielwerkzeug
  lg: [], li: 0, t0: 0, s0: 0, // Diagnose: letzte Meldungen als Ring und nächster Platz darin; zuletzt gespeicherte
                     // Uhrzeit vor dem Start; Skriptstart (Uptime);
  fl: [], fn: false, // Störungsprotokoll (gespeichert unter "f"), noch zu schreiben
  nw: 0, nc: 0, nl: 0 // Flash-Schreibvorgänge seit dem Skriptstart: Speicher, Einstellungen, LED
};

// ============================== Kleine Helfer ==============================
function upS() { return Shelly.getUptimeMs() / 1000; }
function r0(x) { return Math.round(x); }
function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }
function f1(x) { var v = Math.round(x * 10) / 10; return String(v).replace(".", ","); }   // Anzeige mit Dezimalkomma
function lim(x, a, b) { return x < a ? a : (x > b ? b : x); }
function fin(x) { return typeof x === "number" && x - x === 0; }   // endliche Zahl: aus 1e400 macht JSON.parse Infinity
function nz(x) { return typeof x === "number" && x - x === 0 ? x : 0; }   // Messwert, sonst 0 (gilt als "zieht nichts")
function jlen(t) {                        // Länge im Speicher: Espruino schreibt jedes Byte ab 0x80 als \u00XX
  var n = t.length, i = 0;
  while (i < t.length) { if (t.charCodeAt(i) > 127) n += 5; i++; }
  return n;
}
function p2(n) { return (n < 10 ? "0" : "") + n; }
function log(t) {                         // Konsole und die letzten 6 Meldungen für die Diagnose (nur RAM). Uhrzeit roh
  var k = R.u > 1e9 && R.u < 1e10 ? Math.floor(R.u) : 0, j = R.lg[(R.li + 5) % 6];   // aus dem Takt (R.u, 10 Ziffern),
  t = String(t); print("[BW] " + t);      // ~ für geschätzt, Text; lesbar erst in info(): log() muss flach bleiben
  if (j && j.slice(11) === t.slice(0, 80)) return;   // Wiederholung der letzten Meldung: nur in die Konsole
  k = (k ? String(k) : "0000000000") + (R.est ? "~" : " ") + t.slice(0, 80);
  if (R.lg.length < 6) R.lg.push(k); else R.lg[R.li] = k;   // Ring statt shift(): shift() fehlt dem Shelly
  R.li = (R.li + 1) % 6;
}
function sw() { return Shelly.getComponentStatus("switch", 0) || {}; }   // im Takt; sonst R.sw, der Stand dieses Takts
function swKeep(st) {                     // das Nötige davon in R.sw, ohne neues Objekt
  var c = st.temperature;
  R.sw.output = !!st.output; R.sw.apower = nz(st.apower); R.sw.tC = c && fin(c.tC) ? c.tC : null;
}
function cbNone(res, err, msg) { if (err) log("RPC-Fehler " + err + " " + msg); }
// Ein Fehler in einem Rückruf beendet ein Shelly-Skript (der Wächter startet es erst nach bis zu 5 min neu). Darum
// laufen die Rückrufe über cbSafe (Rückruf als userdata): Fehler werden gemeldet, die Wiederholung kommt vom Takt.
function cbSafe(res, err, msg, f) {
  try { f(res, err, msg); } catch (e) { log("Fehler im Rückruf: " + e); }
}

// ============================== Zeit (C.UTC_H mit EU-Sommerzeit, ohne Firmware-Zeitzone) ==============================
// "| 0" rundet hier ab wie Math.floor (alle Werte positiv und klein) und spart den Aufruf der Firmware
function dfc(y, m, d) {                   // Tagesnummer seit 1970-01-01
  y -= m <= 2 ? 1 : 0;
  var era = (y / 400) | 0, yoe = y - era * 400;
  var doy = (((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) | 0) + d - 1;
  var doe = yoe * 365 + ((yoe / 4) | 0) - ((yoe / 100) | 0) + doy;
  return era * 146097 + doe - 719468;
}
function cfd(z) {                         // Tagesnummer -> {y, m, d}
  z += 719468;
  var era = (z / 146097) | 0, doe = z - era * 146097;
  var yoe = ((doe - ((doe / 1460) | 0) + ((doe / 36524) | 0) - ((doe / 146096) | 0)) / 365) | 0;
  var doy = doe - (365 * yoe + ((yoe / 4) | 0) - ((yoe / 100) | 0));
  var mp = ((5 * doy + 2) / 153) | 0;
  var m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m: m, d: doy - (((153 * mp + 2) / 5) | 0) + 1 };
}
function utcOff(u) {                      // Sommerzeit vom letzten So im März bis letzten So im Oktober, je 01:00 UTC.
  // Jahr aus der mittleren Jahreslänge: kann um Neujahr einen Tag danebenliegen, dann ist so oder so Winterzeit
  var y = 1970 + ((u / 31556952) | 0), a = dfc(y, 4, 1) - 1, b = dfc(y, 11, 1) - 1;   // letzter Tag im März, Oktober,
  a = (a - (a + 4) % 7) * 86400 + 3600;   // davon der letzte Sonntag (1970-01-01 war ein Donnerstag)
  b = (b - (b + 4) % 7) * 86400 + 3600;
  return (C.UTC_H + (u >= a && u < b ? 1 : 0)) * 3600;
}
function loc(u) {                         // Ortszeit: Tagesnummer, Minute, Datum
  var t = u + utcOff(u), day = (t / 86400) | 0, c = cfd(day);
  return { day: day, min: ((t - day * 86400) / 60) | 0, y: c.y, m: c.m, d: c.d };
}
function ymd(L) { return L.y + "-" + p2(L.m) + "-" + p2(L.d); }
function hm(min) { return p2((min / 60) | 0) + ":" + p2(min % 60); }
function dmy(day) { var c = cfd(day); return p2(c.d) + "." + p2(c.m) + "."; }
function sunUtc(day) {                    // Sonnenaufgang in Minuten nach Mitternacht UTC (NOAA-Näherung) [5]
  var c = cfd(day), j = dfc(c.y, 1, 1), g = 2 * Math.PI / 365 * (day - j);
  var c1 = Math.cos(g), s1 = Math.sin(g), c2 = Math.cos(2 * g), s2 = Math.sin(2 * g);
  var eq = 229.18 * (0.000075 + 0.001868 * c1 - 0.032077 * s1 - 0.014615 * c2 - 0.040849 * s2);
  var de = 0.006918 - 0.399912 * c1 + 0.070257 * s1 - 0.006758 * c2 + 0.000907 * s2;
  var la = (R.la === null ? 50 : R.la) * Math.PI / 180;   // Ort noch unbekannt: Mitte der Zeitzone
  var cl = Math.cos(la), cd = Math.cos(de), tl = Math.tan(la), td = Math.tan(de), z = Math.cos(1.58534);
  var ha = Math.acos(z / (cl * cd) - tl * td);
  return 720 - 4 * ((R.lo === null ? 15 * C.UTC_H : R.lo) + ha * 180 / Math.PI) - eq;
}

function nowU() {                         // Unixzeit; geschätzt ab Zeitanker, wenn keine echte Zeit da ist
  var s = Shelly.getComponentStatus("sys"), m = Shelly.getUptimeMs();
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN) return s.unixtime;
  return R.eb ? R.eb + m / 1000 - R.eu : null;
}

function ntpSet() {                       // Zeitserver hat gestellt (nicht unser Sys.SetTime)?
  var s = Shelly.getComponentStatus("sys");
  return !!s && typeof s.last_sync_ts === "number" && Math.abs(s.last_sync_ts - S.cs) > 5;
}

// ============================== Speicher ==============================
function load() {                         // übernimmt nur bekannte Felder mit passendem Typ und endlichen Zahlen: Fremdes
  var v = null, g = null, k, i, D = {     // (ältere Fassung) fiele sonst nie weg, S würde zu groß zum Schreiben
    v: 1,
    t: 0,     // Zeitanker
    d: 0,     // Bodendefizit am Ende des letzten verbuchten Tages
    dp: -1,   // letzter verbuchter Tag
    pi: 0,    // seither gegossen (mm)
    ev: -1,   // Tag der letzten Tagesprüfung
    pn: 0,    // angelernte Normalleistung (W), 0 = Voreinstellung
    pc: 0,    // angelernte Leistung bei zugedrehtem Hahn (W), 0 = keine
    kt: 0,    // angelernt am (Unixzeit, 1 = Zeit unbekannt)
    pu: 0,    // Pause bis einschließlich Tag
    fd: -1,   // Tag der Störungszählung
    fc: 0,    // Störungen an diesem Tag
    rt: 0,    // Nachlauf ab Unixzeit
    rm: 0,    // Nachlauf-Menge (mm)
    rq: 0,    // Nachlauf: Bezugsleistung des abgebrochenen Laufs (W)
    lr: "",   // letzter Lauf, für die Anzeige
    xa: -1,   // erster Tag, der ohne Internet geschätzt verbucht wurde; dazu (unten) xe: die Schätzungen dieser Tage (mm),
    xd: 0,    // xw: das davor Gegossene. xd: Konto vor dem ersten geschätzten Tag, die Korrektur rechnet von hier neu
    ob: -99,  // gelernte Eigenwärme beim Tiefstwert (K), -99 = noch nicht
    oa: -99,  // gelernte Eigenwärme beim Höchstwert (K)
    df: 0,    // 1 = Uhrzeit beruht auf der Annahme 1. April 10:00
    rd: -1,   // Tag, an dem die Regenprognose die Gabe gekürzt hat
    rx: 0,    // dabei erwarteter Regen (mm)
    rc: -1,   // Tag, an dem Regen oder Frost die Gabe verhindert hat: stündlich nachsehen
    rk: 0,    // warum: 1 Frost laut Prognose, 3 Frost geschätzt, 2 Regen
    rf: 0,    // Tiefstwert dieser Frostnacht (°C)
    tu: 0,    // Laufzeit des Geräts beim Zeitanker (s): Skript-Neustart erkennen
    ce: 0,    // 1 = Geräteuhr vom Skript geschätzt, Zeitserver hat sie seither nicht gestellt
    cs: 0,    // zuletzt vom Skript gestellte Uhrzeit, vom Zeitserver zu unterscheiden
    fu: 0,    // letzte Störung (Unixzeit, 1 = Zeit unbekannt)
    ft: "",   // ihr Text
    fo: 0,    // 1 = noch offen: LED rot, bis ein Lauf fehlerfrei war (fehlt der Wert: offen, wenn es eine Störung gab)
    s0: 0,    // Saison seit (Tag), für die Diagnose; dazu Läufe Automatik und Nachlauf, Handgaben, gegebene mm, Störungen
    sa: 0, sh: 0, sm: 0, sf: 0,
    io: 0,    // letzter Ausfall des Wetterdienstes: Beginn (Unixzeit), Dauer (min)
    id: 0,
    os: 0,    // Wetterdienst fehlt seit (Unixzeit, 1 = Zeit unbekannt), übersteht Neustarts
    wu: 0,    // Schreibbremse über Skript-Neustarts: Laufzeit beim letzten Schreiben (s), Anzahl im Fenster, Fensterbeginn
    wn: 0, wb: 0,
    la: null, lo: null, pz: ""   // Ort: Koordinaten und wofür sie gelten (unten geprüft)
  };
  try { g = Script.storage.getItem("s"); v = JSON.parse(g); } catch (e) { v = null; }
  if (!v || v.v !== 1) { if (g) log("Speicher unlesbar, Voreinstellungen"); v = {}; }
  for (k in D) {                          // Zahlen nur in sinnvoller Größe, gerundet: so bleibt S unter 1024 Byte
    if (typeof v[k] !== typeof D[k]) continue;
    if (typeof D[k] === "string") D[k] = v[k]; else if (fin(v[k]) && Math.abs(v[k]) < 1e10) D[k] = r2(v[k]);
  }
  if (!(D.d >= 0 && D.d <= C.D_MAX_MM)) D.d = 0;
  if (!(D.pi >= 0)) D.pi = 0;
  if (!(D.pn >= C.P_LEARN_MIN && D.pn <= C.P_LEARN_MAX)) D.pn = 0;   // nur, was das Anlernen übernehmen kann
  if (!(D.pc >= 0 && D.pc < D.pn)) D.pc = 0;
  if (!fin(v.fo)) D.fo = D.fu ? 1 : 0;
  if (jlen(D.lr) > 80) D.lr = "";        // Anzeigetexte: so lang (im Speicher) schreibt das Skript sie höchstens;
  if (jlen(D.ft) > 140) D.ft = "";       // längere sprengten mit dem Rest die 1024 Byte
  g = v.xe; k = v.xw; D.xe = []; D.xw = [];   // je Tag eine Zahl, beide gleich lang, höchstens 14 Tage
  if (g && k && g.length === k.length && g.length <= 14) {
    for (i = 0; i < g.length; i++) {
      if (!fin(g[i]) || !fin(k[i]) || Math.abs(g[i]) > 1e4 || Math.abs(k[i]) > 1e4) { D.xe = []; D.xw = []; break; }
      D.xe.push(r2(g[i])); D.xw.push(r2(k[i]));
    }
  }
  if (!D.xe.length) D.xa = -1;
  if (v.pz === C.LAND + C.ORT && fin(v.la) && Math.abs(v.la) <= 90 && fin(v.lo) && Math.abs(v.lo) <= 180) {
    D.la = v.la; D.lo = v.lo;               // sonst Ort neu bestimmen
  } else D.pz = "";
  S = D;
  try { v = JSON.parse(Script.storage.getItem("f")); } catch (e2) { v = null; }   // Störungsprotokoll, eigener Eintrag:
  R.fl = [];                                                                       // S allein bleibt so unter 1024 Byte
  if (v && typeof v === "object" && v.length <= 5) for (i = 0; i < v.length; i++) if (typeof v[i] === "string" && jlen(v[i]) <= 60) R.fl.push(v[i]);
}
function save() { R.sd = true; }          // geschrieben wird am Ende des Takts (flush), so bleibt der Stapel flach
function flush() {                        // Schreibbremse: höchstens 1 je Minute, nach WRITES_DAY in 24 h 1 je Stunde;
  var now = upS(), u;                     // fängt auch einen Fehler ab, der save() in Schleife riefe [5]
  if (!R.sd) return;
  if (now - R.w24 >= 86400) { R.w24 = now; R.wn = 0; }
  if (now - R.sv < (R.wn >= C.WRITES_DAY ? 3600 : 60)) return;
  u = nowU();
  if (u) { S.t = Math.floor(u); S.tu = Math.floor(now); }
  S.d = r2(S.d); S.pi = r2(S.pi);
  S.wu = Math.floor(now); S.wn = R.wn + 1; S.wb = Math.floor(R.w24);   // gilt so auch nach einem Skript-Neustart
  try {
    Script.storage.setItem("s", JSON.stringify(S)); R.noStore = false; R.sd = false; R.nw++;
    if (R.fn) { Script.storage.setItem("f", JSON.stringify(R.fl)); R.fn = false; R.nw++; }
  } catch (e) { if (!R.noStore) log("Speicher schreibt nicht: " + e); R.noStore = true; }   // LED rot (checks)
  R.sv = now; R.wn++;                     // auch ein Fehlversuch zählt: kein Dauerversuch
}
function cfgCall(m, p, f) {               // Bedienfeld und Zeitpläne schreiben (Flash): höchstens CFG_DAY in 24 h; false = gebremst
  var now = Shelly.getUptimeMs() / 1000;
  if (now - R.c24 >= 86400) { R.c24 = now; R.cn = 0; }
  if (R.cn === C.CFG_DAY) log("Schreibbremse Einstellungen: " + m);   // einmal melden
  if (R.cn >= C.CFG_DAY) { R.cn++; return false; }
  Shelly.call(m, p, cbSafe, f);
  R.cn++; R.nc++;
  return true;
}

// ============================== Bedienfeld (Virtual Components) ==============================
var VC = [["text", 200, "st"], ["number", 200, "bk"], ["boolean", 200, "au"], ["number", 201, "pa"],
  ["number", 202, "ra"], ["button", 200, "re"]];   // Typ, Nummer, Kürzel; die Einstellungen erst beim Anlegen (vcConf)
function vcConf(i) {                      // Einstellungen von VC[i] beim Anlegen; so belegen sie keinen Arbeitsspeicher
  if (i === 0) return { name: "Status", default_value: "", persisted: false, max_len: 255, meta: { ui: { view: "label" } } };
  if (i === 1) return { name: "Wasserdefizit", default_value: 0, persisted: false, min: 0, max: 25,
    meta: { ui: { view: "progressbar", unit: "mm", step: 0.1 } } };
  if (i === 2) return { name: "Automatik", default_value: true, persisted: true, meta: { ui: { view: "toggle", titles: ["Aus", "An"] } } };
  if (i === 3) return { name: "Pause", default_value: 0, persisted: false, min: 0, max: 14,
    meta: { ui: { view: "field", unit: "Tage", step: 1 } } };
  if (i === 4) return { name: "Regenrate", default_value: C.RATE_MM_H, persisted: true, min: 1, max: 40,
    meta: { ui: { view: "field", unit: "mm/h", step: 0.1 } } };
  return { name: "Pumpe neu einlernen", meta: { ui: { view: "button" } } };
}
var vcI = 0;

function vcNext() {                      // Schleife statt Selbstaufruf: der Stapel des Shelly ist klein
  var c;
  while (vcI < VC.length && Shelly.getComponentConfig(VC[vcI][0], VC[vcI][1])) vcI++;
  if (vcI < VC.length) {
    c = vcConf(vcI);
    cfgCall("Virtual.Add", { type: VC[vcI][0], id: VC[vcI][1], config: c }, vcAdded);
    return;
  }
  if (!Shelly.getComponentConfig("group", 200)) {
    cfgCall("Virtual.Add", { type: "group", id: 200,
      config: { name: "Bewässerung", meta: { ui: { view: "group" } } } }, vcGroupAdded);
    return;
  }
  vcGroup(); vcBind();                    // nacheinander statt ineinander: flacher Stapel
}
function vcStart() { R.hb = upS(); R.hn++; vcI = 0; vcNext(); }   // Bedienfeld anlegen (was fehlt) und binden
function vcAdded(res, err, msg) {
  if (vcI >= VC.length) return;           // später Rückruf eines früheren Durchlaufs
  if (err) log("Bedienfeld " + VC[vcI][2] + ": " + msg);
  vcI++; vcNext();
}
function vcGroupAdded(res, err, msg) { vcGroup(); vcBind(); }
function vcGroup() {                      // Gruppe enthält genau das Bedienfeld; Reihenfolge egal: käme sie sortiert
  var want = [], i, g = Shelly.getComponentStatus("group", 200), v = g ? g.value : null, ok, s;   // zurück, schriebe ein
  for (i = 0; i < VC.length; i++) want.push(VC[i][0] + ":" + VC[i][1]);                         // Vergleich als Ganzes
  ok = !!v && v.length === want.length;                                                         // sonst jedes Mal
  s = ok ? "," + String(v) + "," : "";   // String statt join: wirft auch bei einem Wert ohne join nicht
  for (i = 0; i < want.length; i++) if (s.indexOf("," + want[i] + ",") < 0) ok = false;
  if (!ok) cfgCall("Group.Set", { id: 200, value: want }, cbNone);
}
function vcBind() {
  var h = {}, i, ok = true;
  if (R.h) return;                        // schon gebunden (zwei Durchläufe gleichzeitig)
  try {
    i = 0;
    while (i < VC.length) {               // while statt for: kostet weniger Stapel
      h[VC[i][2]] = Virtual.getHandle(VC[i][0] + ":" + VC[i][1]);
      if (!h[VC[i][2]]) ok = false;
      i++;
    }
  } catch (e) { ok = false; }
  if (!ok) {                              // ohne Anzeige weiter; schedule() versucht es erst minütlich, dann stündlich
    if (R.hn === 1) log("Bedienfeld unvollständig – ohne Anzeige weiter");
    return;
  }
  if (R.hr < 0) {                         // ein Abo genügt: ließ sich das alte nicht abmelden, bleibt es (Abos sind knapp)
    try { R.hr = h.re.on("single_push", onRelearn); } catch (e2) { log("Knopf im Bedienfeld ohne Abo: " + e2); }
  }
  R.h = h; panelRead();
  if (R.hn > 1) log("Bedienfeld verbunden");
}
function onRelearn(ev) {                 // Bedienfeld: angelernte Werte verwerfen, es gilt wieder die Voreinstellung
  try { S.pn = 0; S.pc = 0; S.kt = 0; save(); note("Pumpe auf Voreinstellung; anlernen: einstecken, 5× drücken"); }
  catch (e) { log("Fehler Taster: " + e); }
}
function rate() { return R.ra > 0 ? R.ra : C.RATE_MM_H; }
function autoOn() { return R.au; }
function panelRead() {                    // Regenrate und Automatik aus dem Bedienfeld: beim Binden und alle 10 s (ui),
  var v = R.h ? R.h.ra.getValue() : (Shelly.getComponentStatus("number", 202) || {}).value,   // tiefe Aufrufe lesen
      a = R.h ? R.h.au.getValue() : (Shelly.getComponentStatus("boolean", 200) || {}).value;  // R.ra und R.au; ohne
  R.ra = (typeof v === "number" && v >= 1 && v <= 40) ? v : 0;                                // Bindung aus dem
  R.au = a !== false;                                                                         // Gerätestatus
}
function paused(L) { return S.pu && L.day <= S.pu; }

// ============================== Bodenkonto ==============================
function climEt(m) { return ET0_CLIM[m - 1]; }
function inSeason(L) {                    // auch über den Jahreswechsel (Südhalbkugel: FROM > TO)
  var a = C.SEASON_FROM, b = C.SEASON_TO;
  return a <= b ? L.m >= a && L.m <= b : L.m >= a || L.m <= b;
}
function prov(L) {                        // aktuelles Defizit inkl. noch nicht verbuchter Tage (bis 14, Monatsmittel)
  var p = S.dp < 0 ? 0 : lim(L.day - 1 - S.dp, 0, 14), d = lim(S.d - S.pi, 0, C.D_MAX_MM);
  return lim(d + p * ET0_CLIM[L.m - 1] * C.KC, 0, C.D_MAX_MM);
}
function secsFor(mm) { var r = rate(), s = Math.round(mm / r * 3600), m = C.MAX_RUN_MIN * 60; return s < m ? s : m; }
function selfK(mx) { var o = mx ? S.oa : S.ob; return o > -50 ? o : (mx ? C.SELF_DAY_K : C.SELF_NIGHT_K); }
function estEt(day) {                     // ohne Internet: Monatsmittel, an heißen Tagen mehr (Gerätetemperatur) [2]
  var m = cfd(day).m, t = R.ty, f = 1, k;
  if (t && t.d === day && t.n >= 100) { k = selfK(1); f = lim(1 + C.ET_K * (t.mx - k - TMAX_CLIM[m - 1]), 0.5, 1.6); }
  return ET0_CLIM[m - 1] * f * C.OFF_ET;
}
// Gegossenes zuerst abziehen, dann die Tage buchen: Die Gabe kommt morgens, die Verdunstung danach. Umgekehrt
// schnitte die 25-mm-Grenze die Verdunstung ab, und nach jeder Gabe am Deckel fehlte ein Tag.
// Für die Korrektur merkt es sich den Stand davor (xd), je Tag das vorher Gegossene (xw) und die Schätzung (xe).
// Mit echten Daten rechnet es die Tage dann neu durch: Ein Regentag setzt das Konto auf 0, die Tage danach zählen.
function xDrop() {                        // ältester geschätzter Tag fällt aus der Korrektur: Startwert nachziehen
  var e = [], w = [], i;
  S.xd = lim(S.xd - S.xw[0], 0, C.D_MAX_MM) + S.xe[0];
  for (i = 1; i < S.xe.length; i++) { e.push(S.xe[i]); w.push(S.xw[i]); }   // neu aufbauen: shift() fehlt dem Shelly
  S.xe = e; S.xw = w; S.xa++;
}
function bookEst(L) {                     // ohne Internet: offene Tage geschätzt verbuchen, für die Korrektur merken
  var d, b, e, w0 = S.pi;
  if (S.dp + 1 >= L.day) return;          // kein offener Tag (zweiter Aufruf am selben Tag): Gegossenes bleibt in S.pi
  if (S.xa < 0 && S.dp + 1 < L.day) { S.xd = S.d; S.xe = []; S.xw = []; }
  S.d = lim(S.d - S.pi, 0, C.D_MAX_MM); S.pi = 0;
  for (d = S.dp + 1; d < L.day; d++) {   // Zwischenwerte einzeln: Aufrufe in der Schleife kosten Stapel
    b = S.d; e = estEt(d); e = r1(e * C.KC);
    S.d = lim(S.d + e, 0, C.D_MAX_MM);
    if (S.xa < 0) S.xa = d;
    e = r1(S.d - b); S.xe.push(e);        // xe: was nach der Grenze wirklich dazukam
    e = r1(w0); S.xw.push(e); w0 = 0;
  }
  while (S.xe.length > 14) xDrop();       // nach der Schleife: dieselben Tage fallen raus, kostet weniger Stapel
  S.dp = L.day - 1;
}

// ============================== Gerätetemperatur ==============================
function temp(L, now) {                   // alle 10 min, nur wenn das Relais seit 30 min aus ist (Eigenwärme) [2]
  var st, c, v, t;
  if (now - R.ts < 600) return;
  R.ts = now; st = R.sw;
  if (st.output || R.run || now - R.lastStop < 1800 || st.tC === null) return;
  v = st.tC; t = R.td;
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
  if (tx - tn < 5 || t.mx - t.mn < (tx - tn) / 2) return;   // Fühler folgt dem Tag kaum (drinnen?): nicht lernen,
  dn = t.mn - tn; dx = t.mx - tx;         // sonst gälte die Zimmerwärme draußen als Eigenwärme. Chip über Luft; im
                                          // Ruhezustand heizt nur der Eigenverbrauch (~1 W)
  if (dn > -5 && dn < 50) S.ob = S.ob > -50 ? r1(S.ob + (dn - S.ob) * 0.3) : r1(dn);   // Unplausibles nicht lernen
  if (dx > -5 && dx < 50) S.oa = S.oa > -50 ? r1(S.oa + (dx - S.oa) * 0.3) : r1(dx);
}
function frostEst() {                     // ohne Internet: Tiefstwert der Nacht = Gerät minus Eigenwärme [2]
  var t = R.td, v = null;
  if (t && t.n) v = t.mn;
  else if (R.sw.tC !== null) v = R.sw.tC;
  if (v === null) return null;
  return v - selfK(0) - (t && t.n >= 36 ? 0 : 5);   // weniger als 6 h Messwerte (Neustart): 5 K Reserve
}
function airNow() {                       // ohne Internet: Luft jetzt = Gerät minus Eigenwärme, nur bei ruhendem Relais;
  var st = R.sw, now = Shelly.getUptimeMs() / 1000, a, b;   // für den Frost vorsichtig: die größere Eigenwärme,
  if (st.output || R.run || now - R.lastStop < 1800 || st.tC === null) return null;   // ungelernt die Voreinstellung
  a = selfK(0); b = selfK(1);                       // (15 K); ohne sie bliebe offline jeder Tag nach einer Frostnacht
  return st.tC - Math.max(a, b);                    // gesperrt, und gelernt wird am Standort ohne Internet nie
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
  var u = R.eb + tUp - R.eu, d = Math.floor(u / 86400), i, e, t, lag = null, now = Shelly.getUptimeMs() / 1000, sr = [];
  if (!R.est || now - R.zf < 72000) return;
  sr[0] = sunUtc(d - 1); sr[1] = sunUtc(d); sr[2] = sunUtc(d + 1);   // vor der Schleife: Aufrufe darin kosten Stapel
  for (i = -1; i <= 1; i++) {
    e = (d + i) * 86400 + sr[i + 1] * 60 + 600 - u;
    if (R.def ? (e > -43200 && e <= 43200) : (e >= -10800 && e < 75600)) lag = e;
  }
  if (lag === null) return;
  e = lag - C.CLOCK_LATE_S;               // lieber zu spät als zu früh (ohne Anker ist auch das Datum geraten)
  // erstes Stellen ab 1,5 h Abweichung (Anker-Uhr nur vor); danach nur, wenn ein Morgen 1,5 h vom Ziel abweicht:
  // kein Nachrutschen durch Messrauschen, ein Ausreißer heilt am nächsten klaren Morgen
  if ((R.zn ? Math.abs(e) : (R.def ? Math.abs(lag) : lag)) < C.CLOCK_S) return;
  t = Math.floor(R.eb + e + now - R.eu);
  Shelly.call("Sys.SetTime", { unixtime: t }, cbSafe, onClockSet);   // wirft der Aufruf, bleibt alles beim Alten
  R.zf = now; R.zl = e; R.co = S.cs; R.cp = now; S.cs = t;
}
function oaShift(d) {                     // Uhr gestellt: Beginn eines laufenden Ausfalls mitverschieben, ebenso den
  if (R.oa) { R.oa += d; if (S.os > 1) S.os = Math.floor(R.oa); }   // letzten, wenn er mit geschätzter Uhr endete
  if (R.ie && S.io) S.io = Math.floor(S.io + d);                    // (Wetterdienst vor dem Zeitserver zurück);
  if (S.rt) S.rt = Math.floor(S.rt + d);                            // geplanter Nachlauf und aufgeschobener Start
  if (R.want) R.want.exp += d;                                      // behalten ihren Abstand, sonst käme der
}                                                                   // Nachlauf nach dem Stellen sofort
function onClockSet(res, err, msg) {      // Schätzung erst nachziehen, wenn die Geräteuhr wirklich gestellt ist
  R.cp = 0;
  if (err) { S.cs = R.co; log("Uhr nicht stellbar: " + msg); return; }
  R.eb += R.zl; R.zn = 1; R.cg++; oaShift(R.zl); save();
  log("Uhr nach Tagesgang um " + f1(R.zl / 3600) + " h gestellt");
}
function clockReal(t, old) {              // der Zeitserver hat gestellt: die Uhr gilt ab jetzt als echt
  if (R.def && old) shiftDays(loc(t).day - loc(old).day);
  if (!(Math.abs(t - old) <= 60)) R.cg++; // Uhr wirklich gesprungen: laufender Wetterabruf gilt nicht
  if (old) oaShift(t - old);
  R.eb = t; R.eu = upS(); R.est = false; R.def = false; R.ie = false; S.ce = 0; R.td = null; R.ty = null; save();
}

// ============================== Relais und Läufe ==============================
function startsLastHour(now) {
  var a = [], i;
  for (i = 0; i < R.starts.length; i++) if (now - R.starts[i] < 3600) a.push(R.starts[i]);
  R.starts = a.slice(-C.MAX_STARTS_H);    // es zählen nur die neuesten: so wächst die Liste nicht, wenn ein verlorenes
  return a.length;                        // Aus die Pumpe anlässt und jeder Takt den Start erneut sieht
}
function relayOff(why) {                  // monitor() und kalTick() schicken das Aus alle 5 s erneut, bis es aus ist:
  var r = R.run;                          // ein verlorener Befehl ließe die Pumpe sonst bis zum Firmware-Timer laufen
  if (r) { if (!r.why) r.why = why; r.ot = Shelly.getUptimeMs() / 1000; }   // ohne upS(): flacherer Stapel
  Shelly.call("Switch.Set", { id: 0, on: false }, cbNone);
}
function onSetResult(res, err, msg) {
  var p = R.ps, u, t;
  if (!err) return;
  u = nowU(); t = ("Einschalten abgelehnt: " + msg).slice(0, 60);
  R.ps = null; log(t);
  if (p && p.k !== "hand") R.want = { k: p.k, mm: p.mm, exp: p.exp || (u || 0) + 1800 };  // nochmal, bis zur Frist
                                          // des Starts (Automatik 2 h ab der Prüfung) und bis END_MIN
  if (S.ft !== t || !S.fo || !(u && S.fu > 1 && loc(S.fu).day === loc(u).day)) {   // wie eine Störung: Statuszeile,
    S.fu = u ? Math.floor(u) : 1; S.ft = t; S.fo = 1; flAdd("ab", msg); save();    // LED rot; je Tag einmal gespeichert
  }
}
// Startet eine eigene Gabe. Rückgabe null = gestartet, sonst Grund.
function startRun(kind, mm) {
  var now = upS(), st = R.sw;            // Relaisstatus dieses Takts
  if (R.ps && now > R.ps.until) R.ps = null;          // Befehl kam nie an
  if (R.run || st.output || R.ps) return "läuft";
  if (R.weld) return "Relais";
  if (R.lastStop && now - R.lastStop < C.MIN_OFF_S) return "Pause";
  if (startsLastHour(now) >= C.MAX_STARTS_H) return "Starts";
  var sec = secsFor(mm);
  if (sec < 60) return "kurz";
  Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: sec }, cbSafe, onSetResult);   // wirft er, bleibt R.ps leer
  R.ps = { k: kind, mm: sec * rate() / 3600, sec: sec, until: now + 15 };   // Ziel nach der Laufzeitgrenze
  return null;
}
function note(t) { R.note = t; R.noteU = Shelly.getUptimeMs() / 1000; log(t); }
function runBegin(st, gone) {            // gone: eigener Start, der nie als Lauf zu sehen war
  var now = upS(), p = R.ps, u = nowU(), kind, mm, sec, left = 0, el;
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
    el = 0;                               // lief schon, als das Skript startete: seit el s, nie länger als seit dem
    if (R.boot && st.timer_duration) el = (u && st.timer_started_at > C.T_MIN) ? lim(u - st.timer_started_at, 0, now) : now;
    if (R.boot && st.timer_duration && st.timer_duration < C.AUTO_OFF_S) {   // Hochfahren. Timer von Skript oder App:
      left = st.timer_duration - el;      // Skript neu gestartet während des Laufs, übernehmen, höchstens MAX_RUN_MIN
      sec = r0(lim(Math.min(left, C.MAX_RUN_MIN * 60 - el), 1, st.timer_duration));   // ab Beginn
      if (sec < left - 5) Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: sec }, cbNone);
      mm = sec * rate() / 3600;
    } else {                              // Taster oder App, auch gedrückt, bevor das Skript lief (dann mit dem Timer der
      mm = lim(u ? prov(loc(u)) : C.HAND_MIN_MM, C.HAND_MIN_MM, C.DOSE_MAX_MM);   // Notabschaltung): normale Gabe
      sec = r0(lim(Math.min(secsFor(mm), C.MAX_RUN_MIN * 60 - el), 1, C.MAX_RUN_MIN * 60));
      mm = sec * rate() / 3600;           // höchstens MAX_RUN_MIN ab Beginn, auch ohne Skript:
      Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: sec }, cbNone);     // der Firmware-Timer schaltet ab
    }
    R.want = null;                        // Handgabe ersetzt einen aufgeschobenen Automatiklauf
    if (S.rt) { S.rt = 0; save(); }       // und einen geplanten Nachlauf
  }
  R.starts.push(now);
  R.run = { k: kind, t0: now, lt: now, u0: u || 0, sec: sec, mm: mm, ps: 0, cr: 0, ck: now,
            pf: -1, u: 0, o: 0, n: 0, i: 0, why: "", det: "", ref: kind === "retry" ? S.rq : 0, rs: 0, rn: 0 };
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
function pLo() { return !S.pn ? C.P_ABS_DRY : (S.pc ? (S.pn + S.pc) / 2 : S.pn * C.UNDER_REL); }   // Untergrenze (W):
function pHi() { return S.pn ? S.pn * C.OVER_REL : C.P_ABS_OVER; }   // angelernt Mitte zu Hahn zu, sonst 75 %; Obergrenze
// Nicht angelernt dazu je Lauf: Bezug ist das Mittel der geglätteten Werte von 10 bis 20 s nach der Anlaufzeit (ohne
// Werte über der Obergrenze, die Leitung ist dann voll); danach gilt mindestens GAP_MIN darunter als Unterlast. So fällt
// ein Hahn auf, der im Lauf zugedreht wird, und ein Brunnen, der leer läuft; ein Nachlauf nach Unterlast behält den Bezug
// des Laufs davor. Ein Hahn, der schon vor dem Start zu ist, fällt nur mit Anlernen auf. Angelernt gelten nur die
// gemessenen Grenzen. Gespeichert und nachgeführt wird nichts [4]
function monitor(st) {
  var r = R.run, now = upS(), el = now - r.t0, dt = lim(now - r.lt, 0, 5);
  var P = nz(st.apower), I = nz(st.current), lo = pLo(), hi = pHi();   // kein Messwert: gilt als 0, also keinStrom
  r.lt = now;
  if (r.why) { if (!(now - r.ot < 5)) relayOff(r.why); return; }   // Abschaltung läuft: Aus alle 5 s wiederholen
  if (el > r.sec + 60) { relayOff("ende"); return; } // Firmware-Timer fehlte
  r.pf = r.pf < 0 ? P : r.pf + (P - r.pf) * 0.3;     // geglättet: Luft-Wasser-Gemisch flattert
  if (!S.pn && el >= C.BLANK_S + 10 && el < C.BLANK_S + 20 && !r.ref && r.pf <= hi) { r.rs += r.pf; r.rn++; }
  if (!S.pn && el >= C.BLANK_S + 20) { if (!r.ref && r.rn) r.ref = r.rs / r.rn; lo = Math.max(lo, r.ref * (1 - C.GAP_MIN)); }
  r.i = (el >= 2 && I > C.I_MAX) ? r.i + 1 : 0;
  if (r.i >= C.I_S) { trip("blockiert", f1(I) + " A"); return; }
  r.n = (el >= 3 && P < C.NOLOAD_W) ? r.n + 1 : 0;
  if (r.n >= C.NOLOAD_S) { trip("keinStrom", r0(P) + " W"); return; }
  r.o = (el >= C.BLANK_S && r.pf > hi) ? r.o + 1 : 0;
  if (r.o >= C.OVER_S) { trip("ueberlast", r0(r.pf) + " W > " + r0(hi) + " W"); return; }
  r.u = (el >= C.BLANK_S && P >= C.NOLOAD_W && r.pf < lo) ? r.u + 1 : 0;
  if (r.u >= C.UNDER_S) { trip("unterlast", r0(r.pf) + " W < " + r0(lo) + " W"); return; }
  if (r.pf >= lo) r.ps += dt;
  if (now - r.ck >= C.RUN_SAVE_S) { credit(r); save(); r.ck = now; }
}
var WHY = { unterlast: "Trockenlauf oder Hahn zu", ueberlast: "Überlast", blockiert: "Pumpe blockiert",
            keinStrom: "Pumpe zieht keinen Strom", start: "Pumpe lief nicht an" };   // Störungen; "ende", "aus" sind keine
var KIND = { auto: "Automatik", retry: "Nachlauf", hand: "Hand", kal: "Anlernen" };
var FLT = { fw: "Firmware-Schutz", ab: "Einschalten abgelehnt", rk: "Relais klebt", ka: "Anlernen abgebrochen" };
function flAdd(k, d) {                    // Störungsprotokoll im Flash: die letzten 5, auch nach Stromausfall zu sehen
  var u = nowU();                         // (Besuch vor Ort ohne Internet); Kürzel aus WHY oder FLT, Messwert dazu
  R.fl = R.fl.slice(-4); R.fn = true; save();
  R.fl.push((u && u < 1e10 ? String(Math.floor(u)) : "0000000000") + (R.est ? "~" : " ") + k + ":" + String(d || "").slice(0, 16));
}
function runEnd(st) {
  var r = R.run, now = upS(), u = nowU(), why = r.why, fw = st.errors && st.errors.length;
  R.run = null; R.lastStop = now;
  if (r.k === "kal") { R.cue = 0; R.lx = 1; }   // nach dem Anlernen: LED im Lauf wieder blau, das Ergebnis gleich zeigen
  credit(r);
  if (fw && (!WHY[why] || why === "start")) why = "fw";   // die Firmware hat abgeschaltet, auch beim Anlernen
  var fault = why === "fw" || !!WHY[why], fwe = fault && why === "fw" ? String(st.errors) : "";
  var txt = fault ? (fwe ? "Firmware-Schutz: " + fwe : WHY[why] + (r.det ? " (" + r.det + ")" : "")) : "";
  if (fault) { S.fu = u ? Math.floor(u) : 1; S.ft = txt.slice(0, 60); S.fo = 1; flAdd(why, fwe || r.det); }   // LED rot,
  else if (r.ps >= 60 && (r.k !== "kal" || why === "angelernt")) S.fo = 0;      // bis ein Lauf 1 min normal gepumpt hat
  if (r.k === "hand" || r.k === "kal") S.sh++; else S.sa++;                       // Saison, für die Diagnose
  if (r.k === "kal" && r.kp) {            // Anlernen unterbrochen (Taster, Störung, Firmware): nichts übernommen
    if (!fault) { flAdd("ka", "ausgeschaltet"); S.fu = u ? Math.floor(u) : 1; S.ft = "Anlernen abgebrochen: ausgeschaltet"; S.fo = 1; }
    R.sv = -1e9;
    note("Anlernen abgebrochen: " + (txt || "ausgeschaltet") + " – nichts übernommen");
  }
  S.sm = r1(S.sm + r.cr); if (fault) S.sf++;
  if (u) {
    var L = loc(u), L0 = loc(r.u0 || u);
    S.lr = dmy(L0.day) + " " + hm(L0.min) + " " + KIND[r.k] +
      " " + f1(r.cr) + " mm" + (fault ? " – abgebrochen" : "");
    if (fault && (r.k === "auto" || r.k === "retry")) {   // Hand und Anlernen kosten keinen Nachlauf der Automatik
      if (S.fd !== L.day) { S.fd = L.day; S.fc = 0; }
      S.fc++;
      var rem = r.mm - r.cr, maxR = why === "unterlast" ? C.RETRIES_DRY : 1;
      S.rt = 0;
      if (rem >= 2 && S.fc <= maxR) {
        S.rt = Math.floor(u) + (now - r.t0 < 10 ? C.RETRY_START_MIN : C.RETRY_MIN) * 60; S.rm = r1(rem);
        S.rq = why === "unterlast" ? r0(r.ref || 0) : 0;   // nach Unterlast den Bezug mitgeben: ist der Hahn beim
      }                                                     // Nachlauf noch zu, fällt es auf
    }
  }
  log("Pumpe aus: " + (why || "Ende/Stopp") + ", " + r1(r.cr) + " mm gegeben");
  save();
}
function weldCheck(st) {
  var now = upS(), P = nz(st.apower);
  if (R.lastStop && now - R.lastStop < 5) return;   // Messwert hinkt nach
  if (P > C.NOLOAD_W) {
    R.wc++;
    if (R.wc >= 5) {
      if (!R.weld) { log("Relais klebt? " + r0(P) + " W bei AUS"); flAdd("rk", r0(P) + " W"); save(); }
      R.weld = true;
      if (R.wc % 30 === 5) Shelly.call("Switch.Set", { id: 0, on: false }, cbNone);
    }
  } else { R.wc = 0; R.weld = false; }
}

// ============================== Anlernen per Taster ==============================
// Hahn offen, Stecker einstecken, 10 s warten, 5× drücken (ein, aus, ein, aus, ein) binnen 10 s, in der ersten Minute
// (das Skript startet rund 3 s nach dem Hochfahren und erkennt davor höchstens einen Druck); der 5. Druck startet das
// Anlernen. Normalleistung = Mittel von 5 bis 20 s nach der Anlaufzeit BLANK_S (Tauchpumpe: Sekunde 45 bis 60).
// Danach wird die LED weiß: jetzt den Hahn zudrehen. Kein
// Signal mit Aus und Ein: Ohne Rückschlagventil liefe die Pumpe dabei gegen die zurücklaufende Wassersäule an. Zieht die
// Pumpe bis 3 min nach dem Beginn 8 % weniger, gilt nach 10 s Beruhigung das Mittel der nächsten 10 s als Hahn-zu-Leistung.
// Liegt sie mindestens GAP_MIN unter der Normalleistung, kommt die Untergrenze in die Mitte (zu beiden Seiten 10 % Abstand
// oder mehr), sonst auf 75 %. Kein Nachführen. Übernommen wird nur am regulären Ende, auch ohne Zudrehen, unter P_ABS_DRY
// aber nur mit Hahn-zu-Messung (sonst womöglich Trockenlauf gelernt); Taster, Störung, Stromausfall oder unplausible
// Werte brechen ohne Übernahme ab. Den Timer von KAL_S hält die Firmware, auch wenn das Skript steht.
// Während des Anlernens prüft das Skript nur auf fehlenden Strom und Blockade, nicht auf Unter- und Überlast [4]
function onSt(ev) {                       // Status-Abo der ersten Minute nach dem Einstecken: zählt Relaiswechsel
  var d = ev ? ev.delta : null, t = upS(), a;
  if (!d || ev.component !== "switch:0" || typeof d.output !== "boolean" || d.output === R.ko) return;
  R.ko = d.output;                        // nur Drücke der ersten Minute zählen, nicht das eigene Aus des Skripts
  if (t > 60 || d.source === "loopback" || (R.run && R.run.why)) return;
  a = R.kts.slice(-4); a.push(t); R.kts = a;   // die letzten 5 Drücke: 5 binnen KAL_WIN_S, der 5. schaltet ein;
  R.kw = a.length === 5 && d.output && t - a[0] <= C.KAL_WIN_S ? 1 : 0;   // ein 6. hebt das auf
}
function kalStart() {                     // die Handgabe des 5. Drucks wird zum Anlernen
  var r = R.run;
  R.kw = 0; r.k = "kal"; r.kp = 1; r.kt = upS(); r.ks = 0; r.kn = 0; r.kl = 1e9; r.kh = 0; r.kn0 = 0;
  r.sec = C.KAL_S + C.BLANK_S - 40;       // längere Anlaufzeit (Jetpumpe): entsprechend länger
  Shelly.call("Switch.Set", { id: 0, on: true, toggle_after: r.sec }, cbNone);
  note("Anlernen: Hahn offen lassen; wird die LED weiß, Hahn zudrehen");
}
function kalSum(P) { var r = R.run; r.ks += P; r.kn++; if (P < r.kl) r.kl = P; if (P > r.kh) r.kh = P; }
function kalTick(st) {                    // Schritte 1 (Normalleistung), 2 (warten auf Zudrehen), 3 (Hahn zu messen)
  var r = R.run, now = upS(), el = now - r.kt, dt = lim(now - r.lt, 0, 5), P = nz(st.apower), I = nz(st.current), e = "";
  r.lt = now;
  if (r.why) { if (!(now - r.ot < 5)) relayOff(r.why); return; }   // Aus läuft: alle 5 s wiederholen
  r.i = (el >= 2 && I > C.I_MAX) ? r.i + 1 : 0;
  r.n = (el >= 3 && P < C.NOLOAD_W) ? r.n + 1 : 0;
  if (r.i >= C.I_S) trip("blockiert", f1(I) + " A");
  else if (r.n >= C.NOLOAD_S) trip("keinStrom", r0(P) + " W");
  else if (r.kp === 1) {                  // Messfenster nach der Anlaufzeit (Tauchpumpe 40 s: Sekunde 45 bis 60)
    r.ps += dt;
    if (el >= C.BLANK_S + 5) kalSum(P);
    if (el >= C.BLANK_S + 20) e = kalNormal();
  } else if (r.kp === 2) {                // el zählt weiter ab dem Beginn: bis 3 min wird auf das Zudrehen gewartet
    r.kd = P < r.kn0 * 0.92 ? r.kd + 1 : 0;
    if (!r.kd) r.ps += dt;
    if (r.kd >= 3) { r.kp = 3; r.kt = now; r.ks = 0; r.kn = 0; r.kl = 1e9; r.kh = 0; }
    else if (el >= C.BLANK_S + 140) e = kalEnd(0);
  } else if (r.kp === 3) {
    if (el >= 10) kalSum(P);
    if (el >= 20) e = kalEnd(1);
  }
  if (e) kalStop(e, r.kx);                // hier statt in kalNormal und kalEnd: flacherer Stapel
}
function kalNormal() {                    // 20 s nach der Anlaufzeit: Normalleistung prüfen; "" = gut, sonst der Grund (16
  var r = R.run, p = r.kn ? r.ks / r.kn : 0;   // Zeichen kommen ins Störungsprotokoll)
  if (p < C.P_LEARN_MIN) return r0(p) + " W zu wenig";
  if (p > C.P_LEARN_MAX) return r0(p) + " W zu viel";
  if (r.kh > r.kl * 1.15) return "unruhig " + r0(r.kl) + "-" + r0(r.kh) + " W, zu früh zugedreht oder Luft im Rohr?";
  r.kn0 = r0(p); r.kp = 2; r.kd = 0; R.cue = 1; R.lx = 1;   // LED im Lauf weiß, gleich in diesem Takt (ledUpdate)
  log("Anlernen: Normalleistung " + r.kn0 + " W, jetzt Hahn zudrehen (LED weiß)");
  return "";
}
function kalEnd(m) {                      // übernehmen und abschalten (m = Hahn zu gemessen); "" = übernommen, sonst
  var r = R.run, u = nowU(), p = r.kn ? r.ks / r.kn : 0, g = 1 - p / r.kn0, t = "", lo;   // der Grund zum Abbrechen
  if (!m) t = "Hahn nicht zugedreht";
  else if (r.kh > r.kl * 1.1) t = "Hahn zu unruhig";
  else if (g < C.GAP_MIN) t = "Hahn zu nur " + r0(g * 100) + " % weniger, nicht erkennbar";
  if (t && r.kn0 < C.P_ABS_DRY) {         // so wenig zieht auch eine trockenlaufende Pumpe: kleine Werte nur mit
    r.kx = "trocken? " + r.kn0 + " W";    // Hahn-zu-Messung, sonst lernte das Anlernen womöglich den Trockenlauf
    return t + "; unter " + C.P_ABS_DRY + " W nur mit Zudrehen (Trockenlauf?)";
  }
  S.pn = r.kn0; S.pc = t ? 0 : r0(p); S.kt = u ? Math.floor(u) : 1; save(); R.sv = -1e9;   // gleich schreiben, nicht erst
                                                                       // nach der Minute der Schreibbremse (Stecker gezogen?)
  lo = r0(pLo());
  t = (t ? t + ", " : "Hahn zu " + S.pc + " W, ") + "Untergrenze " + lo + " W";
  r.kp = 0; note("Angelernt: " + S.pn + " W, " + t);   // runEnd hebt eine offene Störung auf, die LED zeigt
  relayOff("angelernt");                                        // das gleich
  return "";
}
function kalStop(why, d) {                // abbrechen, nichts übernehmen; ins Störungsprotokoll für den Besuch vor Ort,
  var u = nowU();                         // als Störung: am Standort ohne App zeigt die LED so gleich, ob es geklappt hat
  R.run.kp = 0; flAdd("ka", d || why); R.sv = -1e9;
  S.fu = u ? Math.floor(u) : 1; S.ft = ("Anlernen abgebrochen: " + why).slice(0, 60); S.fo = 1;
  note("Anlernen abgebrochen: " + why + " – nichts übernommen");
  relayOff("abbruch");
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
  if (R.la === null) { bookEst(L); decide(L, null, false); return; }   // Ort noch unbekannt: wie ohne Internet
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
    if (!R.oa) R.oa = nowU() || 0;        // Beginn eines möglichen Ausfalls (für die Diagnose)
    R.wx.tries++;
    uw = nowU();                          // Ausfälle des Dienstes dauern oft bis 1 h: 4 Versuche im Abstand von 20 min
    if (R.wx.tries < ((R.est || R.off) ? 1 : 4) && uw && loc(uw).min + 21 < C.END_MIN) {
      R.wx.next = upS() + 1200; return;
    }
    setOff(true);
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
  setOff(false);
  decide(L, today(j, n, o.current), false);
}
// Frost sperrt nicht den ganzen Tag: Nach einer Frostnacht gießt die Automatik, sobald die Luft FROST_THAW_C hat
// (Nachprüfung stündlich bis END_MIN). Eine noch gefrorene Leitung wirkt wie ein zugedrehter Hahn: Unterlast [4].
// Bei der Nachprüfung bleibt die Frostnacht von 10:00 stehen, neu sind nur die Luft und die Regenprognose.
function decide(L, w, rc) {               // w = Prognose heute oder null (ohne Internet); rc = Nachprüfung
  var D = prov(L), rainExp = 0, dose = 0, t = nowU(), nm = L.min, fr = null, est = false, air, z, fD, fF, fR, hn, hE, pz, g,
      cut, gt, rx, rf, rh, k = rc && S.rc === L.day ? S.rk : 0;  // k: Grund der Nachprüfung: 1 Frost (Prognose),
                                                                 // 3 Frost (geschätzt), 2 Regen
  if (t) nm = loc(t).min;
  R.wx.tries = 0;
  if (R.run) { save(); return; }          // Handgabe läuft: geprüft wird danach, der Tag bleibt offen
  z = S.ev < 0 ? null : cfd(S.ev);
  if (!z || !inSeason(z) || L.day - S.ev > 60) {   // erste Prüfung der Saison: Zähler der Diagnose neu
    S.s0 = L.day; S.sa = 0; S.sh = 0; S.sm = 0; S.sf = 0;
  }
  S.ev = L.day; S.rc = -1; S.rk = 0;
  if (k === 1 || k === 3) { fr = S.rf; est = k === 3; }
  else if (w && w.tmin !== null) fr = w.tmin < C.FROST_C ? w.tmin : null;   // Frostnacht laut Prognose
  else {                                  // sonst Gerätefühler, auch wenn der Wert fehlt
    fr = frostEst();
    if (fr !== null) { if (fr >= C.FROST_OFF_C) fr = null; else est = true; }
  }
  air = (w && w.tnow !== null) ? w.tnow : airNow();                       // Luft jetzt
  // Texte und Rechnungen vorab, die Zweige setzen nur noch: der Stapel des Shelly ist klein
  fD = f1(D); fF = fr === null ? "" : f1(fr); fR = w ? f1(w.rain) : "";
  hn = hm(nm); hE = hm(C.END_MIN); pz = S.pu ? dmy(S.pu) : "";
  if (w && w.prob >= C.RAIN_PROB_MIN && !R.nf) rainExp = Math.max(0, w.rain - C.RAIN_LOSS_MM);
  g = Math.min(C.DOSE_MAX_MM, D - rainExp);                  // Gabe, falls gegossen wird (letzter Zweig)
  cut = rainExp > 0 && g < Math.min(C.DOSE_MAX_MM, D);       // die Prognose kürzt sie
  gt = secsFor(g) * rate() / 3600; gt = f1(gt);              // Menge nach der Laufzeitgrenze (MAX_RUN_MIN)
  rx = r1(rainExp); rf = fr === null ? 0 : r1(fr);
  rh = (Math.floor(nm / 60) + 1) * 60 + 5;                   // Nachprüfung 5 min nach der nächsten vollen Stunde
  if (!autoOn()) R.why = "Automatik aus";
  else if (paused(L)) R.why = "Pause bis " + pz;
  else if (D < C.TRIGGER_MM) R.why = "nicht nötig (" + fD + " mm)";
  else if (fr !== null && !(air >= C.FROST_THAW_C)) {
    R.why = "Frostsperre (" + (est ? "geschätzt " : "") + fF + " °C), gießt ab " + C.FROST_THAW_C + " °C";
    S.rc = L.day; S.rk = est ? 3 : 1; S.rf = rf; R.rh = rh;
  }
  else {
    dose = g;
    if (cut) { S.rd = L.day; S.rx = rx; }
    else if (S.rd === L.day) S.rd = -1;   // volle Gabe, etwa nach Absage bei der Nachprüfung
    if (dose < C.DOSE_MIN_MM && rainExp > 0) {
      R.why = "Regen erwartet (" + fR + " mm, " + w.prob + " %)" + (k === 2 ? ", " + hn + " bestätigt" : "");
      S.rc = L.day; S.rk = 2; R.rh = rh;  // stündlich nachsehen
    } else if (dose < C.DOSE_MIN_MM) R.why = "nicht nötig (" + fD + " mm)";   // nur wenn TRIGGER_MM < DOSE_MIN_MM
    else if (nm >= C.END_MIN) { R.why = hE + " vorbei, nicht mehr gestartet"; dose = 0; }
    else R.why = (k === 2 ? "Regen abgesagt, " : (k ? "Frost vorbei, " : "")) + "gegossen " + gt + " mm" +
      (R.nf ? " (gestern Regen ausgeblieben)" : "");
  }
  log("Tagesprüfung: Defizit " + r1(D) + " mm" + (w ? "" : " (ohne Internet)") + " -> " + R.why);
  if (dose >= C.DOSE_MIN_MM) R.want = { k: "auto", mm: dose, exp: (t || 0) + 7200 };   // startet schedule(), noch im
  save();                                 // selben Durchgang oder binnen 30 s: so bleibt der Stapel hier flach
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
function defTime() {                      // ohne Anker und ohne Zeitserver: Einstecken gilt als 1. April, START_MIN [5]
  var s = Shelly.getComponentStatus("sys"), t = dfc(2026, 4, 1) * 86400 + C.START_MIN * 60 - (C.UTC_H + 1) * 3600;
  R.defAt = 0;
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN) return;
  R.def = true; R.est = true; R.eb = t; R.eu = upS(); S.df = 1; S.ce = 1; S.cs = t;
  Shelly.call("Sys.SetTime", { unixtime: t }, cbNone);
  log("Uhrzeit unbekannt – Einstecken gilt als 1. April " + hm(C.START_MIN));
  save();
}
function geo() {                          // Ortsname -> Koordinaten (Open-Meteo), einmal, dann gespeichert;
  R.gn = upS() + 900;                     // Postleitzahlen kennt der Dienst nicht, Ortsnamen schon
  Shelly.call("HTTP.GET", { url: "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + R.oq +
    "&countryCode=" + C.LAND, timeout: 20 }, cbSafe, onGeo);   // R.oq = uenc(C.ORT), einmal in init
}
function uenc(t) {                        // für die URL: UTF-8 mit Prozentzeichen (Umlaute, ß, Leerzeichen; bis U+07FF)
  var o = "", i = 0, c, d, b, x = "0123456789ABCDEF";   // auf dem Gerät sind Umlaute schon UTF-8-Bytes (tools/build.js)
  while (i < t.length) {                  // while, keine innere Schleife: kostet weniger Stapel
    c = t.charCodeAt(i); d = t.charCodeAt(i + 1); b = -1;
    if ((c > 47 && c < 58) || (c > 64 && c < 91) || (c > 96 && c < 123)) o += t.charAt(i);
    else if (c < 128) o += "%" + x.charAt(c >> 4) + x.charAt(c & 15);
    else if (c > 193 && c < 224 && d > 127 && d < 192) { b = d; i++; }      // schon UTF-8-Bytes
    else { b = 128 | (c & 63); c = 192 | (c >> 6); }                        // Zeichen -> UTF-8
    if (b >= 0) o += "%" + x.charAt(c >> 4) + x.charAt(c & 15) + "%" + x.charAt(b >> 4) + x.charAt(b & 15);
    i++;
  }
  return o;
}
function onGeo(res, err, msg) {
  var j = null, g;
  try { if (!err && res && res.code === 200) j = JSON.parse(res.body); } catch (e) { j = null; }
  if (!j) return;                         // Dienst nicht erreichbar: in 15 min nochmal
  g = j.results && j.results[0];
  if (!g) {                               // Name unbekannt: Statuszeile und LED melden es, in 15 min nochmal
    if (!R.gx) log("Ort " + C.ORT + " nicht gefunden – Schreibweise prüfen oder LAT/LON eintragen");
    R.gx = true; return;
  }
  if (!fin(g.latitude) || !fin(g.longitude) || Math.abs(g.latitude) > 90 || Math.abs(g.longitude) > 180) return;
  R.gx = false; R.la = S.la = r2(g.latitude); R.lo = S.lo = r2(g.longitude); S.pz = C.LAND + C.ORT; save();
  log("Ort " + C.ORT + ": " + R.la + ", " + R.lo);
}
function setOff(v) {                      // Wetterdienst weg oder zurück; für die Diagnose den letzten Ausfall merken
  var u = nowU();                         // (Beginn = erster gescheiterter Versuch); gespeichert wird danach ohnehin
  if (v && !R.oa) R.oa = u || 0;
  if (v && !R.off) R.pbNext = upS() + 900; // eben gescheitert: Verbindungstest erst in 15 min
  if (!v) {
    if (R.off && R.oa && u) { S.io = Math.floor(R.oa); S.id = Math.max(0, r0((u - R.oa) / 60)); R.ie = R.est; }
    R.oa = 0;
  }
  R.off = v; S.os = v ? Math.floor(R.oa) || 1 : 0;   // offener Ausfall: nach einem Neustart weiter gelb, Test läuft weiter
}
function shiftDays(k) {                   // die Annahme 1. April war falsch: Tagesmarken mitverschieben [5]
  if (S.ev >= 0) S.ev += k;
  if (S.dp >= 0) S.dp += k;
  if (S.fd >= 0) S.fd += k;
  if (S.pu) S.pu += k;
  if (S.xa >= 0) S.xa += k;
  if (S.rd >= 0) S.rd += k;
  if (S.rc >= 0) S.rc += k;
  if (S.fu > 1) S.fu += k * 86400;
  if (S.io && !R.ie) S.io += k * 86400;   // mit geschätzter Uhr erfasst: verschiebt oaShift genau
  if (S.s0 > 0) S.s0 += k;
  S.rt = 0; S.df = 0; R.td = null; R.ty = null; R.z = null;
  log("Echte Uhrzeit da: Tagesmarken um " + k + " Tage verschoben");
}
function schedule() {
  var h = R.kh;                           // Anlern-Geste nur in der ersten Minute; erst zurücksetzen, dann abmelden:
  if (h >= 0 && upS() > 62) { R.kh = -1; R.kw = 0; Shelly.removeStatusHandler(h); }   // wirft das, nur einmal
  if (R.defAt && upS() >= R.defAt) defTime();
  if (upS() >= R.cfgAt) { R.cfgAt = upS() + 3600; applyCfg(); watchdog(); }   // stündlich: Notabschaltung, Zeitpläne
  if (!R.h && upS() - R.hb >= (R.hn < 10 ? 60 : 3600)) vcStart();          // Bedienfeld fehlt: nochmal versuchen
  if (!R.h) panelRead();                  // bis dahin Automatik und Regenrate aus dem Gerätestatus
  if (R.la === null && upS() >= R.gn) geo();                    // Ort noch unbekannt: alle 15 min fragen
  var u = nowU();
  if (!u) return;
  var L = loc(u), now = upS();
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
  if (R.off && R.la !== null && !R.wx.busy && now >= R.pbNext) {   // Wetterdienst wieder da? alle 15 min, solange er fehlt
    R.pbNext = now + 900;                 // vor dem Aufruf: wirft er, kommt der nächste Versuch trotzdem erst in 15 min
    Shelly.call("HTTP.GET", { url: "https://api.open-meteo.com/v1/forecast?latitude=" + R.la + "&longitude=" + R.lo +
      "&daily=temperature_2m_min&timezone=auto&forecast_days=1", timeout: 10 }, cbSafe, onProbe);
  }
  if (S.pu && L.day > S.pu) { S.pu = 0; save(); }
  if (R.run && (R.run.k === "auto" || R.run.k === "retry") && (!autoOn() || paused(L))) relayOff("aus");   // Automatik
                                                                                    // aus: ihren Lauf beenden
  var wt = R.est && now < C.NTP_WAIT_S;  // eben hochgefahren, Uhr nur geschätzt: erst auf den Zeitserver warten
  var ins = inSeason(L), ok = !wt && L.min >= C.START_MIN && L.min < C.END_MIN && ins;   // Automatik nur dann; früher
  if (!wt && S.ev !== L.day && L.min >= C.START_MIN && L.min < C.END_MIN && !R.wx.busy && now >= R.wx.next && !R.run && !R.ps) {
    evaluate(L);                          // am Tag warten Nachprüfung, aufgeschobener Start und Nachlauf bis START_MIN
  }                                       // (Uhr zurückgestellt, Neustart); außerhalb der Saison entfallen sie
  if (ok && S.rc === L.day && L.min >= R.rh && !R.wx.busy && !R.run && !R.ps) {
    R.rh = (Math.floor(L.min / 60) + 1) * 60 + 5;        // klappt der Abruf nicht: nächste Stunde
    if (R.off || R.la === null) decide(L, null, true); else fetchWx(L, 0, true);   // ohne Wetter: Frost nach Gerätefühler
  }
  if (R.want && !wt) {
    if (u > R.want.exp || !autoOn() || L.min >= C.END_MIN || !ins) R.want = null;
    else if (ok && !startRun(R.want.k, R.want.mm)) { R.ps.exp = R.want.exp; R.want = null; }
  }
  if (S.rt && u >= S.rt && !R.run && !wt) {   // gespeicherter Nachlauf: nach dem Hochfahren ebenso erst den Zeitserver
    if (L.min >= C.END_MIN || !autoOn() || paused(L) || S.fd !== L.day || !ins) { S.rt = 0; save(); }
    else if (ok && !startRun("retry", S.rm)) { S.rt = 0; save(); }
  }
}
function onProbe(res, err, msg) { if (!err && res && res.code === 200 && R.off) { setOff(false); save(); } }
// Alle Hinweise an einer Stelle: LED, Statuszeile und Diagnose zeigen dasselbe. e = Störung (rot), w = Hinweise (gelb)
function checks(L) {
  var w = [], h = hm(C.START_MIN);
  if (!L) w.push("Uhrzeit unbekannt");
  else if (R.def) w.push("Uhr angenommen: Einstecken = " + h);
  else if (R.est) w.push("Uhr geschätzt");
  if (R.la === null) w.push("Ort " + (R.gx ? C.ORT + " nicht gefunden" : "unbekannt"));
  else if (R.off) w.push("ohne Internet");   // ohne Ort gibt es kein Wetter, egal ob Internet
  if (R.noStore) w.push("Speicher schreibt nicht");   // auch rot: am Standort ist die LED ohne Internet ohnehin gelb
  return { e: R.weld ? "Relais klebt" : (R.noStore ? "Speicher schreibt nicht" : (S.fo ? "Störung: " + S.ft : "")), w: w };
}
function statusText(L) {                 // Texte vorab in eigenen Anweisungen: der Stapel des Shelly ist klein
  var r = R.run, t, i, c, f = S.fu > 1 ? loc(S.fu) : null, n = S.rt ? loc(S.rt) : null, now = Shelly.getUptimeMs() / 1000,
      hs = hm(C.START_MIN), he = hm(C.END_MIN), pz = S.pu ? dmy(S.pu) : "", fm = f ? hm(f.min) : "", a, b;
  if (R.weld) return "ALARM: Pumpe zieht Strom trotz AUS – Relais klebt? Stecker ziehen!";
  if (r) {
    t = r.sec - (now - r.t0); a = f1(r.mm); b = Math.round(t / 60); c = Math.round(R.sw.apower || 0);
    if (r.k === "kal") return "Anlernen: " + (r.kp === 1 ? "Hahn offen lassen, Normalleistung messen" :
      (r.kp === 2 ? "LED weiß: jetzt Hahn zudrehen" : (r.kp === 3 ? "Hahn-zu-Leistung messen" : "wird beendet"))) + ", " + c + " W";
    return "Beregnung (" + KIND[r.k] + "): " + a + " mm, noch " + (b > 0 ? b : 0) + " min, " + c + " W";
  }
  if (!L) return "Uhrzeit unbekannt – Automatik wartet auf Internet. Taster geht.";
  if (S.fo && (!f || f.day === L.day)) {    // Störung heute; ältere stehen hinten, bis ein Lauf fehlerfrei war
    b = n ? hm(n.min) : "";
    t = "Störung" + (f ? " " + fm : "") + ": " + S.ft;
    a = S.ev !== L.day && L.min < C.END_MIN ? "heute " : "morgen ";   // Störung vor der Tagesprüfung: heute
    t += n ? ". Nachlauf " + b : (R.want ? ". Neuer Versuch bis " + he : ". Nächster Versuch " + a + hs);
  } else if (!inSeason(L)) t = "Winterpause bis 01." + p2(C.SEASON_FROM) + ". – Taster geht";
  else if (!autoOn()) t = "Automatik aus – Taster geht";
  else if (paused(L)) t = "Pause bis " + pz;
  else if (S.ev === L.day) t = "Heute: " + (R.why || "geprüft");
  else if (L.min < C.START_MIN) t = "Bereit, Prüfung " + hs;
  else t = L.min < C.END_MIN ? "Prüfung läuft" : "Heute nicht geprüft, nächste Prüfung morgen " + hs;
  if (S.fo && f && f.day !== L.day) { a = dmy(f.day); t += " · Störung " + a + " " + fm + ": " + S.ft; }
  c = checks(L).w;                        // Hinweise vor den Infos: gekürzt wird hinten
  for (i = 0; i < c.length; i++) t += " · " + c[i];
  if (S.lr) t += " · Zuletzt " + S.lr;
  if (R.note && now - R.noteU > 43200) R.note = "";
  if (R.note) t += " · " + R.note;
  else if (S.pn) t += " · Pumpe angelernt " + S.pn + " W";
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
    try { R.h.re.off(R.hr); R.hr = -1; } catch (e2) { /* Knopf schon weg: sein Abo bleibt womöglich, nicht neu anmelden */ }
    R.h = null; R.hn = 0; R.hb = 0; R.paShown = -1; R.lastTxt = ""; R.lastD = -1; panelRead();
  }
}
function uiSet(L) {
  var t, d, pv, a;
  panelRead();
  pv = R.h.pa.getValue();
  if (L && fin(pv) && R.paShown >= 0 && pv !== R.paShown) {  // Pause im Bedienfeld geändert (0 bis 14 Tage)
    pv = r0(lim(pv, 0, 14)); S.pu = pv > 0 ? L.day + pv - 1 : 0; S.rt = 0; R.want = null; save();
    a = pv > 0 ? dmy(S.pu) : "";
    log("Pause " + (pv > 0 ? "bis " + a : "aufgehoben"));
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
  var c = Shelly.getComponentConfig("plugs_ui"), o, n, k;
  R.led = "?"; R.ledOn = "?";
  if (!c || !c.leds || c.leds.mode !== "switch" || !c.leds.colors || !c.leds.colors["switch:0"]) return;
  o = c.leds.colors["switch:0"].off; n = c.leds.colors["switch:0"].on;
  for (k in LED) if (k !== "run" && k !== "cue" && o && same(o.rgb, LED[k]) && o.brightness === 100) R.led = k;   // alte
  if (n && same(n.rgb, LED.run) && n.brightness === 100) R.ledOn = "run";   // Helligkeit: neu setzen; noch weiß von
}                                                                           // einem unterbrochenen Anlernen: zurück
function ledOf(c) { return c.e ? "err" : (c.w.length ? "warn" : "ok"); }   // Farbe zu den Hinweisen (checks)
function ledUpdate(L) {                    // jede Farbe ist ein Flash-Schreibvorgang: rot nach 2 min Bestand, jede
  var want = ledOf(checks(L)), on = R.cue ? "cue" : "run", now = upS(), a = [], i;                 // andere erst nach
  if (want !== R.ledWant) { R.ledWant = want; R.ledSince = now; }                                  // 30 min; höchstens
  if (want === R.led && on === R.ledOn) { R.lx = 0; return; }                                      // 12 am Tag; das
  if (!R.lx && now - R.ledSince < (want === "err" || R.led === "?" || R.ledOn === "?" ? 120 : 1800)) return;   // Anlernen
  for (i = 0; i < R.ledN.length; i++) if (now - R.ledN[i] < 86400) a.push(R.ledN[i]);              // (Weiß, Ergebnis)
  R.ledN = a;                                                                                      // gleich
  if (a.length >= 12 && want !== "err" && !R.lx) return;   // Rot nie zurückhalten: vor jedem Rot steht ein gedeckelter
  Shelly.call("PLUGS_UI.SetConfig", { config: { leds: { mode: "switch", colors: { "switch:0": {   // Wechsel; das Anlernen
    on: { rgb: LED[on], brightness: 100 }, off: { rgb: LED[want], brightness: 100 } } } } } }, cbSafe, onLed);   // braucht
  R.led = want; R.ledOn = on; R.ledN.push(now); R.nl++; R.lx = 0;   // die Geste: erst nach dem Aufruf, wirft er, kommt
}                                                                    // der nächste Versuch
function onLed(res, err, msg) {           // nicht geklappt: in 1 h nochmal (höchstens 12 Versuche am Tag)
  if (err) { log("LED nicht gesetzt: " + msg); R.led = "?"; R.ledOn = "?"; R.ledSince = upS() + 3480; }
}
// ============================== Diagnose ==============================
// Im Browser http://<IP>/script/<id>/info; hat der Shelly ein Gerätepasswort, fragt der Browser nach der Anmeldung
// (Benutzer admin). Die Seite entsteht erst beim Aufruf und ändert nichts. Das Aufspielwerkzeug zeigt sie per info().
function when(u) { var L = loc(u); return dmy(L.day) + L.y + " " + hm(L.min); }
function fwVer() { try { var d = Shelly.getDeviceInfo(); return (d && d.ver) || "?"; } catch (e) { return "?"; } }
function dur(s) {
  var m = Math.round(s / 60), h = Math.round(m / 60), d = Math.round(m / 1440);
  return m < 120 ? m + " min" : (m < 2880 ? h + " h" : d + " Tage");
}
var LEDN = { ok: "grün", warn: "gelb", err: "rot" };
function info() {                         // alle Aufrufe vorab, der Text danach (Stapel)
  var u = nowU(), L = u ? loc(u) : null, c = checks(L), now = Shelly.getUptimeMs() / 1000, i, n, t, k = ledOf(c),
      st = statusText(L), cw = c.w.join(", "), w0 = u ? when(u) : "– Uhrzeit unbekannt", wf = S.fu > 1 ? when(S.fu) + " " : "",
      s0 = S.s0 > 0 ? dmy(S.s0) : "-", sm = f1(S.sm), bk = L ? prov(L) : S.d, ob = S.ob > -50 ? f1(S.ob) : "-",
      oa = S.oa > -50 ? f1(S.oa) : "-", wo = R.off && R.oa ? when(R.oa) : "", io = S.io ? when(S.io) : "",
      di = S.io ? dur(S.id * 60) : "", fw = fwVer(), an = u ? when(u - now) : "?", dn = dur(now),
      t0 = R.t0 > C.T_MIN ? when(R.t0) : "", ds = dur(now - R.s0), lo = r0(pLo()), hi = r0(pHi()),
      kt = S.kt > 1 ? " " + when(S.kt) : "";
  bk = f1(bk);
  t = "Bewässerung " + w0 + "\n\nStatus: " + st +
    "\nLED: " + (LEDN[R.led] || "noch nicht gesetzt") + (k !== R.led ? ", wechselt bald auf " + LEDN[k] : "") +   // [3]
    " – " + (c.e || cw || "alles in Ordnung") +
    "\nLetzte Störung: " + (S.ft ? wf + S.ft + (S.fo ? " (offen)" : " (erledigt)") : "keine") +
    "\nLetzter Lauf: " + (S.lr || "keiner") +
    "\nSaison seit " + s0 + ": Automatik " + S.sa + ", Hand " + S.sh + ", zusammen " + sm + " mm, Störungen " + S.sf +
    "\nPumpe: " + (S.pn ? "angelernt" + kt + ", normal " + S.pn + " W, Hahn zu " + (S.pc ? S.pc + " W" : (S.kt ? "nicht erkannt" : "nicht gemessen")) :
      "Voreinstellung, nicht angelernt") + "; Untergrenze " + lo + " W, Obergrenze " + hi + " W" +
    "\nBodenkonto " + bk + " mm, Eigenwärme Fühler Nacht/Tag " + ob + " / " + oa + " K" +
    "\nUhr: " + (!u ? "unbekannt" : (R.def ? "angenommen" : (R.est ? "geschätzt" : "Zeitserver"))) +
    "\nInternet: " + (R.off ? "Wetterdienst fehlt" + (R.oa ? " seit " + wo : "") :
      (R.la === null ? "ohne Ort kein Wetterabruf" : "ok")) +
    (S.io ? ", letzter Ausfall " + io + ", " + di : "") +
    "\nOrt: " + C.ORT + (R.la === null ? (R.gx ? " nicht gefunden" : " noch unbekannt") : " " + R.la + ", " + R.lo) +
    "\nGerät: Firmware " + fw + ", an seit " + an + " (" + dn + ")" +
    (R.t0 > C.T_MIN ? ", davor zuletzt gespeichert " + t0 : "") + "; Skript läuft seit " + ds +
    "\nFlash-Schreibvorgänge seit Skriptstart: Speicher " + R.nw + ", Einstellungen " + R.nc + ", LED " + R.nl +
    "\n\nStörungen (gespeichert, neueste zuerst):" + (R.fl.length ? "" : " keine");
  i = R.fl.length - 1;
  while (i >= 0) { t += flLine(R.fl[i]); i--; }
  t += "\n\nLetzte Meldungen (seit Skriptstart):";
  n = R.lg.length; i = 1;                 // neueste zuerst; while statt for: kostet weniger Stapel
  while (i <= n) { t += lgLine(R.lg[(R.li - i + n) % n]); i++; }
  return t;
}
function flLine(g) {                      // Eintrag im Störungsprotokoll -> Zeile; ~ = Uhr war geschätzt
  var u = Number(g.slice(0, 10)), j = g.indexOf(":"), k = g.slice(11, j), d = g.slice(j + 1), w = u > 1 ? when(u) : "";
  return "\n" + (w ? (g.charAt(10) === "~" ? "~" : "") + w : "Zeit unbekannt") + " " + (WHY[k] || FLT[k] || k) +
    (d ? " (" + d + ")" : "");
}
function lgLine(g) {                      // Meldung aus log() -> Zeile; ~ = Uhr war geschätzt
  var u = Number(g.slice(0, 10)), L = u ? loc(u) : null, d = L ? dmy(L.day) : "", h = L ? hm(L.min) : "";
  return "\n" + (L ? d + (g.charAt(10) === "~" ? " ~" : " ") + h : "--.-- --:--") + " " + g.slice(11);
}
function onInfo(req, res) {               // ein Fehler hier darf das Skript nicht beenden
  try { res.body = info(); res.code = 200; } catch (e) { res.body = "Fehler: " + e; res.code = 500; }
  try { res.headers = [["Content-Type", "text/plain; charset=utf-8"]]; res.send(); } catch (e2) { log("Diagnose-Seite: " + e2); }
}

function tick() {
  var st;
  R.k++;
  try {
    st = sw(); swKeep(st); R.u = nowU() || 0;   // Stand dieses Takts für alle tieferen Aufrufe
    if (R.kw && R.run && R.run.k === "hand" && st.output) kalStart();   // 5 Drücke: diese Handgabe wird zum Anlernen
    if (st.output && !R.run) runBegin(st);
    else if (!st.output && R.run) runEnd(st);
    else if (st.output && R.run && R.run.k === "kal") kalTick(st);
    else if (st.output && R.run) monitor(st);
    else if (R.ps && upS() > R.ps.until) {   // eigener Start nie zu sehen: Firmware schaltete binnen 1 s ab (Anlaufstrom?)
      runBegin(st, 1); R.run.why = "start"; runEnd(st);   // oder Befehl verloren: als Störung werten, sonst bliebe R.ps stehen
    }
    if (!st.output) weldCheck(st);
    R.boot = false;
  } catch (e) { log("Fehler Takt: " + e); }
  // Wetter-Rückruf kam nie: wie ein Fehlschlag. Hier oben statt in schedule (Stapel); onWx fängt seine Fehler selbst
  if (R.k % 30 === 1 && R.wx.busy && upS() - R.wx.t > 60) onWx(null, -1, "keine Antwort", R.wx.q);
  if (R.k % 30 === 1) { try { schedule(); } catch (e2) { log("Fehler Plan: " + e2); } }
  if (R.k % 10 === 2 || R.lx) { try { ui(); } catch (e3) { R.lx = 0; log("Fehler Anzeige: " + e3); } }   // Anlernen:
                                                                                                         // LED gleich
  try { flush(); } catch (e4) { log("Fehler Speicher: " + e4); }   // was save() vorgemerkt hat, gebremst [5]
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
  if (need) { Shelly.call("Switch.SetConfig", { id: 0, config: want }, cbNone); R.nc++; log("Relais-Sicherung nachgestellt"); }
}                                         // Sicherung: nie gebremst; die Meldung zeigt, wenn ein Wert nicht hält
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
    c = (jobs[i] && jobs[i].calls) || [];
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
function init() {                         // erst, was ohne Firmware-Aufruf geht: wirft ein Aufruf (RPC-Grenze), fehlen
  var s, up;                              // Diagnose-Seite und Anlern-Geste nicht; die Einstellungen holt schedule() nach
  swKeep(sw()); R.u = nowU() || 0; R.oq = uenc(C.ORT);
  if (typeof C.LAT === "number" && typeof C.LON === "number") { R.la = C.LAT; R.lo = C.LON; }   // Ort eingetragen
  else if (S.la !== null) { R.la = S.la; R.lo = S.lo; }                                        // Ort gespeichert
  R.t0 = S.t; R.s0 = upS();               // für die Diagnose
  if (S.os) { R.off = true; R.oa = S.os > 1 ? S.os : 0; }   // Wetterdienst fehlte schon vor dem Neustart
  s = Shelly.getComponentStatus("sys"); up = upS();
  ledInit();
  try { HTTPServer.registerEndpoint("info", onInfo); } catch (e) { log("Diagnose-Seite fehlt: " + e); }
  if (up < 60) {                          // gerade eingesteckt: 5× drücken startet das Anlernen; schon an = vor dem
    try { R.ko = !!sw().output; R.kts = R.ko ? [up] : []; R.kh = Shelly.addStatusHandler(onSt); }   // Skriptstart gedrückt,
    catch (e2) { log("Anlern-Geste fehlt: " + e2); }                                           // das zählt als 1. Druck
  }
  if (S.wu > 0 && up >= S.wu) { R.sv = S.wu; R.wn = S.wn; R.w24 = Math.min(S.wb, up); }   // Skript-Neustart: Bremse zählt weiter
  if (s && typeof s.unixtime === "number" && s.unixtime > C.T_MIN && (!S.ce || up < S.tu || ntpSet())) {   // echte Zeit
    if (S.ce || S.df) {                    // Zeitserver hat gestellt, bevor das Skript lief
      if (S.df === 1) shiftDays(loc(s.unixtime).day - loc(S.t).day);
      S.ce = 0; save();
    }
  } else if (S.t > C.T_MIN) {              // Zeitanker: untere Schranke, nie zu früh; nach Skript-Neustart genau
    R.eb = S.t + (up >= S.tu ? up - S.tu : up); R.eu = up; R.est = true; R.def = S.df === 1; R.u = nowU() || 0;
    if (S.ce !== 1 || up < S.tu || !(s && s.unixtime > C.T_MIN)) {   // nach einem Skript-Neustart läuft die
      S.ce = 1; S.cs = Math.floor(R.eb);                              // gestellte Geräteuhr weiter: nichts zu schreiben
      log("Uhr aus Zeitanker geschätzt"); save();
      Shelly.call("Sys.SetTime", { unixtime: S.cs }, cbNone);
    }
  } else R.defAt = up + 120;               // kein Anker: 2 min auf den Zeitserver warten
  applyCfg(); watchdog(); R.cfgAt = up + 3600;   // danach stündlich aus schedule(); wirft ein Aufruf, bleibt R.cfgAt 0
}
function start() {                        // ein Fehler beim Start hält den Takt nicht auf: ohne Takt liefe eine
  load();                                 // Handgabe ohne Leistungsüberwachung; load() fängt seine Fehler selbst
  try { init(); } catch (e) { log("Fehler Start: " + e); }
  try { vcStart(); } catch (e2) { log("Fehler Bedienfeld: " + e2); }   // eigener Schritt: flacherer Stapel
  Timer.set(1000, true, tick);
  log("gestartet, Bodenkonto " + r1(S.d) + " mm, Pumpe " + (S.pn ? "angelernt " + S.pn + " W" : "Voreinstellung"));
}
start();
