#!/usr/bin/env python3
"""
Betriebspunkt Pumpe IBO 3,5" SDM 5/14 + 3 Regner Rain Bird 5000 (alle drei laufen gleichzeitig), je Düse.

Pumpenkennlinie: aus dem IBO-Katalog 2024, Seite 112 (PDF-Seite 13), Vektorkurve "3,5" SDM 5/14"
  ausgelesen (Bezierkurve, Achsen an den Gitterlinien geeicht). Die Kurve beginnt bei 76,4 m
  (die Tabelle daneben nennt 78 m) und erreicht Förderhöhe 0 bei 120 l/min.
Anlage (Annahmen, in der Bauanleitung Kapitel 6 begründet):
  Pumpe hängt 7 m tief      -> 7 m Förderhöhe bis Gelände (ungünstigster Fall: Wasserspiegel an der Pumpe)
  Steigleitung im Brunnen   1,0 m Verlust bei 75 l/min
  Filter, sauber            2,0 m Verlust bei 75 l/min (etwa 0,2 bar)
  Kleinverluste             1,0 m bei 75 l/min (Bögen, Kupplungen, Brunnenkopf; ein Rückschlagventil hat die Anlage nicht)
  Leitung zu den Regnern    5,0 m Verlust bei 60 l/min (etwa 40 m PE-Rohr 32 mm) - Länge nicht bekannt
  alle Verluste quadratisch mit dem Förderstrom
Regner: Rain Bird 5000, Standarddüsen, Herstellertabelle metrisch (Durchfluss und Wurfweite je Regner).
Ausgabe: Förderstrom, Druck an den Regnern, Wurfweite, Regenrate auf 500 m², Kühlströmung am Motor
         (IBO verlangt mindestens 0,15 m/s) und die Düse mit der größten Wurfweite.
Aufruf: python3 tools/hydraulik.py
"""
import math

# Rain Bird 5000, Standardwinkel, metrisch: Druck bar -> {Düse: (Wurfweite m, l/min je Regner)}
RB = {
    1.7: {3.0: (11.0, 8.4), 4.0: (11.3, 10.8), 5.0: (11.9, 13.8), 6.0: (11.9, 16.2), 8.0: (11.0, 22.2)},
    2.0: {3.0: (11.2, 9.0), 4.0: (11.6, 12.0), 5.0: (12.1, 15.0), 6.0: (12.4, 17.4), 8.0: (11.8, 24.0)},
    2.5: {3.0: (11.2, 10.2), 4.0: (12.3, 13.2), 5.0: (12.7, 17.4), 6.0: (13.2, 20.4), 8.0: (13.3, 27.0)},
    3.0: {3.0: (12.1, 11.4), 4.0: (12.7, 15.0), 5.0: (13.5, 18.6), 6.0: (13.9, 22.2), 8.0: (14.1, 30.0)},
    3.5: {3.0: (12.2, 12.6), 4.0: (12.8, 16.2), 5.0: (13.7, 20.4), 6.0: (14.2, 24.0), 8.0: (14.9, 32.4)},
    4.0: {3.0: (12.2, 13.2), 4.0: (12.8, 17.4), 5.0: (13.7, 22.2), 6.0: (14.9, 25.8), 8.0: (15.2, 34.2)},
    4.5: {3.0: (12.2, 13.8), 4.0: (12.8, 18.0), 5.0: (13.7, 23.4), 6.0: (14.6, 28.2), 8.0: (15.2, 36.6)},
}
PS = sorted(RB)
DUESEN = (3.0, 4.0, 5.0, 6.0, 8.0)

# IBO 3,5" SDM 5/14 laut Katalogkurve: Förderstrom l/min -> Förderhöhe m
KURVE = [(0, 76.4), (10, 76.1), (20, 74.6), (30, 72.3), (40, 69.1), (50, 65.0), (60, 60.0),
         (70, 53.8), (80, 46.5), (90, 37.8), (100, 27.5), (110, 15.2), (120, 0.9)]

H_GEO = 7.0
VERLUST_75 = 1.0 + 2.0 + 1.0   # Steigleitung + Filter + Kleinverluste bei 75 l/min
LEITUNG_60 = 5.0               # Leitung zu den Regnern bei 60 l/min
FLAECHE = 500.0


def pumpe(q):
    """Förderhöhe in m bei q l/min, lineare Interpolation der Katalogkurve."""
    if q <= 0:
        return KURVE[0][1]
    for (q1, h1), (q2, h2) in zip(KURVE, KURVE[1:]):
        if q1 <= q <= q2:
            return h1 + (h2 - h1) * (q - q1) / (q2 - q1)
    return 0.0


def regner(duese, p):
    """Durchfluss (l/min) und Wurfweite (m) eines Regners bei Druck p; über 4,5 bar Q ~ sqrt(p)."""
    if p <= PS[0]:
        r, q = RB[PS[0]][duese]
        return q * math.sqrt(max(p, 0.01) / PS[0]), r
    if p >= PS[-1]:
        r, q = RB[PS[-1]][duese]
        return q * math.sqrt(p / PS[-1]), r
    for a, b in zip(PS, PS[1:]):
        if a <= p <= b:
            f = (p - a) / (b - a)
            ra, qa = RB[a][duese]
            rb, qb = RB[b][duese]
            return qa + f * (qb - qa), ra + f * (rb - ra)


def betriebspunkt(duese, h_geo=H_GEO, verlust_75=VERLUST_75, leitung_60=LEITUNG_60):
    """Druck an den Regnern so suchen, dass Pumpe und Anlage dieselbe Förderhöhe haben."""
    lo, hi = 0.05, 8.0
    for _ in range(80):
        p = (lo + hi) / 2
        q1, _ = regner(duese, p)
        q = 3 * q1
        bedarf = h_geo + verlust_75 * (q / 75.0) ** 2 + leitung_60 * (q / 60.0) ** 2 + p * 10.2
        if pumpe(q) > bedarf:
            lo = p
        else:
            hi = p
    q1, r = regner(duese, p)
    return 3 * q1, p, r


def kuehlung(q_lmin, d_rohr):
    """Strömung im Ringspalt zwischen Motor (90 mm) und Brunnenrohr (Innendurchmesser d_rohr)."""
    a = math.pi / 4 * (d_rohr ** 2 - 0.090 ** 2)
    return q_lmin / 60000.0 / a


if __name__ == "__main__":
    print("Pumpe 7 m tief, Verluste: Steigleitung 1 m + Filter 2 m + Kleinteile 1 m (bei 75 l/min), "
          "Leitung 5 m (bei 60 l/min)")
    print("Düse | Q l/min | p bar | Wurfweite m | mm/h auf 500 m² | Kühlung Rohr 100 / 125 mm (m/s)")
    beste = None
    for d in DUESEN:
        q, p, r = betriebspunkt(d)
        print(f"{d:4.1f} | {q:6.1f} | {p:4.2f} | {r:5.1f} | {q * 60 / FLAECHE:5.1f} | "
              f"{kuehlung(q, 0.100):.2f} / {kuehlung(q, 0.125):.2f}")
        if beste is None or r > beste[1]:
            beste = (d, r)
    print(f"Größte Wurfweite: Düse {beste[0]:.1f} ({beste[1]:.1f} m)")
    print()
    print("Empfindlichkeit (Wurfweite m je Düse):")
    faelle = [("günstig: Wasserspiegel 3 m, Leitung 2 m, Filter 1 m", 3.0, 3.0, 2.0),
              ("Annahme wie oben", H_GEO, VERLUST_75, LEITUNG_60),
              ("ungünstig: Leitung 10 m, Filter verschmutzt 4 m", 7.0, 6.0, 10.0)]
    for name, hg, v75, l60 in faelle:
        werte = []
        for d in DUESEN:
            q, p, r = betriebspunkt(d, hg, v75, l60)
            werte.append(f"{d:.1f}: {r:4.1f} m / {p:3.1f} bar")
        print(f"  {name}\n    " + " | ".join(werte))
