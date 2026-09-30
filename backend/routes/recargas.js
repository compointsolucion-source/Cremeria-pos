const express = require('express');
const router = express.Router();
const { verificarToken } = require('../middleware/auth');
const proveedorRecargas = require('../utils/proveedorRecargas');

// ============================================================================
// RECARGAS Y PAGO DE SERVICIOS — módulo pendiente de conectar
// ============================================================================
// Estructura lista para cuando se tenga un proveedor (Taecel u otro) dado de
// alta: las rutas ya están montadas en server.js bajo /api/recargas, ya
// validan sesión, y ya delegan al archivo utils/proveedorRecargas.js. Ese
// archivo es el único que hay que llenar con la integración real — estas
// rutas no deberían necesitar cambios.

// Le dice al frontend si el módulo ya está listo para usarse, para poder
// ocultar la opción del menú mientras tanto en vez de mostrar una pantalla
// que truene.
router.get('/estado', verificarToken, (req, res) => {
  res.json({ configurado: proveedorRecargas.estaConfigurado() });
});

// Catálogo de compañías/servicios disponibles para vender.
router.get('/catalogo', verificarToken, async (req, res) => {
  try {
    const catalogo = await proveedorRecargas.obtenerCatalogo();
    res.json(catalogo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el catálogo de recargas y servicios' });
  }
});

// Vender una recarga o pago de servicio. Mientras el proveedor no esté
// configurado, responde 503 de forma clara en vez de un error genérico.
router.post('/vender', verificarToken, async (req, res) => {
  if (!proveedorRecargas.estaConfigurado()) {
    return res.status(503).json({ error: 'El módulo de recargas y pago de servicios todavía no está configurado' });
  }
  try {
    const resultado = await proveedorRecargas.venderRecarga(req.body);
    res.json(resultado);
  } catch (err) {
    console.error(err);
    if (err.codigo === 'NO_CONFIGURADO') {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error al procesar la recarga o el pago de servicio' });
  }
});

module.exports = router;
