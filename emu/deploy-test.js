'use strict';
/*
 * Prüft tools/deploy.js (Node-Weg) gegen den nachgebauten Shelly (emu/mock-device.js).
 * Aufruf: node emu/deploy-test.js
 */
const fs = require('fs');
const path = require('path');
const { startMock } = require('./mock-device');
const { deployShelly } = require('../tools/deploy');

startMock(async (m) => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'build', 'bewaesserung.min.js'), 'utf8');
  try {
    const r = await deployShelly('http://127.0.0.1:' + m.port, code, (t) => console.log('  ' + t));
    const ok = r.ok && !m.state.matter && m.state.putCount === Math.ceil(code.length / 1024) &&
      r.bedienfeld.length === 7 && /Bereit|Heute/.test(r.status || '') &&
      m.state.evals === 2 && m.state.updates === 1 && m.world.logs.some((l) => /Selbsttest Wetter: ok/.test(l.msg));
    console.log(ok ? '\nAUFSPIELEN: bestanden' : '\nAUFSPIELEN: FEHLER ' + JSON.stringify(r));
    process.exitCode = ok ? 0 : 1;
  } catch (e) { console.log('ABBRUCH ' + e.stack); process.exitCode = 1; }
  m.close();
});
