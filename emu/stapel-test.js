'use strict';
/*
 * Prüft das Stapelmodell (tools/stapel.js) an den Messungen am echten Gerät (Outdoor Plug S Gen3, Firmware 2.0.3,
 * 31.10.2026): Jedes Messprogramm wird ohne Selbstaufruf ausgerollt (q1 ruft q2 ...). Was am Gerät gerade noch lief,
 * darf das Modell knapp über 100 % schätzen (es rechnet vorsichtig); was am Gerät überlief, muss es auf mindestens
 * 100 % schätzen, sonst wäre es zu optimistisch.
 * Aufruf: node emu/stapel-test.js
 */
const { analysiere, PLATZ } = require('../tools/stapel');

// Bauart je Messprogramm: Aufruf des nächsten (NEXT) in der gemessenen Verschachtelung
const ART = {
  s: 'if(n<9)NEXT(n+1)',
  h: 'var i;if(n<9){for(i=0;i<1;i++){if(i===0){NEXT(n+1)}}}',
  x: 'var a=0;if(n<9){a=1+(n>0?NEXT(n+1):0)}return a',
  e: 'n<9&&NEXT(n+1)',
  ifblk: 'if(n<9){NEXT(n+1)}',
  ifblk3: 'if(n<9){{{NEXT(n+1)}}}',
  if3: 'if(n<9)if(n>=0)if(n>=0)NEXT(n+1)',
  for: 'var i;if(n<9)for(i=0;i<1;i++)NEXT(n+1)',
  forin: 'var i;if(n<9)for(i in {a:1})NEXT(n+1)',
  while: 'var i=0;if(n<9)while(i++<1)NEXT(n+1)',
  try: 'if(n<9)try{NEXT(n+1)}catch(e){}',
  par3: 'n<9&&(((NEXT(n+1))))',
  arg3: 'n<9&&id(id(id(NEXT(n+1))))',
  elif3: 'if(n<0)n=0;else if(n<-1)n=0;else if(n<-2)n=0;else if(n<9)NEXT(n+1)',
  tern: 'n<9?NEXT(n+1):0',
  assign: 'var a;if(n<9)a=NEXT(n+1)',
  ret: 'if(n<9)return NEXT(n+1)',
  binop: 'n<9&&1+NEXT(n+1)',
  obj: 'n<9&&{a:NEXT(n+1)}'
};
// Programm: Einstieg (Zeitgeber oder Rückruf oder Skriptstart), dann k Rahmen der Bauart b, dann n s-Rahmen, am Ende ein Blatt
function programm(art, kontext, k, b, n, blatt) {
  const fns = ['function id(v){return v}function cbx(){}'];
  let name = (i) => 'f' + i, total = k + n;
  for (let i = 1; i <= total; i++) {
    const bauart = i <= k ? ART[b] : ART.s;
    const body = i < total ? bauart.replace('NEXT', name(i + 1)) : (blatt || 'n=n');
    fns.push('function ' + name(i) + '(n){' + body + '}');
  }
  if (kontext === 'start') fns.push(name(1) + '(1);');
  if (kontext === 'zeitgeber') fns.push('function t(){' + name(1) + '(1)}Timer.set(100,false,t);');
  if (kontext === 'rueckruf') fns.push('function c(){' + name(1) + '(1)}Shelly.call("Sys.GetStatus",{},c);');
  return fns.join('');
}
function anteil(code) {
  const r = analysiere(code, null);
  return r.ergebnis.length ? Math.max.apply(null, r.ergebnis.map((e) => e.anteil)) : 0;
}
// Messungen: [Name, Kontext, k Rahmen Bauart b, n s-Rahmen ok, Blatt]; am Gerät lief n, n+1 lief über
const MESS = [
  ['start s', 'start', 0, 's', 13], ['zeitgeber s', 'zeitgeber', 0, 's', 15], ['rueckruf s', 'rueckruf', 0, 's', 14],
  ['zeitgeber h', 'zeitgeber', 0, 'h', 5, null, true], ['zeitgeber x', 'zeitgeber', 0, 'x', 7, null, true]
];
// Runde 2: 4 Rahmen der Bauart, dann ein Rahmen "if" (Übergang), dann n s-Rahmen
const R2 = { 'if': 10, e: 9, ifblk: 9, ifblk3: 8, if3: 8, for: 4, forin: 4, while: 6, try: 8, par3: 3, arg3: 1, elif3: 8,
  tern: 10, assign: 9, ret: 9, binop: 7, obj: 7, h: 2 };
// Firmware- und eingebaute Funktionen als Blatt nach n s-Rahmen (Zeitgeber)
const NAT = { 'OK=2': 15, 'OK=Math.floor(n/3)': 13, 'OK=Math.round(n/3)': 13, 'Shelly.call("Switch.GetStatus",{id:0},cbx)': 13,
  'OK=JSON.stringify({a:1})': 13, 'OK=JSON.parse("{}")': 13, 'print("x")': 14, 'OK=Shelly.getComponentStatus("sys")': 13,
  'Virtual.getHandle("text:200").setValue("x")': 14, 'OK=String(1.5).replace(".",",")': 13 };

let fehler = 0, n = 0;
function pruefe(name, codeOk, codeUeber) {
  const a = anteil(codeOk), b = anteil(codeUeber);
  n++;
  const ok = b >= 1 && a <= 1.25;
  if (!ok) fehler++;
  console.log((ok ? '  ok   ' : '  FEHL ') + name.padEnd(42) + ' lief: ' + Math.round(a * 100) + ' %   lief über: ' + Math.round(b * 100) + ' %');
}
for (const [name, ktx, k, b, nOk, , eigen] of MESS) {
  if (eigen) pruefe(name, programm(name, ktx, nOk, b, 0), programm(name, ktx, nOk + 1, b, 0));
  else pruefe(name, programm(name, ktx, 0, 's', nOk), programm(name, ktx, 0, 's', nOk + 1));
}
for (const b of Object.keys(R2)) {
  const art = b === 'if' ? 's' : b;
  pruefe('4× ' + b + ' + s', programm(b, 'zeitgeber', 4, art, 1 + R2[b]), programm(b, 'zeitgeber', 4, art, 2 + R2[b]));
}
for (const leaf of Object.keys(NAT)) {
  const blatt = 'var OK;if(n<0)n=0;else{' + leaf + '}';
  pruefe('Blatt ' + leaf.slice(0, 34), programm(leaf, 'zeitgeber', 0, 's', NAT[leaf], blatt), programm(leaf, 'zeitgeber', 0, 's', NAT[leaf] + 1, blatt));
}
console.log((n - fehler) + ' von ' + n + ' Messungen passen zum Modell' + (fehler ? '' : ' (vorsichtig, nie zu optimistisch)'));
process.exit(fehler ? 1 : 0);
