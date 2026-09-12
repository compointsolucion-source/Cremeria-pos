const express = require('express');
const router = express.Router();
const { v2: cloudinary } = require('cloudinary');
const { verificarToken } = require('../middleware/auth');

// Se configura una sola vez, leyendo las 3 variables de entorno de Render.
// Si no están configuradas, el endpoint responde con un error claro en vez
// de fallar de forma confusa.
const cloudinaryConfigurado = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigurado) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// Recibe una imagen en base64 (ya comprimida por el navegador) y la sube a
// Cloudinary. Devuelve la URL final que se debe guardar como imagen_url en
// productos/kits/configuración — ya NO se guarda el base64 completo en la
// base de datos, solo este link corto.
router.post('/subir', verificarToken, async (req, res) => {
  if (!cloudinaryConfigurado) {
    return res.status(503).json({ error: 'Cloudinary no está configurado en el servidor todavía (faltan las variables de entorno)' });
  }
  try {
    const { imagen_base64, carpeta } = req.body;
    if (!imagen_base64) return res.status(400).json({ error: 'Falta la imagen a subir' });

    const resultado = await cloudinary.uploader.upload(imagen_base64, {
      folder: `cremeria-pos/${carpeta || 'general'}`,
      resource_type: 'image'
    });

    res.json({ url: resultado.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen a Cloudinary' });
  }
});

module.exports = router;
