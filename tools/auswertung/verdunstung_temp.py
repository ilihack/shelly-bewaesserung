# Verdunstung ohne Internet (Bauanleitung Kapitel 2): Monatsmittel, und wie viel der Tageshöchstwert dazu beiträgt.
# Liefert ET0_CLIM, TMAX_CLIM (2016–2025) und den Faktor ET_K (gelernt 2010–2021, geprüft 2022–2026).
#
# Daten (DWD Climate Data Center, Station Mannheim 5906), alles in einen Ordner, die zip-Archive entpackt:
#   derived_germany/soil/daily/historical/derived_germany_soil_daily_historical_v2_5906.txt.gz   (+ recent/..._recent_v2_5906.txt.gz)
#   observations_germany/climate/daily/kl/historical/tageswerte_KL_05906_*_hist.zip            (+ recent/tageswerte_KL_05906_akt.zip)
# Aufruf: python3 tools/auswertung/verdunstung_temp.py <ordner>
import glob, gzip, math, statistics as stx, sys, datetime as dt

def lies(pfad, spalten):
    op = gzip.open if pfad.endswith('.gz') else open
    with op(pfad, 'rt', encoding='latin-1') as f:
        kopf = [k.strip() for k in f.readline().split(';')]
        for z in f:
            t = [x.strip() for x in z.split(';')]
            d = t[kopf.index('MESS_DATUM' if 'MESS_DATUM' in kopf else 'Datum')]
            if not d.isdigit() or d < '20100101': continue
            w = {}
            for k in spalten:
                v = float(t[kopf.index(k)]); w[k] = None if v <= -999 else v
            yield dt.date(int(d[:4]), int(d[4:6]), int(d[6:8])), w

X = {}
for f in sorted(glob.glob(sys.argv[1] + '/**/derived_germany_soil_daily_*_5906.txt.gz', recursive=True)):
    for d, w in lies(f, ['VPGFAO']): X.setdefault(d, {})['et'] = w['VPGFAO']
for f in sorted(glob.glob(sys.argv[1] + '/**/produkt_klima_tag_*_05906.txt', recursive=True)):
    for d, w in lies(f, ['TNK', 'TXK']): X.setdefault(d, {}).update(w)
if not X: sys.exit('keine Daten gefunden')

r1 = lambda x: round(x, 1)
print('ET0_CLIM  2016-2025:', [r1(stx.mean(v['et'] for d, v in X.items() if d.month == m and 2016 <= d.year <= 2025 and v.get('et') is not None)) for m in range(1, 13)])
print('TMAX_CLIM 2016-2025:', [r1(stx.mean(v['TXK'] for d, v in X.items() if d.month == m and 2016 <= d.year <= 2025 and v.get('TXK') is not None)) for m in range(1, 13)])

CLIM = [0.6, 0.9, 1.6, 2.6, 3.5, 4.5, 4.4, 3.8, 2.4, 1.1, 0.5, 0.5]          # wie im Skript
days = sorted(d for d, v in X.items() if 3 <= d.month <= 11 and None not in (v.get('et'), v.get('TNK'), v.get('TXK')))
train = [d for d in days if d.year <= 2021]; test = [d for d in days if d.year >= 2022]
txc = {m: stx.mean(X[d]['TXK'] for d in train if d.month == m) for m in range(3, 12)}
tnc = {m: stx.mean(X[d]['TNK'] for d in train if d.month == m) for m in range(3, 12)}
def fit(key, c):   # et = Monatsmittel * (1 + b * (T - T_Monatsmittel)), kleinste Quadrate auf 2010-2021
    return (sum((X[d]['et'] / CLIM[d.month - 1] - 1) * (X[d][key] - c[d.month]) for d in train) /
            sum((X[d][key] - c[d.month]) ** 2 for d in train))
b_max, b_min = fit('TXK', txc), fit('TNK', tnc)
print(f'Faktor je K, gelernt 2010-2021: Höchstwert {b_max:.3f}, Tiefstwert {b_min:.3f}')
M = {'Monatsmittel': lambda d: CLIM[d.month - 1],
     'mal Tiefstwert': lambda d: max(0, CLIM[d.month - 1] * (1 + b_min * (X[d]['TNK'] - tnc[d.month]))),
     'mal Höchstwert (0,06, 0,5- bis 1,6-fach)': lambda d: CLIM[d.month - 1] * min(1.6, max(0.5, 1 + 0.06 * (X[d]['TXK'] - txc[d.month])))}
for name, f in M.items():   # Wochensummen 2022-2026, relativer mittlerer Fehler
    rel = []
    for i in range(len(test) - 7):
        blk = test[i:i + 7]
        if (blk[-1] - blk[0]).days != 6: continue
        s = sum(X[d]['et'] for d in blk)
        if s > 1: rel.append((sum(f(d) for d in blk) - s) / s)
    print(f'{name:42s} Woche 2022-2026: {math.sqrt(sum(x * x for x in rel) / len(rel)) * 100:.0f} % daneben')
