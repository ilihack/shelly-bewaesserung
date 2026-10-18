# Uhr am Tagesgang (Bauanleitung Kapitel 5): Wie gut zeigt das Tagestief der Luft den Sonnenaufgang,
# und wie oft stellt die Korrektur eine nachgehende Uhr zu früh?
#
# Daten: DWD 10-Minuten-Werte Lufttemperatur, Station Mannheim (5906), beide Archive in einen Ordner entpacken:
#   https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/air_temperature/
#     historical/10minutenwerte_TU_05906_20200101_20251231_hist.zip
#     recent/10minutenwerte_TU_05906_akt.zip
# Aufruf: python3 tools/auswertung/tagesgang.py <ordner>
#
# Das Gerät sieht die Luft träge (Zeitkonstante 20 min), um die Eigenwärme höher und mit 0,2 K Rauschen;
# erkannt wird wie im Skript (zSample): Tiefpunkt mit 3 K Schwelle, gültig nach mindestens 6 K Abkühlung
# über mindestens 6 h und 5 K Erwärmung binnen 3 h.
import glob, math, random, statistics as stx, sys, datetime as dt

LAT, LON = 49.48, 8.45
T = {}
for f in sorted(glob.glob(sys.argv[1] + '/**/produkt_zehn_min_tu_*_05906.txt', recursive=True)):
    with open(f, encoding='latin-1') as fh:
        fh.readline()
        for z in fh:
            t = z.split(';')
            v = float(t[4])
            if v <= -999: continue
            s = t[1].strip()
            u = dt.datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), int(s[8:10]), int(s[10:12]), tzinfo=dt.timezone.utc)
            T[int(u.timestamp())] = v
if not T: sys.exit('keine Daten gefunden')

def sunrise_utc(d):  # Minuten nach Mitternacht UTC, NOAA-Näherung wie im Skript
    g = 2 * math.pi / 365 * (d.timetuple().tm_yday - 1)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    ha = math.degrees(math.acos(math.cos(math.radians(90.833)) / (math.cos(math.radians(LAT)) * math.cos(decl))
                                - math.tan(math.radians(LAT)) * math.tan(decl)))
    return 720 - 4 * (LON + ha) - eqt

def sr_ts(d): return dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() + sunrise_utc(d) * 60
def q(xs, p): xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))]
keys = sorted(T)
d0, d1 = dt.datetime.fromtimestamp(keys[0], dt.timezone.utc).date(), dt.datetime.fromtimestamp(keys[-1], dt.timezone.utc).date()
print(f'{len(T)} Werte, {d0} bis {d1}, ausgewertet März bis November')

# 1) ohne Bedingungen: tiefster Wert von 12 h vor bis 6 h nach Sonnenaufgang
roh, d = [], d0
while d <= d1:
    if 3 <= d.month <= 11:
        sr = sr_ts(d)
        ser = [(k, T[k]) for k in range(int(sr - 12 * 3600) // 600 * 600, int(sr + 6 * 3600), 600) if k in T]
        if len(ser) > 100: roh.append((min(ser, key=lambda x: x[1])[0] - sr) / 60)
    d += dt.timedelta(days=1)
m0 = stx.median(roh)
print(f'ohne Bedingungen: {len(roh)} Nächte, Tief im Median {m0:.0f} min nach Sonnenaufgang, '
      f'mehr als 2 h daneben: {sum(1 for e in roh if abs(e - m0) > 120) / len(roh) * 100:.0f} %')

# 2) wie das Gerät
rnd = random.Random(7)
dev = prev = None; dirn = -1; extV = extT = lmV = lmT = None; ev = []
for k in keys:
    if prev is not None and k - prev > 1800: dev = None          # Datenlücke: neu beginnen
    prev = k
    dev = T[k] if dev is None else dev + (T[k] - dev) * (1 - math.exp(-600 / 1200))
    x = round(dev + 15 + rnd.gauss(0, 0.2), 1)
    for e in ev[-2:]:
        if not e[3] and k - e[0] <= 3 * 3600 and x >= e[2] + 5: e[3] = True
    if extV is None: extV, extT = x, k; continue
    if dirn < 0:
        if x < extV: extV, extT = x, k
        elif x > extV + 3:
            if lmV is not None and lmV - extV >= 6 and extT - lmT >= 6 * 3600: ev.append([extT, lmV - extV, extV, False])
            dirn = 1; extV, extT = x, k
    else:
        if x > extV: extV, extT = x, k
        elif x < extV - 3: lmV, lmT = extV, extT; dirn = -1; extV, extT = x, k
ok = []
for t, drop, vmin, rose in ev:
    u = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    if not rose or not (3 <= u.month <= 11): continue
    ok.append(min(((t - sr_ts((u + dt.timedelta(days=i)).date())) / 60 for i in (-1, 0, 1)), key=abs))
med = stx.median(ok)
print(f'wie im Gerät: {len(ok)} gültige Tiefpunkte ({len(ok) / len(roh) * 100:.0f} % der Tage); im Median {med:.0f} min '
      f'nach Sonnenaufgang; innerhalb 1 h um den Median: {sum(1 for e in ok if abs(e - med) <= 60) / len(ok) * 100:.0f} %; '
      f'5 % / 95 %: {q(ok, .05):.0f} / {q(ok, .95):.0f} min')

# 3) Anker-Uhr stellen: erwartet wird Sonnenaufgang + 10 min, gestellt wird um den Abstand dahinter
for m in (30, 60, 90):
    early = [e for e in ok if e - 10 < -m]
    print(f'Abstand {m} min: zu früh in {len(early) / len(ok) * 100:.1f} % der Fälle, mehr als 15 min zu früh in '
          f'{sum(1 for e in ok if e - 10 < -m - 15) / len(ok) * 100:.1f} %')
