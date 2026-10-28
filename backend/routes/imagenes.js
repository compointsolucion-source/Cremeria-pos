const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { verificarToken } = require('../middleware/auth');

// Los videos NO se pueden mandar como base64 dentro del JSON (el límite del
// body es 15mb y un base64 pesa ~33% más que el archivo original) — se usan
// multipart/form-data con multer, guardado en memoria (el archivo es chico
// y se manda directo a Cloudinary, no se escribe a disco), con un tope de
// 25MB para no tronar la memoria del servicio gratuito de Render.
const subirVideoMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

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

// Carpetas de Cloudinary que usa el sistema (productos, kits, logo del negocio y anuncios).
// Cualquier otro nombre se manda a "general": así nadie puede escribir en otra ruta.
const CARPETAS_PERMITIDAS = ['general', 'productos', 'kits', 'logos', 'promos'];
const carpetaSegura = (c) => (CARPETAS_PERMITIDAS.includes(c) ? c : 'general');

// Solo se acepta una imagen de verdad en base64 ("data:image/...;base64,..."), nunca una
// ruta de archivo ni una dirección web (Cloudinary las iría a leer por su cuenta).
const PATRON_IMAGEN = /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+\/=\s]+$/;
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024; // 5 MB ya decodificada

// Devuelve un mensaje de error, o null si la imagen sirve.
function errorEnImagen(imagen) {
  if (typeof imagen !== 'string' || !PATRON_IMAGEN.test(imagen)) {
    return 'La imagen no es válida (solo JPG, PNG, WEBP o GIF)';
  }
  const datos = imagen.slice(imagen.indexOf(',') + 1).replace(/\s/g, '');
  const relleno = datos.endsWith('==') ? 2 : (datos.endsWith('=') ? 1 : 0);
  const bytes = Math.floor(datos.length * 3 / 4) - relleno;
  if (bytes > MAX_BYTES_IMAGEN) return 'La imagen es demasiado grande (máximo 5 MB)';
  return null;
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
    const errorImagen = errorEnImagen(imagen_base64);
    if (errorImagen) return res.status(400).json({ error: errorImagen });

    const resultado = await cloudinary.uploader.upload(imagen_base64, {
      folder: `cremeria-pos/${carpetaSegura(carpeta)}`,
      resource_type: 'image'
    });

    res.json({ url: resultado.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen a Cloudinary' });
  }
});

// Recibe un video (multipart/form-data, campo "video") y lo sube a
// Cloudinary como resource_type "video". Se usa upload_stream para mandar
// el buffer directo sin pasar por disco.
router.post('/subir-video', verificarToken, (req, res) => {
  if (!cloudinaryConfigurado) {
    return res.status(503).json({ error: 'Cloudinary no está configurado en el servidor todavía (faltan las variables de entorno)' });
  }

  subirVideoMulter.single('video')(req, res, async (errMulter) => {
    if (errMulter) {
      if (errMulter.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El video es demasiado grande (máximo 25MB)' });
      }
      console.error(errMulter);
      return res.status(400).json({ error: 'No se pudo procesar el video' });
    }

    if (!req.file) return res.status(400).json({ error: 'Falta el video a subir' });

    const carpeta = carpetaSegura(req.body.carpeta);

    try {
      const streamDeSubida = cloudinary.uploader.upload_stream(
        { folder: `cremeria-pos/${carpeta}`, resource_type: 'video' },
        (err, resultado) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error al subir el video a Cloudinary' });
          }
          res.json({ url: resultado.secure_url });
        }
      );
      streamDeSubida.end(req.file.buffer);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Error al subir el video a Cloudinary' });
    }
  });
});

module.exports = router;
module.exports._errorEnImagen = errorEnImagen; // para las pruebas
module.exports._carpetaSegura = carpetaSegura;
