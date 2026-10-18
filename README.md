# Shelly-Bewässerung mit Brunnenpumpe

Ein Skript für den **Shelly Outdoor Plug S Gen3**: Der Stecker schaltet eine Brunnen- oder Gartenpumpe und gießt den Rasen nach seinem tatsächlichen Wasserbedarf. Den Bedarf rechnet er aus Wetterdaten von Open-Meteo nach FAO-56. Die Pumpe schützt er über ihre gemessene Leistung. Strom- und Internetausfälle übersteht er ohne Hilfe.

*English summary: Shelly Gen3 script that irrigates a lawn with a well pump based on a FAO-56 soil water balance (Open-Meteo weather), protects the pump by power monitoring, and keeps working offline. Comments and docs are in German.*

## Was es kann

- **Gießt nach Bedarf.** Jeden Tag um 10:00 bucht es Verdunstung und Regen aufs Bodenkonto. Ab 8 mm Defizit gibt es 5–15 mm.
  - Angekündigter Regen zählt mit.
  - Hat er die Gabe verhindert, schaut das Skript um 11:05 und 12:05 nochmal nach.
  - Nach 12:30 startet keine Automatik mehr.
- **Schützt die Pumpe.** Es erkennt über die Leistung Trockenlauf, einen zugedrehten Hahn, Blockade, eine fehlende Last und ein klebendes Relais.
  - Die Normalleistung lernt es beim ersten Lauf selbst.
  - Schaltet der Überstromschutz der Firmware schon beim Anlauf ab, meldet es eine Störung und versucht es nach 60 min einmal nochmal.
  - Das Relais schaltet nach 160 min auch ohne Skript ab.
- **Kommt ohne Internet aus.**
  - Es rechnet mit Monatsmitteln und der Temperatur seines eigenen Fühlers. Die Eigenwärme des Steckers lernt es selbst.
  - Ohne Internet gießt es lieber etwas mehr.
  - Kommt das Internet zurück, korrigiert es die geschätzten Tage mit echten Daten, bis 14 Tage rückwirkend.
- **Übersteht Stromausfälle.** Alle 6 h speichert es einen Zeitanker. Bleibt das Internet weg, stellt es die Uhr nach der nächsten klaren Nacht am Tagesgang der Temperatur nach.
- **Wird bedient** über den Taster am Stecker oder den Schalter in der App: einmal drücken ist eine Handgabe, nochmal drücken stoppt sie.
  - Dazu kommt ein Bedienfeld in der Shelly-App: Status, Wasserdefizit, Automatik, Pause, Regenrate, Pumpe neu einlernen.
  - Die LED zeigt: aus = alles gut, blau = Pumpe läuft, gelb = ohne Internet, violett = Störung.

## Was du brauchst

- Shelly Outdoor Plug S Gen3 (S3PL-20112EU). Andere Shelly Gen2/Gen3 mit Leistungsmessung gehen sinngemäß.
  - Firmware ab 1.5, empfohlen ab 2.0.1; das Aufspielwerkzeug aktualisiert.
  - **Matter muss aus sein**, sonst laufen keine Skripte; das Aufspielwerkzeug schaltet es ab.
- Eine Pumpe bis 12 A. Den Anlaufstrom eines Motors verträgt nicht jeder Stecker – beim ersten Start prüfen.
- WLAN mit Internet für Wetter und Uhrzeit. Ohne Internet läuft es weiter, nur ungenauer.

## Einstellen

Alles Einstellbare steht oben im Skript (`src/bewaesserung.js`, Block `C`):

| Wert | Bedeutung |
| --- | --- |
| `ORT`, `LAND` | Ortsname und Land (ISO-Kürzel). Die Koordinaten holt das Skript einmal von Open-Meteo und speichert sie. Deutsche Postleitzahlen findet die Ortssuche von Open-Meteo nicht, darum der Ortsname. |
| `LAT`, `LON` | Wer sie kennt, trägt sie direkt ein; dann entfällt die Abfrage. |
| `UTC_H` | Normalzeit gegen UTC (Deutschland 1); Sommerzeit nach EU-Regel. |
| `START_MIN`, `END_MIN` | Prüfzeit (10:00) und letzte Startzeit der Automatik (12:30), in Minuten nach Mitternacht. |
| `SEASON_FROM`, `SEASON_TO` | Monate mit Automatik. |
| `RATE_MM_H` | Regenrate der Regner (mm/h). Mit dem Becher-Test messen: Dosen aufstellen, 30 min gießen, Wasserhöhe × 2. Lässt sich auch im Bedienfeld ändern. |
| `KC`, `TRIGGER_MM`, `DOSE_*`, `D_MAX_MM` | Rasen und Gießregel: Pflanzenfaktor, Schwelle, kleinste und größte Gabe, Obergrenze des Kontos. |
| `FROST_C`, `FROST_OFF_C` | Frostsperre mit und ohne Internet. |
| `P_LEARN_MIN`/`MAX`, `P_ABS_*`, `I_MAX` | Pumpe: Bereich der Normalleistung, Grenzen vor dem Einlernen, Blockierstrom. **An die eigene Pumpe anpassen.** |

Darunter stehen Fachwerte, die man nur mit Grund ändert.

Die Klimawerte für den Betrieb ohne Internet (`ET0_CLIM`, `TMAX_CLIM`) gelten für Mannheim. Für einen anderen Ort gibt `python3 tools/klima.py "Ortsname" DE` die passenden Zeilen aus. Quelle sind die Archivdaten von Open-Meteo (ERA5); deren Höchstwerte liegen etwa 1 K unter einer Messstation, das gibt ohne Internet etwas mehr Wasser.

## Aufspielen

```sh
npm install
npm run build                    # build/bewaesserung.min.js (gekürzt, nur ASCII, Sprachmittel geprüft) und build/deploy-browser.js
node tools/deploy.js <IP-des-Shelly>
```

Ohne Node geht es auch im Browser. Auf der Weboberfläche des Shelly (`http://<IP>/`) die Entwicklerkonsole öffnen, den Inhalt von `build/deploy-browser.js` einfügen und `deployShelly("", CODE).then(console.log)` aufrufen.

Das Werkzeug geht so vor:
- Es prüft Modell und Firmware und aktualisiert bei Bedarf.
- Es schaltet Matter ab.
- Es lädt das Skript in Stücken hoch, schaltet Autostart ein, lässt das Bedienfeld anlegen und startet das Skript neu.

Danach prüft es:
- dass das Skript ohne Fehler läuft;
- Einschaltzustand „aus“, die Notabschaltung des Relais und dass die Firmware es nicht selbst wieder einschaltet;
- das Bedienfeld;
- dass der Ort gefunden ist;
- einen Wetterabruf vom Gerät aus;
- die Speicherreserve unter Last: Das Skript lädt die größte Wetterantwort, danach müssen 2 KB frei sein.

Erst wenn alles stimmt, meldet es „FERTIG“.

Danach mit Pumpe:
1. **Normalleistung einlernen:** Hahn auf, Taster drücken, nach 2 min wieder drücken.
2. **Hahn-zu-Test:** Während eines Laufs den Hahn zudrehen. Die Pumpe muss binnen etwa 15 s abschalten.
3. **Becher-Test** für die Regenrate.

In der Shelly-App keine eigenen Zeitpläne für den Stecker anlegen. Den einen Zeitplan, den das Skript selbst anlegt, nicht löschen: Er ist der Wächter und startet ein stehendes Skript stündlich neu.

## Prüfen und Weiterentwickeln

| Befehl | prüft |
| --- | --- |
| `node emu/scenarios.js [skript]` | 46 Szenarien im Emulator, für Quelltext und Gerätefassung. Der Emulator bildet Relais, Leistung, Firmware-Schutz, Uhr mit Zeitserver, Stromausfall, Speicher, Bedienfeld, Wetterdienst und Gerätetemperatur nach und wacht über die Grenzen der Firmware. |
| `node emu/zufall.js [skript] [läufe] [tage]` | Zufallstest: wochenlang Stromausfälle, Internet- und Zeitserverausfälle, kaputte Wetterantworten, Pumpenstörungen samt Abschaltung beim Anlauf, Tastendrücke und Neustarts; prüft Regeln, die immer gelten müssen |
| `sh tools/espruino-run.sh build/bewaesserung.min.js [espruino]` | ein Tag im echten Espruino-Interpreter, auf dem die Shelly-Skriptsprache beruht ([Espruino](https://github.com/espruino/Espruino) für Linux bauen, Pfad als zweites Argument) |
| `node emu/deploy-test.js`, `emu/browser-deploy-test.js` | Aufspielwerkzeug gegen einen nachgebauten Shelly, per Node und im Browser (braucht Playwright: `npm install --no-save playwright && npx playwright install chromium`) |
| `node emu/jahreslauf.js src/bewaesserung.js <jahr> <mit\|ohne\|offline> <datei>` | eine ganze Saison mit echtem Wetter (DWD Mannheim 2022–2026) |
| `python3 tools/jahresvergleich.py` | Vergleich mit einem unabhängigen Bodenmodell nach FAO-56, einem idealen Bodensensor und Zeitschaltuhren |
| `python3 tools/auswertung/*.py` | Herleitung der Werte für den Betrieb ohne Internet und die Uhr am Tagesgang; welche DWD-Daten sie brauchen, steht im Dateikopf |

## Ergebnis mit echtem Wetter

Die Saisons 2022 bis 2026 wurden mit dem Wetter der DWD-Station Mannheim gerechnet. Ein Stresstag ist ein Tag, an dem der Boden nach dem Gießen so trocken ist, dass der Rasen einschränkt.

| Steuerung, Summe 2022–2026 | gegossen | Stresstage | versickert |
| --- | ---: | ---: | ---: |
| Skript, Regenprognose trifft | 2.307 mm | 23 | 6 mm |
| Skript, ohne Regenprognose | 2.436 mm | 21 | 9 mm |
| Skript ganz ohne Internet | 3.569 mm | 56 | 1.051 mm |
| idealer Bodensensor | 2.397 mm | 0 | 0 mm |
| Zeitschaltuhr, April–September Mo/Do 12,5 mm | 3.262 mm | 245 | 1.135 mm |
| Zeitschaltuhr mit Regensensor | 2.262 mm | 320 | 377 mm |
| Zeitschaltuhr mit Monatsfaktor | 2.957 mm | 210 | 748 mm |

Das Skript gießt 96 % der Menge eines idealen Bodensensors. Fast alle seine Stresstage liegen im Frühjahr: Nach Nächten unter 3 °C hält die Frostsperre die Automatik an. Ganz ohne Internet kennt es den Regen nicht und gießt darum mehr.

## Grenzen

- **Was noch am echten Gerät zu prüfen ist:** wie viel Leistung die Pumpe bei zugedrehtem Hahn zieht, ob der Stecker den Anlaufstrom hinnimmt und wie viel Arbeitsspeicher das Skript braucht. Das Aufspielwerkzeug misst den Speicher.
- **Firmware ab 2.0 prüft das Datum von TLS-Zertifikaten.** Ist die Uhr nur angenommen (erster Start ohne Internet), klappt HTTPS erst, wenn der Zeitserver die Uhr gestellt hat. Bis dahin rechnet das Skript wie ohne Internet.
- **Open-Meteo fällt gelegentlich für Minuten bis etwa eine Stunde aus.** Das Skript versucht es deshalb viermal über eine Stunde, danach rechnet es mit Schätzwerten. Zwei Abrufe kurz hintereinander können leicht verschiedene Prognosen liefern.

## Quellen und Daten

- Wetter: [Open-Meteo](https://open-meteo.com) (CC BY 4.0)
- Jahresrechnung: Datenbasis Deutscher Wetterdienst, [Climate Data Center](https://opendata.dwd.de/climate_environment/CDC/)
- Bodenwasserhaushalt: [FAO Irrigation and Drainage Paper 56](https://www.fao.org/4/x0490e/x0490e00.htm)
- [Shelly-API-Dokumentation](https://shelly-api-docs.shelly.cloud/gen2/)

## Lizenz

MIT, siehe [LICENSE](LICENSE). Nutzung auf eigene Gefahr: Das Skript schaltet eine Pumpe am Netz. Den Hahn-zu-Test und den ersten Lauf nur unter Aufsicht machen.
