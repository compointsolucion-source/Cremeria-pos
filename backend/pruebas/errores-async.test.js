// Rutas async de Express 4: un error fuera del try/catch ya no deja la solicitud colgada.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { esErrorDeBase } = require('../utils/errores-async');

function levantar(app) {
  return new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
}
async function pedir(s, ruta) {
  const url = 'http://127.0.0.1:' + s.address().port + ruta;
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('una ruta async que falla responde con el error (no se queda colgada)', async () => {
  const app = express();
  app.get('/falla', async () => { throw new Error('timeout exceeded when trying to connect'); });
  app.get('/otra', async () => { throw new Error('algo distinto'); });
  app.get('/bien', async (req, res) => { res.json({ ok: true }); });
  app.use((err, req, res, next) => {
    if (esErrorDeBase(err)) return res.status(503).json({ error: 'sin base' });
    res.status(500).json({ error: 'otro' });
  });
  const s = await levantar(app);
  try {
    assert.deepEqual(await pedir(s, '/falla'), { status: 503, json: { error: 'sin base' } });
    assert.deepEqual(await pedir(s, '/otra'), { status: 500, json: { error: 'otro' } });
    assert.deepEqual(await pedir(s, '/bien'), { status: 200, json: { ok: true } });
  } finally { s.close(); }
});

test('esErrorDeBase reconoce los errores de conexión con la base y no los demás', () => {
  assert.equal(esErrorDeBase(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })), true);
  assert.equal(esErrorDeBase(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })), true);
  assert.equal(esErrorDeBase(new Error('Connection terminated unexpectedly')), true);
  assert.equal(esErrorDeBase(Object.assign(new Error('duplicate key value'), { code: '23505' })), false);
  assert.equal(esErrorDeBase(null), false);
});
