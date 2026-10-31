# Shelly-Bewässerung mit Brunnenpumpe

Ein Skript für den **Shelly Outdoor Plug S Gen3**: Der Stecker schaltet eine Brunnen- oder Gartenpumpe und gießt den Rasen nach seinem tatsächlichen Wasserbedarf. Den Bedarf rechnet er aus Wetterdaten von Open-Meteo nach FAO-56. Die Pumpe schützt er über ihre gemessene Leistung. Strom- und Internetausfälle übersteht er ohne Hilfe.

*English summary: Shelly Gen3 script that irrigates a lawn with a well pump based on a FAO-56 soil water balance (Open-Meteo weather), protects the pump by power monitoring, and keeps working offline. Comments and docs are in German.*

## Was es kann

- **Gießt nach Bedarf.** Jeden Tag um 10:00 bucht es Verdunstung und Regen aufs Bodenkonto. Ab 8 mm Defizit gibt es 5–15 mm.
  - Angekündigter Regen zählt mit.
  - Nach einer Frostnacht wartet es, bis die Luft 5 °C hat.
  - Haben Regen oder Frost die Gabe verhindert, schaut es um 11:05 und 12:05 nochmal nach. Nach 12:30 startet keine Automatik mehr.
- **Schützt die Pumpe.** Es erkennt über die Leistung Trockenlauf, einen zugedrehten Hahn, Blockade, eine fehlende Last und ein klebendes Relais.
  - Die Normalleistung lernt es beim ersten Lauf selbst.
  - Nach einer Störung beim Anlauf startet es nach 6 min einen zweiten Versuch, nach anderen Störungen nach 60 min.
  - Eine Handgabe endet nach spätestens 90 min, auch wenn das Skript danach stehen bleibt: eine zweite Grenze, falls ein zugedrehter Hahn unerkannt bleibt. Drückt man, während das Skript steht, kürzt es den Lauf beim nächsten Start auf 90 min ab Beginn.
  - Unabhängig vom Skript schaltet die Firmware das Relais nach 160 min ab.
- **Hält sich selbst in Gang.** Ein Zeitplan der Firmware startet ein stehendes Skript binnen 5 min neu. Ein zweiter installiert jede Nacht um 03:23 die neueste stabile Firmware, falls es eine gibt.
  - Wächter, Einschaltzustand und Notabschaltung stellt das Skript stündlich nach, falls sie in der App verstellt wurden. Das Firmware-Update legt es nur an, wenn es keines gibt: In der App abgeschaltet, bleibt es aus.
  - Ein Fehler beim Verarbeiten einer Antwort hält das Skript nicht an. Es verwirft das Halbverbuchte und versucht es später nochmal.
  - Fehlt ein Bedienelement, etwa in der App gelöscht, legt das Skript es binnen einer Minute neu an.
  - Eine Schreibbremse schützt den Flash-Speicher, auch vor einem Programmfehler: Den Zustand schreibt es höchstens einmal je Minute und nach 48 Schreibvorgängen am Tag nur noch stündlich. Ein Skript-Neustart schreibt nichts, und die Bremse zählt über Neustarts weiter: Eine Absturzschleife, in der der Wächter das Skript alle 5 min neu startet, schreibt so nicht bei jedem Start. Einstellungen schreibt es nur, wenn sie abweichen: Bedienfeld und Zeitpläne höchstens 30-mal am Tag; die LED wechselt erst nach 30 min Bestand (auf Violett nach 2 min) und höchstens 12-mal am Tag; die Relais-Sicherungen stellt es immer zurück.
- **Kommt ohne Internet aus.**
  - Es rechnet mit Monatsmitteln und der Temperatur seines eigenen Fühlers. Die Eigenwärme des Steckers lernt es selbst.
  - Ohne Internet gießt es lieber etwas mehr.
  - Kommt das Internet zurück, rechnet es die geschätzten Tage mit echten Daten neu, bis 14 Tage rückwirkend.
- **Findet seinen Ort** aus dem Ortsnamen, über die Ortssuche von Open-Meteo, einmal; danach ist er gespeichert. Kennt die Ortssuche den Namen nicht, meldet es das (Status, LED gelb) und gießt wie ohne Internet.
- **Übersteht Stromausfälle.** Alle 6 h speichert es einen Zeitanker.
  - Die Uhrzeit kommt vom Zeitserver. Nach dem Hochfahren warten Tagesprüfung und ein geplanter Nachlauf bis zu 10 min auf ihn, denn nach einem Stromausfall braucht der Router Minuten; bis dahin gilt der Anker, der nie vorgeht.
  - Bleibt das Internet ganz weg, stellt es die Uhr nach der nächsten klaren Nacht am Tagesgang der Temperatur nach.
- **Wird bedient** über den Taster am Stecker oder den Schalter in der App: einmal drücken ist eine Handgabe, nochmal drücken stoppt sie.
  - Dazu kommt ein Bedienfeld in der Shelly-App: Status, Wasserdefizit, Automatik, Pause, Regenrate, Pumpe neu einlernen.
  - Die LED zeigt in voller Helligkeit: grün = alles gut, blau = Pumpe läuft, gelb = Daten fehlen (Wetterdienst, Uhr, Ort oder Speicher), violett = der letzte Lauf hatte eine Störung oder die Firmware hat das Einschalten abgelehnt. Violett bleibt, bis ein Lauf wieder eine Minute fehlerfrei gepumpt hat, auch über Mitternacht und Neustarts; die Statuszeile nennt die Störung mit Datum. Rot gehört der Firmware (WLAN weg, Update), blaues Blinken dem Access Point.
  - Eine **Diagnose-Seite** im Browser, `http://<IP>/script/<Skriptnummer>/info`, zeigt alles auf einen Blick: Status, Grund der LED-Farbe, letzte Störung (offen oder erledigt), Saisonzahlen (Läufe, Millimeter, Störungen), den letzten Ausfall des Wetterdienstes, Uhr, Ort, letzten Neustart, Flash-Schreibvorgänge und die letzten 10 Meldungen. Hat der Shelly ein Gerätepasswort, fragt der Browser danach (Benutzer `admin`). Die Seite entsteht erst beim Aufruf und schreibt nichts.

## Was du brauchst

- Shelly Outdoor Plug S Gen3 (S3PL-20112EU). Andere Shelly Gen2/Gen3 mit Leistungsmessung gehen sinngemäß.
  - Die neueste stabile Firmware; das Aufspielwerkzeug installiert sie.
  - **Matter muss aus sein**, sonst laufen keine Skripte; das Aufspielwerkzeug schaltet es ab.
- Eine Pumpe bis 9 A Nennstrom (der Stecker kann 12 A). Den Anlaufstrom eines Motors verträgt nicht jeder Stecker – beim ersten Start prüfen.
- WLAN mit Internet für Wetter und Uhrzeit. Ohne Internet läuft es weiter, nur ungenauer.

## Einstellen

Alles Einstellbare steht oben im Skript (`src/bewaesserung.js`, Block `C`):

| Wert | Bedeutung |
| --- | --- |
| `ORT`, `LAND` | Ortsname und Land (ISO-Kürzel). Die Koordinaten holt das Skript einmal und speichert sie. Die Schreibweise prüft die [Ortssuche von Open-Meteo](https://geocoding-api.open-meteo.com/v1/search?countryCode=DE&language=de&name=Ludwigshafen) (Namen im Link ersetzen); der erste Treffer zählt, also auch ein gleichnamiger Ort: Die gefundenen Koordinaten stehen auf der Diagnose-Seite. Postleitzahlen findet sie nicht. |
| `LAT`, `LON` | Wer sie kennt, trägt sie direkt ein; dann entfällt die Ortssuche. |
| `UTC_H` | Normalzeit gegen UTC (Deutschland 1); Sommerzeit nach EU-Regel. |
| `START_MIN`, `END_MIN` | Prüfzeit (10:00) und letzte Startzeit der Automatik (12:30), in Minuten nach Mitternacht. |
| `SEASON_FROM`, `SEASON_TO` | Monate mit Automatik. |
| `RATE_MM_H` | Regenrate der Regner (mm/h). Mit dem Becher-Test messen: Dosen aufstellen, 30 min gießen, Wasserhöhe × 2. Lässt sich auch im Bedienfeld ändern. |
| `KC`, `TRIGGER_MM`, `DOSE_*`, `D_MAX_MM` | Rasen und Gießregel: Pflanzenfaktor, Schwelle, kleinste und größte Gabe, Obergrenze des Kontos. |
| `FROST_C`, `FROST_OFF_C`, `FROST_THAW_C` | Frostnacht: Tiefstwert unter 5 °C, mit Internet laut Prognose, ohne Internet aus dem Gerätefühler geschätzt. Danach gießt es erst, wenn die Luft 5 °C hat. |
| `P_LEARN_*`, `P_ABS_*`, `I_MAX` | Pumpe, siehe unten. **An die eigene Pumpe anpassen.** |

Darunter stehen Fachwerte, die man nur mit Grund ändert.

Die Klimawerte für den Betrieb ohne Internet (`ET0_CLIM`, `TMAX_CLIM`) gelten für Mannheim. Für einen anderen Ort gibt `python3 tools/klima.py "Ortsname" DE` die passenden Zeilen aus. Quelle sind die Archivdaten von Open-Meteo (ERA5); deren Höchstwerte liegen etwa 1 K unter einer Messstation, das gibt ohne Internet etwas mehr Wasser.

### Pumpenwerte

I ist der Nennstrom laut Typenschild. Die Formeln rechnen mit dem Strom, weil die Watt-Angabe im Katalog oft die Leistung an der Welle ist und nicht die Aufnahme aus dem Netz.

| Wert | Formel | IBO SDM 5/14, 7,9 A |
| --- | --- | ---: |
| `P_LEARN_MIN`, `P_LEARN_MAX` | 115·I und 240·I (W) | 900 / 1900 W |
| `P_ABS_DRY` | 78·I (W) | 600 W |
| `P_ABS_OVER` | 265·I (W) | 2100 W |
| `I_MAX` | 1,33·I, höchstens 11 A | 10,5 A |
| `BLANK_S` | Tauchpumpe 40 s; Oberflächen- und Jetpumpe: Ansaugzeit + 20 s | 40 s |

- `P_ABS_*` gelten nur bis zum Einlernen. Danach rechnet das Skript relativ zur gelernten Normalleistung (`UNDER_REL`, `OVER_REL`).
- Beim Hahn-zu-Test die Leistung ablesen: `UNDER_REL` = (P_HahnZu / P_normal + 1) / 2.
- **Oberflächen- und Jetpumpen** gehen mit denselben Formeln. Ohne Fußventil läuft die Saugleitung leer, und die Pumpe saugt bei jedem Start neu an, bei langer Leitung bis zu 5 min. So lang muss `BLANK_S` sein, sonst hält das Skript das Ansaugen für Trockenlauf.
- **Hauswasserwerke mit Druckschalter** passen nicht: Der Schalter hält die Pumpe zeitweise an, etwa beim Start, solange der Kessel noch Druck hat; das Skript meldet dann „Pumpe zieht keinen Strom“.

## Aufspielen

```sh
npm install
npm run build                    # build/bewaesserung.min.js (gekürzt, nur ASCII, Sprachmittel und Stapel geprüft) und build/deploy-browser.js
node tools/deploy.js <IP-des-Shelly> [--passwort <Gerätepasswort>] [--neues-passwort <neues Passwort>]
```

`--neues-passwort` setzt zum Schluss das Gerätepasswort (Benutzer `admin`) und meldet sich zur Probe damit an. Danach braucht jeder weitere Aufruf `--passwort`.

Ohne Node geht es auch im Browser, solange der Shelly kein Passwort hat. Auf der Weboberfläche des Shelly (`http://<IP>/`) die Entwicklerkonsole öffnen, den Inhalt von `build/deploy-browser.js` einfügen und Enter drücken. Das Aufspielen startet sofort und meldet sich in der Konsole; das Ergebnis steht danach in `window.__bw`.

Das Werkzeug geht so vor:
- Es prüft das Modell und installiert die neueste stabile Firmware.
- Es schaltet Matter ab.
- Es hält den Wächter an, lädt das Skript in Stücken hoch, schaltet Autostart ein, lässt das Bedienfeld anlegen und startet das Skript neu. Bricht das Hochladen ab, lädt es einmal von vorn; klappt auch das nicht, schaltet es den Wächter wieder an und meldet es.
- Leitet der Shelly auf https um (Firmware ab 2.0 ab Werk), nimmt es sein eigenes Zertifikat hin. Ein Gerätepasswort übergibt es per Digest-Anmeldung mit SHA-256.

Danach prüft es:
- dass das Skript ohne Fehler läuft;
- Einschaltzustand „aus“, die Notabschaltung des Relais und dass die Firmware es nicht selbst wieder einschaltet;
- das Bedienfeld;
- dass der Ort gefunden ist;
- einen Wetterabruf vom Gerät aus;
- die Diagnose-Seite: Adresse und Inhalt stehen im Protokoll;
- die Speicherreserve unter Last: Das Skript lädt die größte Wetterantwort, danach müssen 2 KB frei sein;
- die Sicherheit: Ein offener Access Point wird abgeschaltet, sobald der Shelly im Heim-WLAN ist; Passwort und Bluetooth meldet es;
- den Firmware-Update-Zeitplan (in der App abgeschaltet ist kein Fehler);
- den Wächter: Es hält das Skript an, der Zeitplan muss es binnen 5,5 min wieder starten.

Erst wenn alles stimmt, meldet es „FERTIG“.

**Nicht von Hand einfügen:** Der Skript-Editor der Weboberfläche schneidet beim Einfügen nach 20 000 Zeichen ab, die Gerätefassung hat rund 31 000. Das Skript endet dann mitten im Code, und der Shelly meldet „Syntax ungültig“. Ohne Node daher den Browserweg oben nehmen: Er lädt in Stücken hoch.

Bedienfeld, Relais-Einstellungen, Wächter, LED und Firmware-Update richtet das Skript selbst ein. Den Access Point und das Passwort (Weboberfläche: *Settings → Device settings → Authentication*) stellst du selbst ein.

Danach mit Pumpe:
1. **Normalleistung einlernen:** Hahn auf, Taster drücken, nach 2 min wieder drücken.
2. **Hahn-zu-Test:** Während eines Laufs den Hahn zudrehen. Die Pumpe muss binnen etwa 15 s abschalten.
3. **Becher-Test** für die Regenrate.

In der Shelly-App keine eigenen Zeitpläne zum Schalten des Steckers anlegen. Die zwei Zeitpläne des Skripts (Wächter, Firmware-Update) stehen in der Liste der Zeitpläne. Den Wächter legt das Skript selbst wieder an. Das Firmware-Update abschalten, nicht löschen: Gelöscht legt das Skript es neu an.

### Sicherheit

Bedient wird das Skript nur über das Gerät und die Shelly-App. Seine einzige eigene Adresse ist die Diagnose-Seite: Sie zeigt nur, schaltet nichts und steht hinter dem Gerätepasswort. Es ruft nur feste Adressen von Open-Meteo über https auf und prüft die Antworten auf Grenzen. Zu schützen ist das Gerät:
- Ein **Gerätepasswort** setzen, beim Aufspielen mit `--neues-passwort` oder auf der Weboberfläche unter *Settings → Device settings → Authentication*. Ohne Passwort kann jeder im WLAN die Pumpe schalten oder das Skript ersetzen.
- Das **Shelly-Konto** mit Zwei-Faktor-Anmeldung schützen, wenn die Cloud an ist.
- **Firmware aktuell halten:** Das erledigt der Update-Zeitplan jede Nacht. Nach einem großen Update (neue Hauptversion) das Aufspielwerkzeug nochmal laufen lassen; es prüft danach alles.

## Prüfen und Weiterentwickeln

| Befehl | prüft |
| --- | --- |
| `node tools/stapel.js [--alle]`, `node emu/stapel-test.js` | Stapelspeicher: Der Shelly hat nur Platz für etwa 15 einfache Aufrufe ineinander, Schleifen und Blöcke kosten mehr. Läuft er über, endet das Skript, mitunter startet der ganze Shelly neu und schaltet den Autostart des Skripts ab. `stapel.js` rechnet für jeden Einstieg (Takt, Rückrufe, Start) den teuersten Weg nach den Kosten, die am Gerät gemessen sind, und verlangt höchstens 70 %; `npm run build` bricht sonst ab. `stapel-test.js` prüft das Modell an den 33 Messungen. |
| `node emu/scenarios.js [skript]` | 62 Szenarien im Emulator, für Quelltext und Gerätefassung. Der Emulator bildet Relais, Leistung, Firmware-Schutz, Uhr mit Zeitserver, Stromausfall, Speicher, Bedienfeld, Wetterdienst, Ortssuche, Diagnose-Seite und Gerätetemperatur nach und wacht über die Grenzen der Firmware. Die Datumsprüfung der TLS-Zertifikate bildet er nicht nach. |
| `node emu/zufall.js [skript] [läufe] [tage]` | Zufallstest: wochenlang Stromausfälle, Internet- und Zeitserverausfälle, kaputte Wetterantworten, Pumpenstörungen beim Anlauf und mitten im Lauf, Tastendrücke und Neustarts; prüft Regeln, die immer gelten müssen, etwa Handgabe höchstens 90 min und höchstens 12 LED-Wechsel in 24 h |
| `sh tools/espruino-run.sh build/bewaesserung.min.js [espruino]` | ein Tag im echten Espruino-Interpreter, auf dem die Shelly-Skriptsprache beruht ([Espruino](https://github.com/espruino/Espruino) für Linux bauen, Pfad als zweites Argument) |
| `node emu/deploy-test.js`, `emu/browser-deploy-test.js` | Aufspielwerkzeug gegen einen nachgebauten Shelly mit Firmware-Update, https, Passwort und Wächter, per Node und im Browser (braucht Playwright: `npm install --no-save playwright && npx playwright install chromium`) |
| `node emu/jahreslauf.js src/bewaesserung.js <jahr> <mit\|ohne\|offline> <datei>` | eine ganze Saison mit echtem Wetter (DWD Mannheim 2022–2026) |
| `python3 tools/jahresvergleich.py` | Vergleich mit einem unabhängigen Bodenmodell nach FAO-56, einem idealen Bodensensor und Zeitschaltuhren |
| `python3 tools/auswertung/*.py` | Herleitung der Werte für den Betrieb ohne Internet und die Uhr am Tagesgang; welche DWD-Daten sie brauchen, steht im Dateikopf |

## Ergebnis mit echtem Wetter

Die Saisons 2022 bis 2026 wurden mit dem Wetter der DWD-Station Mannheim gerechnet. Ein Stresstag ist ein Tag, an dem der Boden nach dem Gießen so trocken ist, dass der Rasen einschränkt.

| Steuerung, Summe 2022–2026 | gegossen | Stresstage | versickert |
| --- | ---: | ---: | ---: |
| Skript, Regenprognose trifft | 2.318 mm | 2 | 0 mm |
| Skript, ohne Regenprognose | 2.440 mm | 0 | 0 mm |
| Skript ganz ohne Internet | 3.593 mm | 12 | 1.044 mm |
| idealer Bodensensor | 2.397 mm | 0 | 0 mm |
| Zeitschaltuhr, April–September Mo/Do 12,5 mm | 3.262 mm | 245 | 1.135 mm |
| Zeitschaltuhr mit Regensensor | 2.262 mm | 320 | 377 mm |
| Zeitschaltuhr mit Monatsfaktor | 2.957 mm | 210 | 748 mm |

Das Skript gießt 97 % der Menge eines idealen Bodensensors; seine zwei Stresstage sind Tage, an denen es auf angekündigten Regen wartete. Ganz ohne Internet kennt es den Regen nicht und gießt darum mehr.

## Grenzen

- **Was noch am echten Gerät zu prüfen ist:** wie viel Leistung die Pumpe bei zugedrehtem Hahn zieht und wie viel Arbeitsspeicher das Skript braucht (Gerätefassung 30,2 KB); das Aufspielwerkzeug misst den Speicher, auch beim Aufbau der Diagnose-Seite. Anmelden, Setzen des Gerätepassworts und die Diagnose-Seite folgen der Shelly-Doku, gelaufen sind sie bisher nur gegen den Nachbau und im Espruino.
- **Steht das Skript dauerhaft,** etwa weil ein Firmware-Update es nicht mehr starten lässt, bleibt die LED auf ihrer letzten Farbe. Die Pumpe schützt dann nur noch die Firmware: Einschaltzustand aus, Notabschaltung nach 160 min. Ob das Skript läuft, zeigt die Weboberfläche unter *Scripts*.
- **Die Nachprüfung um 11:05 und 12:05 sieht im Sommer meist dieselbe Prognose wie um 10:00.** Das Wettermodell ICON-D2 des DWD rechnet alle 3 h; der Lauf von 11:00 Sommerzeit ist erst gegen 12:35 abrufbar. Die Nachprüfung hilft bei Frost, bei verspäteten Läufen und im Winterhalbjahr.
- **Die Uhrzeit kommt nur vom Zeitserver.** Ist er gesperrt (UDP 123), bleibt die Uhr geschätzt wie ohne Internet und gießt nie zu früh. Einen zweiten Weg gibt es mit Absicht nicht: Firmware ab 2.0 prüft das Datum von TLS-Zertifikaten, ohne richtige Uhr klappt also auch kein HTTPS.
- **Ein falscher, aber vorhandener Ortsname fällt nicht auf.** Die Ortssuche nimmt den ersten Treffer, auch einen gleichnamigen Ort. Die Koordinaten stehen auf der Diagnose-Seite und im Protokoll des Aufspielwerkzeugs; einmal ansehen genügt.
- **Open-Meteo fällt gelegentlich für Minuten bis etwa eine Stunde aus.** Das Skript versucht es deshalb viermal über eine Stunde, danach rechnet es mit Schätzwerten. Zwei Abrufe kurz hintereinander können leicht verschiedene Prognosen liefern.

## Quellen und Daten

- Wetter: [Open-Meteo](https://open-meteo.com) (CC BY 4.0), Modell [DWD ICON](https://open-meteo.com/en/docs/dwd-api)
- Jahresrechnung: Datenbasis Deutscher Wetterdienst, [Climate Data Center](https://opendata.dwd.de/climate_environment/CDC/)
- Bodenwasserhaushalt: [FAO Irrigation and Drainage Paper 56](https://www.fao.org/4/x0490e/x0490e00.htm)
- [Shelly-API-Dokumentation](https://shelly-api-docs.shelly.cloud/gen2/), darin [Anmeldung](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication) und [HTTPServer für Skripte](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/HTTPServer)

## Lizenz

MIT, siehe [LICENSE](LICENSE). Nutzung auf eigene Gefahr: Das Skript schaltet eine Pumpe am Netz. Den Hahn-zu-Test und den ersten Lauf nur unter Aufsicht machen.
