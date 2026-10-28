// Datos del negocio (formulario compartido), ventana de bienvenida del demo y ayudas para la
// solicitud de licencia. Lo usan la página de Inicio (bienvenida) y la página Licencia.
//
// Los datos se guardan SOLO en este sistema. Compoint no recibe nada hasta que la persona
// presiona "Enviar solicitud" en la página Licencia (y acepta el aviso de privacidad).
(function () {
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function esc(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }

  // ---------- estilos (una sola vez) ----------
  function estilos() {
    if (document.getElementById('estilo-licencia-datos')) return;
    const st = document.createElement('style');
    st.id = 'estilo-licencia-datos';
    st.textContent = `
      .lic-grupo { margin: 14px 0 4px; font-size: 12px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted, #7A7D83); }
      .lic-grupo:first-child { margin-top: 0; }
      .lic-rej { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
      .lic-rej .lic-ancho { grid-column: 1 / -1; }
      .lic-rej.lic-tres { grid-template-columns: 1.3fr 1fr 120px; }
      .lic-campo label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 4px; }
      .lic-campo label i { font-style: normal; color: #C62828; margin-left: 2px; }
      .lic-campo label small { font-weight: 500; color: var(--muted, #7A7D83); margin-left: 4px; }
      .lic-campo input.lic-malo, .lic-campo select.lic-malo, .lic-campo textarea.lic-malo { border-color: #C62828 !important; box-shadow: 0 0 0 3px rgba(198,40,40,.12) !important; }
      .lic-error { color: #C62828; font-size: 12px; margin-top: 3px; }
      details.lic-det { margin-top: 12px; border: 1px solid var(--border, #E4E6E9); border-radius: 10px; padding: 0 12px; }
      details.lic-det > summary { cursor: pointer; font-size: 13.5px; font-weight: 700; padding: 10px 0; }
      details.lic-det[open] > summary { border-bottom: 1px solid var(--border, #E4E6E9); margin-bottom: 12px; }
      details.lic-det > div { padding-bottom: 12px; }
      .lic-privacidad { font-size: 12.5px; line-height: 1.5; color: var(--muted, #7A7D83); }
      .lic-privacidad b { color: var(--text, #1F2023); }
      .lic-aviso-texto { max-height: 190px; overflow: auto; font-size: 12.5px; line-height: 1.55; border: 1px solid var(--border, #E4E6E9); border-radius: 10px; padding: 10px 12px; background: rgba(128,128,128,.07); }
      .lic-aviso-texto p { margin: 0 0 8px; } .lic-aviso-texto p:last-child { margin: 0; }
      .lic-chk { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; line-height: 1.4; cursor: pointer; margin-top: 12px; }
      .lic-chk input { margin-top: 2px; }

      .lic-fondo { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 100000; display: flex; align-items: center; justify-content: center; padding: 14px; }
      .lic-modal { background: var(--surface, #fff); color: var(--text, #1F2023); border-radius: 16px; width: 100%; max-width: 660px; max-height: calc(100vh - 28px); display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.35); overflow: hidden; }
      .lic-modal-cab { padding: 20px 22px 12px; background: linear-gradient(135deg, rgba(95,174,70,.18), rgba(95,174,70,.04)); border-bottom: 1px solid var(--border, #E4E6E9); }
      .lic-modal-cab h2 { margin: 0 0 4px; font-size: 21px; line-height: 1.2; }
      .lic-modal-cab p { margin: 0; font-size: 14px; line-height: 1.45; color: var(--muted, #7A7D83); }
      .lic-modal-cab .lic-dias { display: inline-block; background: #5FAE46; color: #fff; font-weight: 800; border-radius: 20px; padding: 2px 11px; font-size: 13px; margin-bottom: 8px; }
      .lic-modal-cuerpo { padding: 16px 22px; overflow: auto; }
      .lic-modal-pie { padding: 12px 22px 16px; border-top: 1px solid var(--border, #E4E6E9); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .lic-modal-pie .btn { flex: 1 1 160px; }
      .lic-modal-pie .lic-nota { flex: 1 1 100%; font-size: 12.5px; color: var(--muted, #7A7D83); line-height: 1.45; }
      @media (max-width: 600px) {
        .lic-rej, .lic-rej.lic-tres { grid-template-columns: 1fr; }
        .lic-fondo { padding: 0; align-items: flex-end; }
        .lic-modal { max-width: none; max-height: 96vh; border-radius: 18px 18px 0 0; }
        .lic-modal-cab { padding: 16px 16px 10px; } .lic-modal-cab h2 { font-size: 19px; }
        .lic-modal-cuerpo { padding: 14px 16px; } .lic-modal-pie { padding: 10px 16px 14px; }
      }`;
    document.head.appendChild(st);
  }

  // ---------- formulario ----------
  function campo(p, id, etiqueta, opc = {}) {
    const tipo = opc.tipo || 'text';
    const ancho = opc.ancho ? ' lic-ancho' : '';
    return `<div class="lic-campo${ancho}">
      <label for="${p}${id}">${etiqueta}${opc.req ? '<i>*</i>' : ''}${opc.nota ? `<small>${opc.nota}</small>` : ''}</label>
      <input id="${p}${id}" name="${id}" type="${tipo}" maxlength="${opc.max || 120}" placeholder="${esc(opc.ph || '')}" autocomplete="${opc.auto || 'off'}"${opc.modo ? ` inputmode="${opc.modo}"` : ''}${opc.mayus ? ' style="text-transform:uppercase"' : ''}>
      <div class="lic-error" id="${p}${id}_e" hidden></div>
    </div>`;
  }

  /** HTML del formulario de datos. p = prefijo de los ids (para poder tener dos en la misma página). */
  function formularioHTML(p) {
    return `
      <div class="lic-grupo">Tu negocio</div>
      <div class="lic-rej">
        ${campo(p, 'negocio', 'Nombre del negocio', { req: 1, max: 60, ph: 'Ej. Cremería La Vaquita', ancho: 1, auto: 'organization' })}
        ${campo(p, 'giro', 'Giro', { max: 60, ph: 'Cremería, abarrotes, carnicería…' })}
        ${campo(p, 'nombre_dueno', 'Tu nombre', { req: 1, max: 80, ph: 'Dueño o encargado', auto: 'name' })}
        ${campo(p, 'whatsapp', 'WhatsApp', { req: 1, max: 20, ph: '33 1234 5678', tipo: 'tel', modo: 'tel', auto: 'tel' })}
        ${campo(p, 'telefono', 'Teléfono', { max: 20, ph: 'Si es otro número', tipo: 'tel', modo: 'tel', nota: '(opcional)' })}
        ${campo(p, 'email', 'Correo', { max: 80, ph: 'tucorreo@ejemplo.com', tipo: 'email', modo: 'email', ancho: 1, auto: 'email', nota: '(opcional)' })}
      </div>
      <div class="lic-grupo">Dónde está</div>
      <div class="lic-rej lic-tres">
        ${campo(p, 'direccion', 'Calle y número', { max: 120, ph: 'Av. Siempre Viva 123', ancho: 1, auto: 'street-address' })}
        ${campo(p, 'ciudad', 'Ciudad', { max: 60, auto: 'address-level2' })}
        ${campo(p, 'estado', 'Estado', { max: 40, auto: 'address-level1' })}
        ${campo(p, 'cp', 'Código postal', { max: 5, modo: 'numeric', ph: '44100', auto: 'postal-code' })}
      </div>
      <details class="lic-det">
        <summary>🧾 Datos para factura <small style="font-weight:500;color:var(--muted,#7A7D83)">(opcional)</small></summary>
        <div class="lic-rej">
          ${campo(p, 'razon_social', 'Razón social', { max: 100, ancho: 1 })}
          ${campo(p, 'rfc', 'RFC', { max: 13, mayus: 1, ph: 'XAXX010101000' })}
          ${campo(p, 'cp_fiscal', 'C.P. fiscal', { max: 5, modo: 'numeric' })}
          ${campo(p, 'email_factura', 'Correo para factura', { max: 80, tipo: 'email', modo: 'email', ancho: 1 })}
        </div>
      </details>`;
  }

  const CAMPOS = ['negocio', 'giro', 'nombre_dueno', 'telefono', 'whatsapp', 'email', 'direccion', 'ciudad', 'estado', 'cp', 'rfc', 'razon_social', 'cp_fiscal', 'email_factura'];

  function leer(raiz, p) {
    const d = {};
    for (const c of CAMPOS) { const el = raiz.querySelector('#' + p + c); d[c] = el ? el.value.trim() : ''; }
    return d;
  }

  function poner(raiz, p, datos, sugerencias) {
    // Lo que el sistema ya sabía (encabezado del ticket) solo se usa si todavía no se capturó nada.
    const s = datos && datos.negocio ? {} : (sugerencias || {});
    for (const c of CAMPOS) {
      const el = raiz.querySelector('#' + p + c);
      if (!el) continue;
      el.value = (datos && datos[c]) || s[c] || '';
    }
    // si ya hay datos de factura, se deja abierto ese bloque
    const det = raiz.querySelector('details.lic-det');
    if (det && ['razon_social', 'rfc', 'cp_fiscal', 'email_factura'].some((c) => datos && datos[c])) det.open = true;
  }

  function limpiarErrores(raiz) {
    raiz.querySelectorAll('.lic-malo').forEach((e) => e.classList.remove('lic-malo'));
    raiz.querySelectorAll('.lic-error').forEach((e) => { e.hidden = true; e.textContent = ''; });
  }

  /** Marca los campos con error. errores = { campo: 'mensaje' }. Regresa el primer campo con error. */
  function marcarErrores(raiz, p, errores) {
    limpiarErrores(raiz);
    let primero = null;
    for (const [c, msg] of Object.entries(errores || {})) {
      const el = raiz.querySelector('#' + p + c);
      const m = raiz.querySelector('#' + p + c + '_e');
      if (el) { el.classList.add('lic-malo'); if (!primero) primero = el; }
      if (m) { m.textContent = msg; m.hidden = false; }
    }
    if (primero) {
      const det = primero.closest('details');
      if (det) det.open = true;
      primero.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try { primero.focus({ preventScroll: true }); } catch (e) { /* nada */ }
    }
    return primero;
  }

  /** Revisa lo mínimo en la pantalla (el servidor vuelve a revisar todo). */
  function faltantes(d) {
    const e = {};
    if (!d.negocio) e.negocio = 'Escribe el nombre de tu negocio.';
    if (!d.nombre_dueno) e.nombre_dueno = 'Escribe tu nombre.';
    if (!d.whatsapp && !d.telefono) e.whatsapp = 'Escribe un WhatsApp o teléfono para poder contactarte.';
    return e;
  }

  // ---------- aviso de privacidad ----------
  function avisoHTML() {
    return `<div class="lic-aviso-texto" tabindex="0">
      <p><b>Aviso de privacidad</b></p>
      <p><b>Responsable:</b> Compoint, punto de soluciones (Jose Antonio Hernandez), con domicilio en Calle Fontaneros 527, Guadalajara, Jalisco. Correo: contacto@compoint.com.mx.</p>
      <p><b>Datos que recibimos:</b> los que escribes en este formulario (nombre de tu negocio, giro, tu nombre, teléfono o WhatsApp, correo, dirección y, si quieres, datos para facturar) y el identificador de tu equipo.</p>
      <p><b>Para qué los usamos:</b> contactarte, preparar y entregarte tu licencia de Compoint Punto, darte soporte y, si lo pides, facturarte. No los vendemos ni los usamos para publicidad de terceros.</p>
      <p><b>Con quién los compartimos:</b> con nadie, salvo que una autoridad lo exija conforme a la ley.</p>
      <p><b>Tus derechos:</b> puedes acceder a tus datos, corregirlos, cancelarlos u oponerte a su uso (derechos ARCO) escribiendo a contacto@compoint.com.mx.</p>
      <p><b>Importante:</b> tus datos se quedan en tu sistema y solo se envían a Compoint cuando tú presionas «Enviar solicitud».</p>
    </div>`;
  }

  // ---------- copiar y guardar ----------
  async function copiar(texto) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; }
    } catch (e) { /* se intenta el otro método */ }
    try {
      const t = document.createElement('textarea');
      t.value = texto; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(t); t.select(); t.setSelectionRange(0, t.value.length);
      const ok = document.execCommand('copy');
      t.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  function descargar(nombre, texto) {
    const blob = new Blob(['﻿' + texto], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function nombreArchivo(negocio) {
    const base = String(negocio || 'negocio').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'negocio';
    return `solicitud-compoint-${base}.txt`;
  }

  function fechaCorta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${MESES_CORTOS[d.getMonth()]}, ${hh}:${mm}`;
  }

  // ---------- ventana de bienvenida del demo ----------
  let modalAbierto = false;

  function cerrarModal(fondo) { fondo.remove(); modalAbierto = false; document.removeEventListener('keydown', fondo._esc); }

  async function mostrarBienvenida(info) {
    if (modalAbierto) return;
    modalAbierto = true;
    estilos();
    const dias = info.dias_prueba;
    const fondo = document.createElement('div');
    fondo.className = 'lic-fondo';
    fondo.innerHTML = `
      <div class="lic-modal" role="dialog" aria-modal="true" aria-labelledby="lic-bv-titulo">
        <div class="lic-modal-cab">
          <span class="lic-dias">${dias != null ? (dias === 1 ? 'Te queda 1 día' : `Te quedan ${dias} días`) : 'Versión de prueba'}</span>
          <h2 id="lic-bv-titulo">¡Bienvenido a tu prueba gratis! 🎉</h2>
          <p>Usa el sistema completo, sin límites. Cuéntanos de tu negocio: tus tickets saldrán con tu nombre desde hoy y, si decides contratar, tu registro será mucho más rápido.</p>
        </div>
        <div class="lic-modal-cuerpo" id="lic-bv-cuerpo">
          ${formularioHTML('bv_')}
          <label class="lic-chk"><input type="checkbox" id="bv_ticket" checked> <span>Usar estos datos en el encabezado de mis tickets <small style="color:var(--muted,#7A7D83)">(solo donde esté vacío)</small></span></label>
          <p class="lic-privacidad" style="margin:12px 0 0">🔒 <b>Tus datos se guardan solo en tu sistema.</b> Compoint no recibe nada hasta que tú decidas contratar y presiones «Enviar solicitud».</p>
        </div>
        <div class="lic-modal-pie">
          <button class="btn btn-primary" id="bv_guardar">Guardar y empezar</button>
          <button class="btn btn-secondary" id="bv_despues">Más tarde</button>
        </div>
      </div>`;
    document.body.appendChild(fondo);
    const raiz = fondo.querySelector('.lic-modal');
    poner(raiz, 'bv_', info.datos, info.sugerencias);

    const despues = async () => {
      cerrarModal(fondo);
      try { await apiFetch('/licencia/datos/despues', { method: 'POST', body: '{}' }); } catch (e) { /* no pasa nada */ }
    };
    fondo._esc = (ev) => { if (ev.key === 'Escape') despues(); };
    document.addEventListener('keydown', fondo._esc);
    raiz.querySelector('#bv_despues').onclick = despues;

    const guardar = raiz.querySelector('#bv_guardar');
    guardar.onclick = async () => {
      const datos = leer(raiz, 'bv_');
      const falta = faltantes(datos);
      if (Object.keys(falta).length) { marcarErrores(raiz, 'bv_', falta); return; }
      limpiarErrores(raiz);
      guardar.disabled = true; guardar.textContent = 'Guardando…';
      try {
        const r = await apiFetch('/licencia/datos', { method: 'PUT', body: JSON.stringify({ datos, aplicar_ticket: raiz.querySelector('#bv_ticket').checked }) });
        cerrarModal(fondo);
        const t = r.ticket_aplicado && r.ticket_aplicado.length;
        if (typeof mostrarToast === 'function') mostrarToast(t ? '¡Listo! Tus tickets ya llevan los datos de tu negocio.' : '¡Listo! Guardamos los datos de tu negocio.', 'exito', 4500);
      } catch (err) {
        guardar.disabled = false; guardar.textContent = 'Guardar y empezar';
        let campos = null;
        try { campos = err.campos || null; } catch (e) { /* nada */ }
        if (campos) marcarErrores(raiz, 'bv_', campos);
        else if (typeof mostrarToast === 'function') mostrarToast(err.message, 'error', 5000);
      }
    };
    setTimeout(() => { const n = raiz.querySelector('#bv_negocio'); if (n && window.innerWidth > 600) n.focus(); }, 100);
  }

  /** Se llama al abrir la página de Inicio: si toca, muestra la bienvenida del demo. */
  async function revisarBienvenida() {
    try {
      const u = typeof getUsuario === 'function' ? getUsuario() : null;
      if (!u || !['dueno', 'jefe_general', 'gerente'].includes(u.rol)) return;
      if (typeof licenciaEsPrueba === 'function' && licenciaInfo() && !licenciaEsPrueba()) return; // ya sabemos que no es prueba
      const info = await apiFetch('/licencia/datos');
      if (info.mostrar_bienvenida) mostrarBienvenida(info);
    } catch (e) { /* la bienvenida nunca debe estorbar */ }
  }

  window.LicDatos = {
    estilos, formularioHTML, leer, poner, marcarErrores, limpiarErrores, faltantes, avisoHTML,
    copiar, descargar, nombreArchivo, fechaCorta, mostrarBienvenida, revisarBienvenida, esc
  };
})();
