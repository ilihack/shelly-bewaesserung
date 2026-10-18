#!/usr/bin/env python3
"""
Klimawerte für einen anderen Ort: Monatsmittel der Grasreferenzverdunstung und des Tageshöchstwerts,
wie sie das Skript ohne Internet braucht (ET0_CLIM, TMAX_CLIM). Quelle: Open-Meteo-Archiv (ERA5), 2016–2025.

Aufruf:  python3 tools/klima.py "Ludwigshafen am Rhein" [DE]     (Ortsname, Land als ISO-Kürzel)
         python3 tools/klima.py 49.48 8.45                        (Koordinaten)
Ausgabe: die Zeilen zum Einsetzen oben im Skript.
Nur Python-Standardbibliothek. Open-Meteo kennt deutsche Postleitzahlen nicht, darum der Ortsname.
"""
import json
import sys
import urllib.parse
import urllib.request


def hole(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def ort(name, land):
    q = urllib.parse.urlencode({'name': name, 'count': 1, 'countryCode': land, 'language': 'de'})
    r = hole('https://geocoding-api.open-meteo.com/v1/search?' + q).get('results') or []
    if not r:
        sys.exit(f'Ort nicht gefunden: {name} ({land})')
    return r[0]['latitude'], r[0]['longitude'], r[0]['name']


def main(a):
    if len(a) >= 2 and all(x.replace('.', '', 1).replace('-', '', 1).isdigit() for x in a[:2]):
        lat, lon, name = float(a[0]), float(a[1]), None
    elif a:
        lat, lon, name = ort(a[0], a[1] if len(a) > 1 else 'DE')
    else:
        sys.exit(__doc__)
    q = urllib.parse.urlencode({'latitude': lat, 'longitude': lon, 'start_date': '2016-01-01', 'end_date': '2025-12-31',
                                'daily': 'et0_fao_evapotranspiration,temperature_2m_max', 'timezone': 'auto'})
    d = hole('https://archive-api.open-meteo.com/v1/archive?' + q)['daily']
    et, tx = [[] for _ in range(12)], [[] for _ in range(12)]
    for t, e, x in zip(d['time'], d['et0_fao_evapotranspiration'], d['temperature_2m_max']):
        m = int(t[5:7]) - 1
        if e is not None:
            et[m].append(e)
        if x is not None:
            tx[m].append(x)
    f = lambda v: '[' + ', '.join(f'{sum(m) / len(m):.1f}' for m in v) + ']'
    print(f'// {name or "Koordinaten"} ({lat:.2f}, {lon:.2f}), Open-Meteo-Archiv (ERA5) 2016–2025')
    print(f'var ET0_CLIM = {f(et)};   // Grasreferenzverdunstung (mm/Tag)')
    print(f'var TMAX_CLIM = {f(tx)}; // Tageshöchstwert (°C)')


if __name__ == '__main__':
    main(sys.argv[1:])
