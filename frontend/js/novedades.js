// Novedades de cada versión, consejos «¿Sabías que…?» y aviso de actualización.
//  - Pantalla de entrada: consejos que cambian (sin repetirse seguido) y, si el programa de Windows ya bajó
//    una versión nueva, el cuadro «Actualizar ahora» con lo que trae.
//  - Menú (todas las pantallas): la versión arriba, el botón de actualizar y, una sola vez por versión,
//    la tarjeta «Lo nuevo en la versión X».
// PARA CADA VERSIÓN NUEVA: agregar su entrada ARRIBA en NOVEDADES (y la misma lista en escritorio/build/novedades.md).
(function () {
  if (window.CompointNovedades) return;

  const NOVEDADES = [
    {
      version: '1.2.0', fecha: '2026-10-28',
      puntos: [
        '📱 Nuevo botón <b>Recargas y servicios</b> en Caja: tiempo aire y pago de luz, agua, teléfono y cable (por ahora para practicar).',
        '💡 Al entrar ves <b>¿Sabías que…?</b> con novedades y trucos.',
        '🔢 Tu <b>versión</b> se ve arriba, en el menú.',
        '⬆️ Aviso de actualización con botón <b>Actualizar ahora</b>.'
      ]
    },
    {
      version: '1.1.5', fecha: '2026-10-28',
      puntos: [
        '📦 Paquetes <b>Básico, Negocio y Pro</b>: el sistema respeta lo que contrataste.',
        '🔒 Revisión completa de <b>seguridad</b> en cobros, caja y accesos.',
        '🔔 El programa avisa cuando hay una <b>actualización</b>.'
      ]
    }
  ];

  const CONSEJOS = [
    'En <b>Caja</b>, <b>F4</b> cobra el ticket que tienes abierto y <b>F2</b> abre la cámara para escanear.',
    'En <b>Mostrador</b>, <b>F1</b> te lleva directo al buscador de productos y <b>F4</b> genera el ticket.',
    'En <b>Caja Avanzada</b>: <b>Insert</b> = varios, <b>Supr</b> borra el artículo, <b>F11</b> pone precio de mayoreo.',
    'En <b>Caja Avanzada</b>, <b>F6</b> deja una venta pendiente y <b>F5</b> cambia entre ventas abiertas.',
    'En <b>Caja Avanzada</b>, <b>F7</b> registra una entrada de dinero, <b>F8</b> una salida y <b>F9</b> abre el verificador de precios.',
    'Si se va el <b>internet</b>, sigues vendiendo: todo se sincroniza solo al volver.',
    'En <b>Catálogo → Kits/Combos</b> armas paquetes de varios productos con un solo precio (ej. «Kit desayuno»).',
    'En <b>Reporte Inventario → Importar Excel</b> subes muchos productos de golpe, sin capturarlos uno por uno.',
    'En <b>Clientes/Créditos → Importar Excel</b> subes tu lista de clientes completa.',
    'En <b>Reportes → Exportar</b> bajas tus ventas para abrirlas en Excel.',
    'En <b>Administración → Backups</b> puedes guardar una copia de toda tu información cuando quieras.',
    'En <b>Equipo</b> cada empleado tiene su usuario, y tú decides qué puede hacer cada uno.',
    'Al cerrar el turno, declara lo que hay en caja: el sistema te dice al momento si <b>sobra o falta</b>.',
    'En <b>Cortes por día</b> ves el corte de todos los cajeros sumado en uno solo.',
    'Si capturas el <b>costo</b> de tus productos, el corte te muestra cuánto <b>ganaste</b>.',
    'Cada producto puede tener <b>precio de mayoreo</b>; en Caja Avanzada se aplica con <b>F11</b>.',
    'En <b>Clientes/Créditos</b> llevas el fiado: cuánto debe cada cliente y sus abonos.',
    'En <b>Pedidos a domicilio</b> puedes pedir anticipo y mandar el pedido al repartidor por WhatsApp.',
    'La <b>Pantalla de Turnos</b> puede mostrar tus promociones mientras los clientes esperan (Configuración → Anuncios).',
    'Con la <b>báscula</b> conectada, el peso aparece solo al pesar (Configuración → Báscula y etiquetas).',
    'Cambia los <b>colores</b> o pon el <b>modo oscuro</b> en Configuración → Dispositivo y color.',
    '¿Se acabó el papel? En Caja, <b>Reimprimir último</b> vuelve a sacar el ticket.',
    'En Caja, <b>Historial / Devoluciones</b> te deja devolver productos de un ticket ya cobrado.',
    'En <b>Bitácora</b> ves quién hizo cada cambio y a qué hora.',
    'El botón de la flechita en el menú lo deja <b>compacto</b>, solo con iconos, para tener más espacio.',
    'Con el celular también puedes escanear: toca 📷 y apunta al código de barras.',
    'En <b>Caja → Recargas y servicios</b> vendes tiempo aire y cobras recibos de luz o agua.',
    'Tu comisión por cobrar recibos la cambias en <b>Configuración → Recargas y servicios</b>.',
    'En <b>Kiosco de Fichas</b> el cliente toma su turno solo, y la Pantalla de Turnos lo llama.',
    'Cambia tu contraseña cuando quieras en <b>Administración → Cambiar contraseña</b>.'
  ];

  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const esEscritorio = !!(window.compointDesktop && window.compointDesktop.esEscritorio);
  const comparar = (a, b) => {
    const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
    return 0;
  };

  // Versión que se le muestra a la persona: la del programa de Windows (lo que se actualiza) o la del sistema.
  let versionServidor = null;
  async function version() {
    if (esEscritorio && window.compointDesktop.version) return window.compointDesktop.version;
    if (versionServidor) return versionServidor;
    try {
      const base = typeof API_URL !== 'undefined' ? API_URL : '/api';
      const r = await fetch(base + '/auth/info-login', { signal: AbortSignal.timeout(8000) });
      versionServidor = (await r.json()).version || null;
    } catch (e) { /* sin conexión */ }
    return versionServidor;
  }

  // Consejos en orden revuelto que no se repite hasta pasar por todos (se recuerda entre una vez y otra).
  function siguienteConsejo() {
    let cola = [];
    try { cola = JSON.parse(leer('consejos_cola') || '[]'); } catch (e) { cola = []; }
    cola = cola.filter((i) => Number.isInteger(i) && i >= 0 && i < CONSEJOS.length);
    if (!cola.length) {
      cola = CONSEJOS.map((_, i) => i);
      for (let i = cola.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cola[i], cola[j]] = [cola[j], cola[i]]; }
    }
    const i = cola.shift();
    guardar('consejos_cola', JSON.stringify(cola));
    return CONSEJOS[i];
  }

  // Novedades que esta persona no ha visto (de la versión actual hacia atrás, hasta la última que vio).
  function novedadesDe(v) { return NOVEDADES.find((n) => n.version === v) || null; }

  // ---------- Actualización (solo programa de Windows) ----------
  let estadoAct = null;
  const oyentes = [];
  function alCambiarActualizacion(fn) { oyentes.push(fn); if (estadoAct) fn(estadoAct); }
  function avisar(e) { estadoAct = e; oyentes.forEach((f) => { try { f(e); } catch (err) { /* pantalla */ } }); }
  if (esEscritorio && window.compointDesktop.actualizacion) {
    window.compointDesktop.actualizacion().then((e) => { if (e) avisar(e); }).catch(() => {});
    if (window.compointDesktop.alCambiarActualizacion) window.compointDesktop.alCambiarActualizacion(avisar);
  }
  const hayActualizacion = (e) => !!(e && e.nueva && e.descargada && comparar(e.nueva, e.actual) > 0);
  async function instalar() {
    if (!esEscritorio || !window.compointDesktop.instalarActualizacion) return;
    const msg = 'Se va a cerrar el programa unos segundos para instalar la versión nueva y se vuelve a abrir solo. ¿Continuar?';
    const ok = typeof confirmarAccion === 'function' ? await confirmarAccion(msg) : window.confirm(msg);
    if (ok) window.compointDesktop.instalarActualizacion();
  }
  // Texto simple de las notas (vienen como líneas) → lista HTML segura.
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function notasHTML(e) {
    const lineas = String((e && e.notas) || '').split('\n').filter(Boolean).slice(0, 4);
    return lineas.length ? '<ul>' + lineas.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '';
  }

  // ---------- Menú: versión arriba, botón de actualizar y «Lo nuevo» una vez por versión ----------
  function estilosMenu() {
    if (document.getElementById('novEstilos')) return;
    const s = document.createElement('style'); s.id = 'novEstilos';
    s.textContent = `
      .sidebar-version { display:block; font-size:11px; font-weight:600; color:var(--sidebar-texto-tenue,#9AA0AA); line-height:1.1; margin-top:1px; }
      .sidebar-marca .sb-txt { display:flex; flex-direction:column; }
      body.sidebar-compacto .sidebar-version { display:none; }
      .sb-actualizar { margin:8px 12px 0; padding:8px 10px; border:0; border-radius:9px; background:#E8F5E1; color:#2E6B1E; font-weight:700; font-size:13px; cursor:pointer; text-align:left; display:none; }
      .sb-actualizar.visible { display:block; }
      [data-tema="oscuro"] .sb-actualizar { background:rgba(95,174,70,.18); color:#B6F19E; }
      body.sidebar-compacto .sb-actualizar { margin:8px 8px 0; padding:8px 4px; text-align:center; font-size:0; }
      body.sidebar-compacto .sb-actualizar::before { content:'⬆️'; font-size:16px; }
      .nov-tarjeta { position:fixed; right:16px; bottom:16px; z-index:950; width:min(360px, calc(100vw - 32px)); background:var(--surface,#fff); color:var(--text,#1F2023);
        border:1px solid var(--border,#E4E6E9); border-radius:14px; box-shadow:0 12px 40px rgba(0,0,0,.18); padding:16px; animation:novEntra .35s ease; }
      .nov-tarjeta h4 { margin:0 0 8px; font-size:16px; }
      .nov-tarjeta ul { margin:0 0 12px; padding-left:18px; font-size:14px; line-height:1.45; }
      .nov-tarjeta li { margin-bottom:4px; }
      .nov-tarjeta .nov-pie { display:flex; justify-content:flex-end; }
      @keyframes novEntra { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
      @media (prefers-reduced-motion: reduce) { .nov-tarjeta { animation:none; } }`;
    document.head.appendChild(s);
  }

  async function mejorarMenu() {
    const marca = document.querySelector('#sidebarPrincipal .sidebar-marca');
    if (!marca) return;
    estilosMenu();
    const v = await version();
    const texto = marca.querySelector('.sidebar-texto');
    if (v && texto && !document.getElementById('sbVersion')) {
      const caja = document.createElement('span'); caja.className = 'sb-txt';
      texto.replaceWith(caja); caja.appendChild(texto);
      const sv = document.createElement('small'); sv.className = 'sidebar-version'; sv.id = 'sbVersion'; sv.textContent = 'Versión ' + v;
      caja.appendChild(sv);
      marca.title = 'Compoint Punto · versión ' + v;
    }
    // Botón «Actualizar» (solo cuando el programa ya bajó una versión nueva).
    const enc = document.querySelector('#sidebarPrincipal .sidebar-encabezado');
    if (enc && esEscritorio && !document.getElementById('sbActualizar')) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sb-actualizar'; b.id = 'sbActualizar';
      b.onclick = instalar; enc.insertAdjacentElement('afterend', b);
      alCambiarActualizacion((e) => {
        const si = hayActualizacion(e);
        b.classList.toggle('visible', si);
        if (si) { b.textContent = '⬆️ Actualizar a la ' + e.nueva; b.title = (e.notas || '').split('\n').join(' · '); }
      });
    }
    tarjetaNovedades(v);
  }

  // Una sola vez por versión: «Lo nuevo en la versión X».
  function tarjetaNovedades(v) {
    if (!v || document.querySelector('.nov-tarjeta')) return;
    const n = novedadesDe(v);
    if (!n || leer('novedades_vistas') === v) return;
    const t = document.createElement('div'); t.className = 'nov-tarjeta'; t.setAttribute('role', 'status');
    t.innerHTML = `<h4>🎉 Lo nuevo en la versión ${esc(v)}</h4><ul>${n.puntos.map((p) => '<li>' + p + '</li>').join('')}</ul>
      <div class="nov-pie"><button type="button" class="btn btn-primary">Entendido</button></div>`;
    t.querySelector('button').onclick = () => { guardar('novedades_vistas', v); t.remove(); };
    document.body.appendChild(t);
  }

  window.CompointNovedades = { NOVEDADES, CONSEJOS, version, siguienteConsejo, novedadesDe, alCambiarActualizacion, hayActualizacion, instalar, notasHTML, mejorarMenu, comparar };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mejorarMenu);
  else mejorarMenu();
})();
