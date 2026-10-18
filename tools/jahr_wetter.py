#!/usr/bin/env python3
"""
Echte Tageswerte für die Jahresrechnung: DWD-Station Mannheim (5906), nahe Ludwigshafen.
  ET0  = VPGFAO  potentielle Verdunstung über Gras nach FAO-56 (DWD, abgeleitete Bodendaten v2)
  Regen = RSK    Tagesniederschlag (DWD-Klimadaten, Tag = 06 UTC bis 06 UTC Folgetag)
  Tmin = TNK     Tagesminimum 2 m
  Tmax = TXK     Tagesmaximum 2 m (für die Gerätetemperatur im Emulator)
Quelle: Deutscher Wetterdienst, opendata.dwd.de (CDC). Fehlwerte (-999) bleiben leer.
Aufruf: python3 tools/jahr_wetter.py <ordner mit den DWD-Dateien> [ziel.json]
"""
import gzip
import json
import os
import sys

ordner = sys.argv[1]
ziel = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'test-out', 'wetter_mannheim.json')


def lies(pfad, spalten):
    oeffne = gzip.open if pfad.endswith('.gz') else open
    with oeffne(pfad, 'rt', encoding='latin-1') as f:
        kopf = [k.strip() for k in f.readline().split(';')]
        idx = {k: kopf.index(k) for k in spalten}
        for zeile in f:
            t = [x.strip() for x in zeile.split(';')]
            d = t[kopf.index('MESS_DATUM' if 'MESS_DATUM' in kopf else 'Datum')]
            if not d.isdigit() or d < '20220101':
                continue
            werte = {}
            for k, i in idx.items():
                v = float(t[i])
                werte[k] = None if v <= -999 else v
            yield d[:4] + '-' + d[4:6] + '-' + d[6:], werte


tage = {}
for name in ('derived_germany_soil_daily_historical_v2_5906.txt.gz', 'derived_germany_soil_daily_recent_v2_5906.txt.gz'):
    for d, w in lies(os.path.join(ordner, name), ['VPGFAO']):
        tage.setdefault(d, {})['et0'] = w['VPGFAO']
for name in ('kl_hist/produkt_klima_tag_17810101_20251231_05906.txt', 'kl_akt/produkt_klima_tag_20250415_20261016_05906.txt'):
    for d, w in lies(os.path.join(ordner, name), ['RSK', 'TNK', 'TXK']):
        tage.setdefault(d, {}).update({'rain': w['RSK'], 'tmin': w['TNK'], 'tmax': w['TXK']})

daten = {d: tage[d] for d in sorted(tage)}
fehl = {k: sum(1 for v in daten.values() if v.get(k) is None) for k in ('et0', 'rain', 'tmin', 'tmax')}
with open(ziel, 'w') as f:
    json.dump(daten, f)
print(f"{len(daten)} Tage {min(daten)} bis {max(daten)}, Fehlwerte {fehl} -> {ziel}")
