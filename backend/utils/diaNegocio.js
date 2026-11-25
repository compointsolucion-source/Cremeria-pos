// Días en la hora del negocio (TZ_NEGOCIO; México por omisión).
//
// Las ventas, compras, etc. guardan la hora "de pared" de la base: UTC en la nube (Coolify) y hora local en
// la computadora del negocio. Antes los reportes y el «hoy» del inicio armaban el día con la hora del
// programa y con fechas leídas como UTC, así que cada día iba de 6 pm del día anterior a 6 pm
// (las ventas de la noche salían al día siguiente). Aquí el inicio y fin de cada día se calculan EN LA BASE:
// medianoche en México convertida a la hora de pared de la base. Sirve en los dos tipos de servidor y la
// columna se compara tal cual, así se siguen usando los índices de fecha.
// (El reporte de cortes, routes/turnos.js, ya lo hacía así con su propio sqlHoraLocal.)
const pool = require('../db');

const TZ_NEGOCIO = process.env.TZ_NEGOCIO || 'America/Mexico_City';
const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Hora local del negocio de una columna guardada con la hora de pared de la base (para agrupar por día u hora).
// `tz` es el marcador del parámetro que trae TZ_NEGOCIO, ej. '$5'.
const sqlHoraLocal = (columna, tz) => `((${columna} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${tz}::text)`;

// Rango de días del negocio para comparar con "columna >= desde AND columna < hasta" (o BETWEEN).
//   query.desde / query.hasta: 'AAAA-MM-DD'; hasta es el día SIGUIENTE al último (así lo manda Reportes).
//   Sin fechas: hoy completo. Con fechas mal escritas lanza un error con status 400.
// Regresa { desde, hasta } como hora de pared de la base ('AAAA-MM-DD HH24:MI:SS'),
// { diaDesde, diaHasta } como días del negocio y { dias } (cuántos días abarca).
async function rangoDelNegocio(query = {}, db = pool) {
  const d = query.desde || null;
  const h = query.hasta || null;
  if ((d && !esFecha(d)) || (h && !esFecha(h))) {
    const e = new Error('Fechas no válidas (usa AAAA-MM-DD)');
    e.status = 400;
    throw e;
  }
  const { rows } = await db.query(
    `WITH f AS (
       SELECT COALESCE($1::date, (NOW() AT TIME ZONE $3::text)::date) AS d,
              COALESCE($2::date, (NOW() AT TIME ZONE $3::text)::date + 1) AS h
     )
     SELECT to_char((d::timestamp AT TIME ZONE $3::text) AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD HH24:MI:SS') AS desde,
            to_char((h::timestamp AT TIME ZONE $3::text) AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD HH24:MI:SS') AS hasta,
            to_char(d, 'YYYY-MM-DD') AS dia_desde,
            to_char(h, 'YYYY-MM-DD') AS dia_hasta,
            (h - d) AS dias
     FROM f`,
    [d, h, TZ_NEGOCIO]
  );
  const r = rows[0];
  return { desde: r.desde, hasta: r.hasta, diaDesde: r.dia_desde, diaHasta: r.dia_hasta, dias: Number(r.dias) };
}

module.exports = { TZ_NEGOCIO, sqlHoraLocal, rangoDelNegocio };
