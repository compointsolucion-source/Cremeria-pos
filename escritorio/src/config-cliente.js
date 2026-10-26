// La dirección del sistema de cada cliente viene dentro de su instalador (config-cliente.json). Una actualización
// automática trae el instalador genérico (sin dirección), así que la primera vez se guarda aparte, en la
// configuración del usuario, y desde ahí se sigue usando. Se mantiene en piezas chicas para poder probarlas.

// Lo que hay que guardar en la configuración del usuario (o null si no hay nada nuevo).
function cambiosAConservar(cliente, usuario) {
  const c = cliente || {}, u = usuario || {};
  if (c.url && c.url !== u.urlCliente) return { urlCliente: c.url, nombreCliente: c.nombre || '' };
  return null;
}

// Configuración final: valores por omisión < lo del instalador (con la dirección guardada) < lo que el usuario cambió.
function combinar(porOmision, cliente, usuario) {
  const c = { ...(cliente || {}) }, u = usuario || {};
  if (u.urlCliente) c.url = u.urlCliente;
  if (u.nombreCliente) c.nombre = u.nombreCliente;
  return { ...porOmision, ...c, ...u };
}

module.exports = { cambiosAConservar, combinar };
