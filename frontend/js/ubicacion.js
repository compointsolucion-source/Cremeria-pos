// Ubicaciones y enlaces de los pedidos a domicilio: lee la ubicación que el cliente manda por WhatsApp
// (enlace de Google Maps o "20.6736, -103.3440") y arma los enlaces para abrir Waze, Google Maps,
// llamar o escribir por WhatsApp. No usa internet: todo son cuentas con el texto.
(function (raiz) {
  const enRango = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const PAR = NUM + '\\s*,\\s*' + NUM;

  // Busca latitud/longitud en un enlace de Google Maps / Apple Maps / Waze, o en texto como "20.67, -103.34".
  function extraerCoordenadas(texto) {
    if (texto === undefined || texto === null) return null;
    let t = String(texto).trim();
    if (!t) return null;
    try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch (e) { /* se usa tal cual */ }
    const intentos = [
      new RegExp('!3d' + NUM + '!4d' + NUM),                                   // datos de lugar de Google
      new RegExp('@' + PAR),                                                   // google.com/maps/@20.67,-103.34,17z
      new RegExp('[?&](?:q|ll|query|destination|center|daddr|sll)=' + PAR, 'i'), // ?q=20.67,-103.34
      new RegExp('[?&]ll=' + NUM + '&.*?navigate', 'i'),
      new RegExp('(?:^|[^\\d.-])(-?\\d{1,2}\\.\\d{3,})\\s*[, ]\\s*(-?\\d{1,3}\\.\\d{3,})(?!\\d)') // pareja de decimales suelta
    ];
    for (const re of intentos) {
      const m = re.exec(t);
      if (m && m[2] !== undefined) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
        if (enRango(lat, lng)) return { latitud: Math.round(lat * 1e7) / 1e7, longitud: Math.round(lng * 1e7) / 1e7 };
      }
    }
    return null;
  }

  // Los enlaces cortos (maps.app.goo.gl/...) esconden las coordenadas: hay que abrirlos para verlas.
  function esEnlaceCorto(texto) {
    return /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|share\.google)/i.test(String(texto || ''));
  }

  const lleno = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  function textoDireccion(p) {
    return [p.calle, p.colonia, lleno(p.cp) ? 'C.P. ' + String(p.cp).trim() : '', p.ciudad].filter(lleno).map((x) => String(x).trim()).join(', ');
  }

  const tieneCoordenadas = (p) => p && lleno(p.latitud) && lleno(p.longitud) && enRango(Number(p.latitud), Number(p.longitud));

  // Waze: con ubicación exacta navega directo; si no, busca la dirección escrita.
  function urlWaze(p) {
    if (tieneCoordenadas(p)) return `https://waze.com/ul?ll=${Number(p.latitud)},${Number(p.longitud)}&navigate=yes`;
    return `https://waze.com/ul?q=${encodeURIComponent(textoDireccion(p))}&navigate=yes`;
  }

  function destinoMaps(p) {
    return tieneCoordenadas(p) ? `${Number(p.latitud)},${Number(p.longitud)}` : textoDireccion(p);
  }

  function urlGoogleMaps(p) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinoMaps(p))}&travelmode=driving`;
  }

  // Ruta con varias paradas en Google Maps (la última es el destino; Google acepta hasta 9 intermedias).
  function urlGoogleMapsRuta(paradas) {
    const lista = (paradas || []).filter((p) => p && (tieneCoordenadas(p) || lleno(p.calle)));
    if (!lista.length) return null;
    const destino = lista[lista.length - 1];
    const intermedias = lista.slice(0, -1).slice(0, 9);
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinoMaps(destino))}&travelmode=driving`;
    if (intermedias.length) url += `&waypoints=${intermedias.map((p) => encodeURIComponent(destinoMaps(p))).join('%7C')}`;
    return url;
  }

  // Solo números; un teléfono de 10 dígitos es de México (lada 52).
  function telefonoInternacional(tel) {
    let d = String(tel || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 10) d = '52' + d;
    else if (d.length === 13 && d.startsWith('521')) d = '52' + d.slice(3); // formato viejo de celular
    return d;
  }

  function urlWhatsApp(tel, mensaje) {
    const n = telefonoInternacional(tel);
    if (!n) return null;
    return `https://wa.me/${n}${mensaje ? '?text=' + encodeURIComponent(mensaje) : ''}`;
  }

  function urlLlamar(tel) {
    const n = telefonoInternacional(tel);
    return n ? `tel:+${n}` : null;
  }

  const API = { extraerCoordenadas, esEnlaceCorto, textoDireccion, tieneCoordenadas, urlWaze, urlGoogleMaps, urlGoogleMapsRuta, telefonoInternacional, urlWhatsApp, urlLlamar };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else raiz.UBICACION = API;
})(typeof window !== 'undefined' ? window : this);
