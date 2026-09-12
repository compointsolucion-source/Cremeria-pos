// Comprime y redimensiona una imagen en el navegador antes de convertirla a base64,
// para evitar solicitudes gigantes que hacen fallar la conexión con el servidor.
function comprimirImagen(file, maxAncho = 500, calidad = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let ancho = img.width;
        let alto = img.height;

        if (ancho > maxAncho) {
          alto = Math.round((alto * maxAncho) / ancho);
          ancho = maxAncho;
        }

        const canvas = document.createElement('canvas');
        canvas.width = ancho;
        canvas.height = alto;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, ancho, alto);

        // JPEG comprimido: reduce drásticamente el peso vs. el archivo original
        const dataUrl = canvas.toDataURL('image/jpeg', calidad);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('No se pudo procesar la imagen'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

// Sube una imagen ya comprimida (base64) a Cloudinary a través del backend,
// y devuelve la URL final corta que se debe guardar (no el base64 completo).
// "carpeta" organiza las imágenes en Cloudinary (ej. 'productos', 'kits', 'logos').
async function subirImagenACloudinary(imagenBase64, carpeta = 'general') {
  const data = await apiFetch('/imagenes/subir', {
    method: 'POST',
    body: JSON.stringify({ imagen_base64: imagenBase64, carpeta })
  });
  return data.url;
}
