#!/bin/sh
# Lässt das Skript im echten Espruino-Interpreter laufen (Ablauf siehe emu/espruino-shim.js)
# Aufruf: tools/espruino-run.sh <skriptdatei> <espruino-binary>
SCRIPT="$1"; BIN="${2:-/tmp/espruino-build/Espruino/bin/espruino}"
DIR=$(dirname "$0")/..
OUT=$(mktemp -d)
{ cat "$DIR/emu/espruino-shim.js"; echo; cat "$SCRIPT"; echo;
  cat <<'EOT'
__runUntilUp(26 * 3600e3);
print('## Relais: ' + __W.relay.join(' | '));
print('## Zustand: ' + __W.storage.s);
print('## Status: ' + (__W.vc['text:200'] ? __W.vc['text:200'].value : '-'));
print('## Zeitplaene: ' + JSON.stringify(__W.jobs) + ' | LED: ' + JSON.stringify(__W.led));
var __m0 = process.memory().usage, __m1 = 0;
var __res = { send: function () { __m1 = process.memory().usage; __memSample(); var l = String(this.body).split('\n'), i;
  print('## Diagnose (' + this.code + ', ' + String(this.body).length + ' Zeichen; Speicher davor ' + __m0 + ', mit Seite ' + __m1 + ' Bloecke)');
  for (i = 0; i < l.length; i++) print('## | ' + l[i]); return true; } };
if (__W.ep) __W.ep({ method: 'GET', query: '' }, __res); else print('## Diagnose-Seite fehlt');
__memSample();
print('## Zahlen: Schreibvorgaenge ' + __W.writes + ', LED ' + __W.ledWrites + ', Konfig ' + __W.cfgWrites + ', Fehler ' + __W.errs + ', RPC max ' + __W.rpcMax + ', Timer max ' + __W.timersMax + ', Speicher max ' + __W.memMax + ' von ' + process.memory().total + ' Bloecken');
print('## ENDE');
EOT
} > "$OUT/run.js"
timeout 900 "$BIN" "$OUT/run.js" < /dev/null 2>&1 | grep -a -E "^##|\[BW\]|Uncaught|ERROR|Error|FEHLER" | head -80
