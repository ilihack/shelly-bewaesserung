#!/usr/bin/env python3
"""
Hätte das Skript die richtige Menge gegossen? Vergleich über die Saisons 2022 bis 2026 mit echtem Wetter
(DWD Mannheim, tools/jahr_wetter.py) und den Läufen des Skripts aus dem Emulator (emu/jahreslauf.js).

Schiedsrichter ist ein unabhängiges Bodenmodell nach FAO-56 (Kapitel 8, einfacher Kc-Ansatz):
  Rasen Kc 0,85        FAO-56 Tab. 12: Kühlklima-Rasen 0,95, bei sparsamer Pflege 0,10 weniger
  Wurzelraum 0,20 m, nutzbare Feldkapazität 140 mm/m (lehmiger Sand / sandiger Lehm)
  -> pflanzenverfügbares Wasser TAW 28 mm, leicht verfügbar RAW = 0,40 * TAW = 11,2 mm (FAO-56 Tab. 22)
  Regen wirkt abzüglich 1 mm je Tag, gegossen wird um 10:00, Wasser über Feldkapazität versickert.
  Stresstag = Tag, an dem das Defizit nach dem Gießen um 10:00 noch über RAW liegt (Rasen schränkt ein).
  Versickert = gegossenes Wasser, das über die Feldkapazität hinausgeht (verloren).

Verglichene Steuerungen (gleiche Pumpe: höchstens 15 mm je Tag):
  Skript mit Prognose   Emulatorlauf, Regenprognose = tatsächlicher Regen (bester Fall)
  Skript ohne Prognose  Emulatorlauf, keine Regenprognose (schlechtester Fall)
  Skript ohne Internet  Emulatorlauf, ab 4. März kein Wetterdienst: Monatsmittel mal Gerätetemperatur, kein Regen bekannt
  Bodenfeuchte ideal    gießt auf Feldkapazität, sobald das Modell RAW erreicht (wie ein perfekter Bodensensor)
  Zeitschaltuhr         April bis September Mo und Do je 12,5 mm (25 l/m² je Woche)
  Uhr mit Regensensor   wie Zeitschaltuhr, aber aus, wenn in den letzten 2 Tagen oder heute >= 5 mm Regen
  Monatsfaktor          März bis Oktober Mo und Do, 12,5 mm mal Verdunstungsmittel des Monats / Juli
Aufruf: python3 tools/jahresvergleich.py [ordner]   (schreibt test-out/jahresvergleich.csv und .md)
"""
import csv
import datetime as dt
import json
import os

HIER = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HIER, '..', 'test-out')
WX = json.load(open(os.path.join(OUT, 'wetter_mannheim.json')))
KC, TAW, P = 0.85, 28.0, 0.40
RAW = P * TAW
DOSE_MAX = 15.0
CLIM = [0.6, 0.9, 1.6, 2.6, 3.5, 4.5, 4.4, 3.8, 2.4, 1.1, 0.5, 0.5]   # DWD Mannheim 2016-2025, wie im Skript
JAHRE = [2022, 2023, 2024, 2025, 2026]


def tage(jahr):
    d = dt.date(jahr, 3, 1)
    ende = dt.date(2026, 10, 16) if jahr == 2026 else dt.date(jahr, 11, 30)
    while d <= ende:
        yield d
        d += dt.timedelta(days=1)


def wetter(d):
    v = WX.get(d.isoformat(), {})
    et0 = v.get('et0')
    return (CLIM[d.month - 1] if et0 is None else et0), (v.get('rain') or 0.0)


def bewerten(jahr, giessen):
    """Bodenmodell; giessen(d, dr_morgens, regen_heute, verlauf) -> mm. Liefert Kennzahlen."""
    dr, summe, laeufe, stress, versickert = 0.0, 0.0, 0, 0, 0.0
    verlauf = []
    for d in tage(jahr):
        et0, regen = wetter(d)
        i = min(DOSE_MAX, max(0.0, giessen(d, dr, regen, verlauf)))
        if i > 0:
            summe += i
            laeufe += 1
        versickert += max(0.0, i - dr)              # was um 10:00 über die Feldkapazität geht
        dr = max(0.0, dr - i)                       # Defizit nach dem Gießen um 10:00
        if dr > RAW:                                # trotz Gießen zu trocken: Rasen schränkt ein
            stress += 1
        ks = 1.0 if dr <= RAW else max(0.0, (TAW - dr) / ((1 - P) * TAW))
        dr = min(TAW, max(0.0, dr - max(0.0, regen - 1.0) + ks * KC * et0))
        verlauf.append((d, regen, i))
    return {'gegossen': round(summe), 'laeufe': laeufe, 'stresstage': stress, 'versickert': round(versickert)}


def skript(jahr, variante, ordner=None):
    j = json.load(open(os.path.join(ordner or os.path.join(OUT, 'jahre'), f'{jahr}-{variante}.json')))
    if j.get('absturz'):
        raise SystemExit(f'Skript im Jahreslauf {jahr} {variante} abgestürzt')
    tag = {}
    for r in j['laeufe']:
        tag[r['tag']] = tag.get(r['tag'], 0.0) + r['mm']
    return lambda d, dr, regen, v: tag.get(d.isoformat(), 0.0)


def ideal(d, dr, regen, v):
    return dr if dr >= RAW else 0.0


def uhr(d, dr, regen, v):
    return 12.5 if 4 <= d.month <= 9 and d.weekday() in (0, 3) else 0.0


def uhr_sensor(d, dr, regen, v):
    if not uhr(d, dr, regen, v):
        return 0.0
    letzte = sum(x[1] for x in v[-2:])
    return 0.0 if letzte >= 5 or regen >= 5 else 12.5


def monatsfaktor(d, dr, regen, v):
    if not (3 <= d.month <= 10 and d.weekday() in (0, 3)):
        return 0.0
    return 12.5 * CLIM[d.month - 1] / CLIM[6]


VERFAHREN = [
    ('Skript mit Prognose', lambda j: skript(j, 'mit')),
    ('Skript ohne Prognose', lambda j: skript(j, 'ohne')),
    ('Skript ohne Internet', lambda j: skript(j, 'offline')),
    ('Bodenfeuchte ideal', lambda j: ideal),
    ('Zeitschaltuhr', lambda j: uhr),
    ('Uhr mit Regensensor', lambda j: uhr_sensor),
    ('Monatsfaktor', lambda j: monatsfaktor),
]

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:                       # Vergleichsordner, z. B. Läufe einer anderen Skriptfassung
        VERFAHREN.append(('Vergleich ohne Internet', lambda j: skript(j, 'offline', sys.argv[1])))
    zeilen = []
    for name, f in VERFAHREN:
        for jahr in JAHRE:
            k = bewerten(jahr, f(jahr))
            zeilen.append(dict(verfahren=name, jahr=jahr, **k))
    with open(os.path.join(OUT, 'jahresvergleich.csv'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(zeilen[0]))
        w.writeheader()
        w.writerows(zeilen)
    # Übersicht: je Verfahren Summe über alle Saisons
    md = ['| Verfahren | ' + ' | '.join(str(j) for j in JAHRE) + ' | Summe |', '|' + ' --- |' * (len(JAHRE) + 2)]
    for name, _ in VERFAHREN:
        r = [z for z in zeilen if z['verfahren'] == name]
        zellen = [f"{z['gegossen']} mm / {z['stresstage']} St / {z['versickert']} V" for z in r]
        summe = f"{sum(z['gegossen'] for z in r)} mm / {sum(z['stresstage'] for z in r)} St / {sum(z['versickert'] for z in r)} V"
        md.append(f'| {name} | ' + ' | '.join(zellen) + f' | {summe} |')
    for jahr in JAHRE:
        et = sum(wetter(d)[0] for d in tage(jahr))
        rg = sum(wetter(d)[1] for d in tage(jahr))
        md.append(f'Saison {jahr}: Referenzverdunstung {et:.0f} mm, Regen {rg:.0f} mm')
    open(os.path.join(OUT, 'jahresvergleich.md'), 'w').write('\n'.join(md) + '\n')
    print('\n'.join(md))
