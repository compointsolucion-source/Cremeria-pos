// Pedidos — parte 2: pedidos fijos de tiendas, liquidación del repartidor, ruta del día, hoja de producción,
// reporte de repartidores, zonas de envío y ajustes. Usa los ayudantes de pedidos.js (PT.u).
const PTX = (function () {
  'use strict';
  const U = PT.u;
  const { esc, dinero, hora12, abrirModal, avisoError, lleno } = U;
  const $ = (id) => document.getElementById(id);
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const kg = (n) => { const x = Number(n) || 0; return Number.isInteger(x) ? String(x) : x.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); };
  const DIAS_ORDEN = [{ v: 1, t: 'Lun' }, { v: 2, t: 'Mar' }, { v: 3, t: 'Mié' }, { v: 4, t: 'Jue' }, { v: 5, t: 'Vie' }, { v: 6, t: 'Sáb' }, { v: 0, t: 'Dom' }];
  const PAGO_TXT = { al_recibir: 'Paga al recibir', pagado: 'Se cobra en Caja', credito: 'A crédito del cliente' };
  let catalogo = null;

  async function productos() {
    if (!catalogo) catalogo = await apiFetch('/productos');
    return catalogo;
  }

  function imprimirContenido(html) {
    document.querySelectorAll('#pt-imprimible').forEach((e) => e.remove());
    const d = document.createElement('div');
    d.id = 'pt-imprimible';
    d.innerHTML = html;
    document.body.appendChild(d);
    const limpiar = () => { d.remove(); window.removeEventListener('afterprint', limpiar); };
    window.addEventListener('afterprint', limpiar);
    window.print();
  }

  // =================================================================== PEDIDOS FIJOS
  let FIJOS = [];

  async function cargarFijos() {
    FIJOS = await apiFetch('/pedidos/fijos?todos=1');
    pintarFijos();
  }

  function resumenItems(f) {
    const l = Array.isArray(f.items) ? f.items : [];
    return l.map((i) => `${kg(i.cantidad)} × ${esc(i.nombre || ('#' + i.producto_id))}`).join(' · ');
  }

  function pintarFijos() {
    const el = $('listaFijos');
    if (!FIJOS.length) {
      el.innerHTML = `<div class="pt-bloque"><div class="pt-vacia" style="padding:26px">Todavía no hay pedidos fijos.${U.esAdmin ? ' Usa “＋ Nuevo pedido fijo” para la primera tienda.' : ''}</div></div>`;
      return;
    }
    el.innerHTML = FIJOS.map((f) => {
      const dias = String(f.dias).split(',').map(Number);
      const dir = f.tipo === 'domicilio' ? '🛵 ' + esc([f.direccion_alias, f.calle, f.colonia].filter(Boolean).join(' · ') || 'sin dirección') : '🏪 Pasa a recoger';
      return `<div class="pt-fijo" style="${f.activo ? '' : 'opacity:.6'}"><div>
          <b>${esc(f.nombre || f.cliente_nombre)}</b>${f.nombre ? ` · ${esc(f.cliente_nombre)}` : ''} ${f.cliente_tipo === 'tienda' ? '<span class="pd-tag azul">Tienda</span>' : ''} ${f.activo ? '' : '<span class="pt-t recoger">Pausado</span>'}
          <small>${dir} · ${hora12(f.hora)} · ${esc(PAGO_TXT[f.pago_modo] || f.pago_modo)}${f.repartidor_nombre ? ' · ' + esc(U.primerNombre(f.repartidor_nombre)) : ''}</small>
          <div class="pt-dias">${DIAS_ORDEN.map((d) => `<span class="${dias.includes(d.v) ? 'on' : ''}">${d.t}</span>`).join('')}</div>
          <small style="margin-top:6px">${resumenItems(f)}</small></div>
        ${U.esAdmin ? `<div class="pt-botonera" style="flex-direction:column; margin:0">
          <button type="button" class="btn btn-secondary" onclick="PTX.editarFijo(${f.id})">✏ Editar</button>
          <button type="button" class="btn btn-secondary" onclick="PTX.pausarFijo(${f.id}, ${f.activo ? 'false' : 'true'})">${f.activo ? '⏸ Pausar' : '▶ Reanudar'}</button>
          <button type="button" class="btn btn-secondary" style="color:var(--danger)" onclick="PTX.quitarFijo(${f.id})">🗑 Quitar</button></div>` : ''}</div>`;
    }).join('');
  }

  function cuerpoDeFijo(f, extra) {
    return {
      cliente_id: f.cliente_id, direccion_id: f.direccion_id, nombre: f.nombre, dias: String(f.dias).split(',').map(Number), hora: f.hora, tipo: f.tipo, pago_modo: f.pago_modo,
      zona_id: f.zona_id, repartidor_id: f.repartidor_id, items: (f.items || []).map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: i.cantidad })), notas: f.notas, ...extra
    };
  }

  async function pausarFijo(id, activo) {
    const f = FIJOS.find((x) => x.id === id);
    if (!f) return;
    if (!activo && !(await confirmarAccion(`¿Pausar el pedido fijo de ${f.cliente_nombre}? No se crearán pedidos hasta que lo reanudes.`))) return;
    const r = await avisoError(() => apiFetch(`/pedidos/fijos/${id}`, { method: 'PUT', body: JSON.stringify(cuerpoDeFijo(f, { activo })) }));
    if (r) { mostrarToast(activo ? 'Pedido fijo reanudado' : 'Pedido fijo en pausa', 'exito'); cargarFijos(); }
  }

  async function quitarFijo(id) {
    const f = FIJOS.find((x) => x.id === id);
    if (!f || !(await confirmarAccion(`¿Quitar el pedido fijo de ${f.cliente_nombre}? Los pedidos que ya se crearon no se tocan.`))) return;
    const r = await avisoError(() => apiFetch(`/pedidos/fijos/${id}`, { method: 'DELETE' }));
    if (r) { mostrarToast('Pedido fijo quitado', 'exito'); cargarFijos(); }
  }

  async function generarFijosAhora() {
    const f = U.sumarDias(PT.estado.hoy, 1);
    if (!(await confirmarAccion(`¿Crear ahora los pedidos fijos de mañana (${U.fechaLarga(f)})? Si ya existían no se duplican.`))) return;
    const r = await avisoError(() => apiFetch('/pedidos/fijos/generar', { method: 'POST', body: JSON.stringify({ fecha: f }) }));
    if (!r) return;
    mostrarToast(`Se crearon ${r.creados} ${r.creados === 1 ? 'pedido' : 'pedidos'}${r.omitidos ? ` (${r.omitidos} ya existían)` : ''}`, r.errores.length ? 'error' : 'exito');
    if (r.errores.length) mostrarToast(r.errores.join(' · '), 'error', 7000);
    PT.recargar();
  }

  async function editarFijo(id) {
    const cat = await avisoError(productos);
    if (!cat) return;
    const zonas = await apiFetch('/pedidos/zonas').then((z) => z.zonas).catch(() => []);
    const reps = PT.estado.reps.length ? PT.estado.reps : await apiFetch('/pedidos/repartidores').catch(() => []);
    const orig = id ? FIJOS.find((x) => x.id === id) : null;
    const F = {
      id, cliente: null, dirs: [], nombre: orig ? orig.nombre || '' : '', tipo: orig ? orig.tipo : 'domicilio', dirId: orig ? orig.direccion_id : null,
      dias: new Set(orig ? String(orig.dias).split(',').map(Number) : []), hora: orig ? orig.hora : '09:00', repId: orig ? orig.repartidor_id : null, zonaId: orig ? orig.zona_id : null,
      pago: orig ? orig.pago_modo : 'credito', items: orig ? (orig.items || []).map((i) => ({ ...i })) : [], notas: orig ? orig.notas || '' : '', activo: orig ? orig.activo : true
    };
    if (orig) {
      const cs = await apiFetch('/pedidos/clientes?q=' + encodeURIComponent(orig.cliente_nombre)).catch(() => []);
      F.cliente = cs.find((c) => c.id === orig.cliente_id) || { id: orig.cliente_id, nombre: orig.cliente_nombre, telefono: orig.cliente_telefono, tipo: orig.cliente_tipo, direcciones: [], usa_mayoreo: false };
      F.dirs = F.cliente.direcciones || [];
    }
    const m = abrirModal({ titulo: orig ? 'Editar pedido fijo' : 'Nuevo pedido fijo de tienda', ancho: 860 });

    const precioDe = (producto) => {
      if (!producto) return 0;
      const may = parseFloat(producto.precio_mayoreo);
      return F.cliente && F.cliente.usa_mayoreo && may > 0 ? may : parseFloat(producto.precio) || 0;
    };
    const totalFijo = () => r2(F.items.reduce((s, i) => s + (Number(i.cantidad) || 0) * precioDe(cat.find((p) => p.id === i.producto_id)), 0));

    function pintarItems() {
      const cont = m.el.querySelector('#fx_items');
      if (!cont) return;
      cont.innerHTML = F.items.length ? `<table class="pt-tabla"><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead><tbody>
        ${F.items.map((i, n) => { const p = cat.find((x) => x.id === i.producto_id); const pr = precioDe(p); return `<tr><td>${esc(i.nombre)}</td>
          <td class="num"><input type="number" min="0" step="any" value="${esc(i.cantidad)}" data-n="${n}" class="fx_cant" style="width:90px"> ${p && p.tipo_venta === 'peso' ? 'kg' : 'pza'}</td>
          <td class="num">${dinero(pr)}</td><td class="num"><b>${dinero((Number(i.cantidad) || 0) * pr)}</b></td>
          <td><button type="button" class="pd-mini fx_quitar" data-n="${n}">✕</button></td></tr>`; }).join('')}</tbody></table>`
        : '<div class="pt-vacia">Agrega los productos que pide cada vez.</div>';
      m.el.querySelector('#fx_total').textContent = dinero(totalFijo());
      cont.querySelectorAll('.fx_cant').forEach((inp) => {
        inp.oninput = () => { F.items[Number(inp.dataset.n)].cantidad = Number(inp.value); m.el.querySelector('#fx_total').textContent = dinero(totalFijo()); inp.closest('tr').children[3].innerHTML = `<b>${dinero((Number(inp.value) || 0) * precioDe(cat.find((x) => x.id === F.items[Number(inp.dataset.n)].producto_id)))}</b>`; };
      });
      cont.querySelectorAll('.fx_quitar').forEach((b) => { b.onclick = () => { F.items.splice(Number(b.dataset.n), 1); pintarItems(); }; });
    }

    function pintar() {
      const dom = F.tipo === 'domicilio';
      const c = F.cliente;
      m.html(`
        <div class="pt-bloque"><h4>Cliente</h4>${c
          ? `<div class="pd-cliente-sel"><div class="pd-avatar">${esc(U.iniciales(c.nombre))}</div><div class="info"><b>${esc(c.nombre)} ${c.tipo === 'tienda' ? '<span class="pd-tag azul">Tienda</span>' : ''}${c.usa_mayoreo ? '<span class="pd-tag ok">Mayoreo</span>' : ''}</b><small>${esc(c.telefono || '')}${c.limite_credito ? ` · crédito: límite ${dinero(c.limite_credito)}${c.saldo_actual ? ', debe ' + dinero(c.saldo_actual) : ''}` : ''}</small></div>${orig ? '' : '<button type="button" class="pd-link" id="fx_cambiar">Cambiar</button>'}</div>`
          : `<input type="search" id="fx_cliente" placeholder="🔍 Busca la tienda por nombre o teléfono…" autocomplete="off"><div id="fx_resultados"></div>`}</div>
        <div class="pt-bloque"><div class="pd-fila f2">
            <div><label class="pd-etq" for="fx_nombre">Nombre del pedido (opcional)</label><input type="text" id="fx_nombre" maxlength="100" value="${esc(F.nombre)}" placeholder="Ej. Pedido semanal"></div>
            <div><label class="pd-etq">Entrega</label><div class="pd-seg"><button type="button" class="${dom ? 'activo' : ''}" id="fx_dom">🛵 A domicilio</button><button type="button" class="${dom ? '' : 'activo'}" id="fx_rec">🏪 Para recoger</button></div></div></div>
          ${dom ? `<label class="pd-etq" for="fx_dir">Dirección de entrega</label><select id="fx_dir">${F.dirs.length ? F.dirs.map((d) => `<option value="${d.id}" ${F.dirId === d.id ? 'selected' : ''}>${esc((d.alias ? d.alias + ' — ' : '') + [d.calle, d.colonia].filter(Boolean).join(', '))}</option>`).join('') : '<option value="">(el cliente no tiene direcciones guardadas)</option>'}</select>` : ''}
          <label class="pd-etq">Días de entrega</label><div class="pt-dias" id="fx_dias">${DIAS_ORDEN.map((d) => `<button type="button" data-d="${d.v}" class="${F.dias.has(d.v) ? 'on' : ''}">${d.t}</button>`).join('')}</div>
          <div class="pd-fila f2"><div><label class="pd-etq" for="fx_hora">Hora de entrega</label><input type="time" id="fx_hora" value="${esc(F.hora)}"></div>
            ${dom ? `<div><label class="pd-etq" for="fx_rep">Repartidor</label><select id="fx_rep"><option value="">Sin asignar</option>${reps.map((r) => `<option value="${r.id}" ${F.repId === r.id ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select></div>` : '<div></div>'}</div>
          ${dom ? `<label class="pd-etq" for="fx_zona">Zona de envío (opcional: si no, usa la de la dirección)</label><select id="fx_zona"><option value="">Según la dirección</option>${zonas.map((z) => `<option value="${z.id}" ${F.zonaId === z.id ? 'selected' : ''}>${esc(z.nombre)} · ${dinero(z.costo)}</option>`).join('')}</select>` : ''}</div>
        <div class="pt-bloque"><h4>Lo que pide cada vez</h4><div id="fx_items"></div>
          <label class="pd-etq" for="fx_buscar">＋ Agregar producto</label><input type="search" id="fx_buscar" placeholder="Escribe el nombre del producto…" autocomplete="off"><div id="fx_res"></div>
          <div class="pd-total" style="font-size:20px"><span>Total por entrega</span><span id="fx_total">$0.00</span></div>
          <div class="pd-nota">Precios de hoy${c && c.usa_mayoreo ? ' (mayoreo)' : ''}; al crear cada pedido se usa el precio vigente ese día.</div></div>
        <div class="pt-bloque"><div class="pd-fila f2"><div><label class="pd-etq" for="fx_pago">Cómo paga</label><select id="fx_pago">
            ${dom ? `<option value="al_recibir" ${F.pago === 'al_recibir' ? 'selected' : ''}>Paga al recibir (cobra el repartidor)</option>` : ''}
            <option value="pagado" ${F.pago === 'pagado' ? 'selected' : ''}>${dom ? 'Se cobra en Caja' : 'Paga al recoger (en Caja)'}</option>
            <option value="credito" ${F.pago === 'credito' ? 'selected' : ''}>A crédito de la tienda</option></select></div>
          <div><label class="pd-etq" for="fx_notas">Notas</label><input type="text" id="fx_notas" maxlength="300" value="${esc(F.notas)}"></div></div>
          <div class="pd-error" id="fx_error"></div></div>`);
      m.botones('<button type="button" class="btn btn-secondary" id="fx_cancelar">Cancelar</button><button type="button" class="btn btn-primary" id="fx_guardar">💾 Guardar pedido fijo</button>');
      pintarItems();

      const q = (s) => m.el.querySelector(s);
      if (q('#fx_cambiar')) q('#fx_cambiar').onclick = () => { F.cliente = null; F.dirs = []; F.dirId = null; pintar(); };
      const bus = q('#fx_cliente');
      if (bus) {
        let t = null;
        bus.oninput = () => {
          clearTimeout(t);
          const v = bus.value.trim();
          if (v.length < 2) { q('#fx_resultados').innerHTML = ''; return; }
          t = setTimeout(async () => {
            const rs = await apiFetch('/pedidos/clientes?q=' + encodeURIComponent(v)).catch(() => []);
            q('#fx_resultados').innerHTML = rs.length ? rs.map((c, n) => `<button type="button" class="pd-res" data-n="${n}"><span class="pd-avatar">${esc(U.iniciales(c.nombre))}</span><span><b>${esc(c.nombre)}${c.tipo === 'tienda' ? ' <span class="pd-tag azul">Tienda</span>' : ''}</b><small>${esc(c.telefono || '')} · ${c.direcciones.length} direcciones</small></span></button>`).join('') : '<div class="pd-vacio">No encontré a nadie. Primero crea al cliente en Clientes.</div>';
            q('#fx_resultados').querySelectorAll('.pd-res').forEach((b) => {
              b.onclick = () => {
                F.cliente = rs[Number(b.dataset.n)]; F.dirs = F.cliente.direcciones || []; F.dirId = F.dirs.length ? F.dirs[0].id : null;
                if (!orig) F.pago = F.cliente.tipo === 'tienda' ? 'credito' : (F.tipo === 'domicilio' ? 'al_recibir' : 'pagado');
                if (F.dirs[0] && F.dirs[0].zona_id) F.zonaId = null;
                pintar();
              };
            });
          }, 250);
        };
        setTimeout(() => bus.focus(), 50);
      }
      q('#fx_nombre').oninput = (e) => { F.nombre = e.target.value; };
      q('#fx_dom').onclick = () => { F.tipo = 'domicilio'; if (F.pago !== 'al_recibir' && F.pago !== 'credito' && F.pago !== 'pagado') F.pago = 'credito'; pintar(); };
      q('#fx_rec').onclick = () => { F.tipo = 'recoger'; if (F.pago === 'al_recibir') F.pago = 'pagado'; pintar(); };
      if (q('#fx_dir')) q('#fx_dir').onchange = (e) => { F.dirId = Number(e.target.value) || null; };
      q('#fx_dias').querySelectorAll('button').forEach((b) => { b.onclick = () => { const d = Number(b.dataset.d); if (F.dias.has(d)) F.dias.delete(d); else F.dias.add(d); b.classList.toggle('on'); }; });
      q('#fx_hora').oninput = (e) => { F.hora = e.target.value; };
      if (q('#fx_rep')) q('#fx_rep').onchange = (e) => { F.repId = Number(e.target.value) || null; };
      if (q('#fx_zona')) q('#fx_zona').onchange = (e) => { F.zonaId = Number(e.target.value) || null; };
      q('#fx_pago').onchange = (e) => { F.pago = e.target.value; };
      q('#fx_notas').oninput = (e) => { F.notas = e.target.value; };
      const buscar = q('#fx_buscar');
      buscar.oninput = () => {
        const v = U.norm(buscar.value);
        const res = q('#fx_res');
        if (v.length < 2) { res.innerHTML = ''; return; }
        const hay = cat.filter((p) => p.activo !== false && (U.norm(p.nombre).includes(v) || String(p.codigo_barras || '').includes(v))).slice(0, 8);
        res.innerHTML = hay.length ? hay.map((p) => `<button type="button" class="pd-res" data-id="${p.id}"><span><b>${esc(p.nombre)}</b><small>${dinero(p.precio)}${p.tipo_venta === 'peso' ? ' / kg' : ''}${parseFloat(p.precio_mayoreo) > 0 ? ' · mayoreo ' + dinero(p.precio_mayoreo) : ''}</small></span></button>`).join('') : '<div class="pd-vacio">Sin resultados</div>';
        res.querySelectorAll('.pd-res').forEach((b) => {
          b.onclick = () => {
            const p = cat.find((x) => x.id === Number(b.dataset.id));
            const ya = F.items.find((i) => i.producto_id === p.id);
            if (ya) ya.cantidad = Number(ya.cantidad) + 1; else F.items.push({ producto_id: p.id, nombre: p.nombre, cantidad: 1 });
            buscar.value = ''; res.innerHTML = ''; pintarItems(); buscar.focus();
          };
        });
      };
      q('#fx_cancelar').onclick = () => m.cerrar();
      q('#fx_guardar').onclick = async () => {
        const err = q('#fx_error');
        err.classList.remove('visible');
        const fallo = (t) => { err.textContent = t; err.classList.add('visible'); err.scrollIntoView({ block: 'nearest' }); };
        if (!F.cliente) return fallo('Elige al cliente.');
        if (!F.dias.size) return fallo('Elige al menos un día de entrega.');
        if (!/^\d{2}:\d{2}$/.test(F.hora || '')) return fallo('Pon la hora de entrega.');
        if (F.tipo === 'domicilio' && !F.dirId) return fallo('El cliente necesita una dirección guardada (agrégala en Clientes o haz un pedido a domicilio con ella).');
        if (!F.items.length) return fallo('Agrega al menos un producto.');
        if (F.items.some((i) => !(Number(i.cantidad) > 0))) return fallo('Revisa las cantidades: deben ser mayores a 0.');
        const cuerpo = {
          cliente_id: F.cliente.id, direccion_id: F.tipo === 'domicilio' ? F.dirId : null, nombre: F.nombre, dias: [...F.dias].sort(), hora: F.hora, tipo: F.tipo, pago_modo: F.pago,
          zona_id: F.tipo === 'domicilio' ? F.zonaId : null, repartidor_id: F.tipo === 'domicilio' ? F.repId : null,
          items: F.items.map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: Number(i.cantidad) })), notas: F.notas, activo: F.activo
        };
        try {
          await apiFetch(F.id ? `/pedidos/fijos/${F.id}` : '/pedidos/fijos', { method: F.id ? 'PUT' : 'POST', body: JSON.stringify(cuerpo) });
          mostrarToast('Pedido fijo guardado', 'exito');
          m.cerrar(); cargarFijos();
        } catch (e) { fallo(e.message); }
      };
    }
    pintar();
  }

  // =================================================================== RUTA DEL DÍA
  async function abrirRuta(fecha) {
    const reps = PT.estado.reps.length ? PT.estado.reps : await apiFetch('/pedidos/repartidores').catch(() => []);
    const m = abrirModal({ titulo: `🗺 Ruta · ${U.fechaLarga(fecha)}`, ancho: 780 });
    let filtro = '', lista = [];
    const cargar = async () => {
      lista = await avisoError(() => apiFetch(`/pedidos/ruta?fecha=${fecha}${filtro ? '&repartidor_id=' + filtro : ''}`)) || [];
      pintar();
    };
    function pintar() {
      const sel = reps.find((r) => String(r.id) === filtro);
      const urlMaps = UBICACION.urlGoogleMapsRuta(lista.slice(0, 10));
      m.html(`<div class="pt-bloque"><label class="pd-etq" for="rt_rep" style="margin-top:0">Ruta de</label><select id="rt_rep"><option value="">Todos los repartidores</option><option value="ninguno" ${filtro === 'ninguno' ? 'selected' : ''}>Sin repartidor asignado</option>${reps.map((r) => `<option value="${r.id}" ${filtro === String(r.id) ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select>
        <div class="pd-nota">Se ordena por hora. Usa las flechas para cambiar el orden de las paradas; el repartidor las ve en ese orden en su celular.</div></div>
        <div class="pt-bloque">${lista.length ? lista.map((p, n) => `<div class="pt-ruta-fila"><span class="num">${n + 1}</span>
          <div><b>${p.programado_para ? hora12(p.programado_para) : 'Lo antes posible'}</b> · ${esc(p.nombre_contacto)}<small>${esc(UBICACION.textoDireccion(p) || 'Sin dirección')} · ${esc(U.ESTADO_TXT[p.estado])}${p.repartidor_nombre ? ' · ' + esc(U.primerNombre(p.repartidor_nombre)) : ''}</small></div>
          <div class="pt-flechas"><b style="margin-right:8px">${dinero(p.total_neto)}</b><button type="button" data-n="${n}" data-d="-1" ${n === 0 ? 'disabled' : ''}>↑</button><button type="button" data-n="${n}" data-d="1" ${n === lista.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('')
          : '<div class="pt-vacia" style="padding:24px">No hay entregas a domicilio por hacer ese día.</div>'}</div>
        ${lista.length > 10 ? '<div class="pt-aviso amarillo">Google Maps solo acepta 10 paradas: se abrirán las primeras 10.</div>' : ''}`);
      m.botones(`${urlMaps ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="${esc(urlMaps)}">🗺 Abrir ruta en Google Maps</a>` : ''}
        ${sel && lleno(sel.telefono) && lista.length ? '<a class="btn btn-secondary" id="rt_wa" target="_blank" rel="noopener">📲 Mandar la ruta por WhatsApp</a>' : ''}
        <button type="button" class="btn btn-secondary" id="rt_imp">🖨 Imprimir</button>`);
      m.el.querySelector('#rt_rep').onchange = (e) => { filtro = e.target.value; cargar(); };
      m.el.querySelectorAll('.pt-flechas button').forEach((b) => {
        b.onclick = async () => {
          const n = Number(b.dataset.n), d = Number(b.dataset.d);
          [lista[n], lista[n + d]] = [lista[n + d], lista[n]];
          pintar();
          await avisoError(() => apiFetch('/pedidos/ruta/orden', { method: 'PUT', body: JSON.stringify({ ids: lista.map((x) => x.id) }) }));
        };
      });
      const wa = m.el.querySelector('#rt_wa');
      if (wa) {
        const texto = `🛵 Ruta ${U.fechaLarga(fecha)}\n` + lista.map((p, n) => `${n + 1}. ${p.programado_para ? hora12(p.programado_para) + ' · ' : ''}${p.nombre_contacto} — ${UBICACION.textoDireccion(p)}\n   ${UBICACION.urlWaze(p)}${p.por_cobrar ? `\n   💵 Cobrar ${dinero(p.total_neto)}` : ''}`).join('\n');
        wa.href = UBICACION.urlWhatsApp(sel.telefono, texto) || '#';
      }
      m.el.querySelector('#rt_imp').onclick = () => imprimirContenido(`<h2>Ruta ${esc(U.fechaLarga(fecha))}${sel ? ' · ' + esc(sel.nombre) : ''}</h2>`
        + lista.map((p, n) => `<p><b>${n + 1}. ${p.programado_para ? hora12(p.programado_para) : 'Pronto'} — ${esc(p.nombre_contacto)}</b> ${esc(p.telefono || '')}<br>${esc(UBICACION.textoDireccion(p))}${p.referencias ? '<br><i>' + esc(p.referencias) + '</i>' : ''}<br>${p.por_cobrar ? 'COBRAR ' + dinero(p.total_neto) : 'Ya pagado'}</p>`).join(''));
    }
    cargar();
  }

  // =================================================================== HOJA DE PRODUCCIÓN
  async function abrirProduccion(fecha) {
    const m = abrirModal({ titulo: `📋 Hoja de producción · ${U.fechaLarga(fecha)}`, ancho: 760 });
    let todos = false, datos = null;
    async function cargar() {
      datos = await avisoError(() => apiFetch(`/pedidos/produccion?fecha=${fecha}${todos ? '&todos=1' : ''}`));
      pintar();
    }
    const unidad = (x) => (x.tipo_venta === 'peso' ? kg(x.cantidad) + ' kg' : kg(x.cantidad) + ' pza');
    function contenido() {
      return `<table class="pt-tabla"><thead><tr><th>Producto</th><th class="num">Preparar</th><th class="num">Pedidos</th></tr></thead><tbody>
        ${datos.productos.map((x) => `<tr><td><b>${esc(x.nombre)}</b></td><td class="num"><b>${unidad(x)}</b></td><td class="num">${x.pedidos}</td></tr>`).join('')}</tbody></table>
        <h4 style="margin:16px 0 6px">Por pedido</h4>
        ${datos.pedidos.map((p) => `<p style="margin:6px 0"><b>${p.hora ? hora12(p.hora) : 'Pronto'} · ${esc(p.cliente)}</b> ${p.tipo === 'recoger' ? '(recoge)' : p.repartidor_nombre ? '(' + esc(U.primerNombre(p.repartidor_nombre)) + ')' : ''}<br>${p.items.map((i) => `${i.tipo_venta === 'peso' ? kg(i.cantidad) + ' kg' : kg(i.cantidad)} ${esc(i.nombre)}`).join(' · ')}</p>`).join('')}`;
    }
    function pintar() {
      if (!datos) { m.html('<div class="pt-vacia">No se pudo armar la hoja.</div>'); return; }
      m.html(`<div class="pt-bloque"><label class="pd-imprimir"><input type="checkbox" id="pr_todos" ${todos ? 'checked' : ''}> Incluir también lo que ya está listo, en camino o entregado</label></div>
        <div class="pt-bloque">${datos.productos.length ? contenido() : '<div class="pt-vacia" style="padding:24px">No hay nada por preparar ese día.</div>'}</div>`);
      m.botones('<button type="button" class="btn btn-primary" id="pr_imp">🖨 Imprimir hoja</button>');
      m.el.querySelector('#pr_todos').onchange = (e) => { todos = e.target.checked; cargar(); };
      m.el.querySelector('#pr_imp').onclick = () => imprimirContenido(`<h2>Producción · ${esc(U.fechaLarga(fecha))}</h2>` + (datos.productos.length ? contenido() : '<p>Nada por preparar.</p>'));
    }
    cargar();
  }

  // =================================================================== LIQUIDACIÓN DEL REPARTIDOR
  const COBRO_TXT = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', pagado_antes: 'Pagado antes', credito: 'A crédito', ya_cobrado_en_caja: 'Ya cobrado en Caja' };

  async function liquidar(repartidorId) {
    const [liq, turno] = await Promise.all([avisoError(() => apiFetch(`/pedidos/liquidacion/${repartidorId}`)), apiFetch('/turnos/actual').catch(() => null)]);
    if (!liq) return;
    const nombre = liq.repartidor ? liq.repartidor.nombre : 'Repartidor';
    const m = abrirModal({ titulo: `💵 Liquidar a ${esc(nombre)}`, ancho: 760 });
    const marcados = new Set(liq.pedidos.map((p) => p.id));
    const calc = () => {
      const t = { efectivo: 0, transferencia: 0, tarjeta: 0 };
      liq.pedidos.filter((p) => marcados.has(p.id) && t[p.cobro] !== undefined).forEach((p) => { t[p.cobro] = r2(t[p.cobro] + p.total_neto); });
      return t;
    };
    function pintar(valorEntregado) {
      const t = calc();
      const entregado = valorEntregado === undefined ? t.efectivo : valorEntregado;
      const dif = r2(entregado - t.efectivo);
      m.html(`${turno ? '' : '<div class="pt-aviso amarillo"><b>Primero abre tu turno de caja</b> para poder recibir el dinero. <a href="caja-turno.html" class="pd-link">Ir a Corte de Caja</a></div>'}
        <div class="pt-bloque"><h4>Entregas por liquidar (${liq.entregadas} entregadas${liq.no_entregadas ? ', ' + liq.no_entregadas + ' no entregadas' : ''})</h4>
          ${liq.pedidos.length ? `<ul class="pt-linea">${liq.pedidos.map((p) => `<li><label style="display:flex; gap:9px; align-items:center; cursor:pointer"><input type="checkbox" data-id="${p.id}" ${marcados.has(p.id) ? 'checked' : ''}><span><b>${esc(p.etiqueta)}</b> ${esc(p.nombre_contacto)}<br><small style="color:var(--muted)">${esc(COBRO_TXT[p.cobro] || p.cobro)}${p.estado === 'no_entregado' ? ' · no entregado' : ''}</small></span></label><b>${dinero(p.total_neto)}</b></li>`).join('')}</ul>` : '<div class="pt-vacia">Nada por liquidar.</div>'}</div>
        <div class="pt-bloque"><h4>Lo que tiene que entregar</h4>
          <div class="pt-dato"><span>💵 Efectivo cobrado</span><span style="font-size:20px">${dinero(t.efectivo)}</span></div>
          <div class="pt-dato"><span>🏦 Transferencias</span><span>${dinero(t.transferencia)}</span></div>
          <div class="pt-dato"><span>💳 Tarjeta</span><span>${dinero(t.tarjeta)}</span></div>
          <label class="pd-etq" for="lq_entregado">Efectivo que entrega ahora</label><input type="number" id="lq_entregado" min="0" step="any" value="${entregado}">
          <div class="pd-nota" id="lq_dif" style="font-size:14px; font-weight:700; color:${dif === 0 ? 'var(--primary-dark)' : '#B3261E'}">${dif === 0 ? '✔ Cuadra exacto' : dif > 0 ? `Sobran ${dinero(dif)}` : `Faltan ${dinero(-dif)}`}</div>
          <label class="pd-etq" for="lq_notas">Notas (opcional)</label><input type="text" id="lq_notas" maxlength="300" placeholder="Ej. dejó $50 de cambio"></div>
        <div class="pd-error" id="lq_error"></div>`);
      m.botones('<button type="button" class="btn btn-secondary" id="lq_cancelar">Cancelar</button><button type="button" class="btn btn-primary" id="lq_ok">✔ Recibir y liquidar</button>');
      m.el.querySelectorAll('input[type=checkbox][data-id]').forEach((c) => { c.onchange = () => { const id = Number(c.dataset.id); if (c.checked) marcados.add(id); else marcados.delete(id); pintar(); }; });
      const inp = m.el.querySelector('#lq_entregado');
      inp.oninput = () => {
        const d = r2((Number(inp.value) || 0) - t.efectivo);
        const e = m.el.querySelector('#lq_dif');
        e.textContent = d === 0 ? '✔ Cuadra exacto' : d > 0 ? `Sobran ${dinero(d)}` : `Faltan ${dinero(-d)}`;
        e.style.color = d === 0 ? 'var(--primary-dark)' : '#B3261E';
      };
      m.el.querySelector('#lq_cancelar').onclick = () => m.cerrar();
      m.el.querySelector('#lq_ok').onclick = async () => {
        const err = m.el.querySelector('#lq_error');
        err.classList.remove('visible');
        if (!turno) { err.textContent = 'Abre tu turno de caja para recibir el dinero.'; err.classList.add('visible'); return; }
        if (!marcados.size) { err.textContent = 'Marca al menos una entrega.'; err.classList.add('visible'); return; }
        const dif2 = r2((Number(inp.value) || 0) - t.efectivo);
        if (dif2 !== 0 && !(await confirmarAccion(dif2 > 0 ? `Sobran ${dinero(dif2)}. ¿Registrar la liquidación así?` : `Faltan ${dinero(-dif2)}. ¿Registrar la liquidación así?`))) return;
        try {
          const cuerpo = { repartidor_id: repartidorId, turno_id: turno.id, efectivo_entregado: Number(inp.value) || 0, notas: (m.el.querySelector('#lq_notas') || {}).value || '' };
          if (marcados.size !== liq.pedidos.length) cuerpo.pedido_ids = [...marcados];
          const r = await apiFetch('/pedidos/liquidar', { method: 'POST', body: JSON.stringify(cuerpo) });
          m.cerrar();
          mostrarToast(`Liquidación lista: ${r.liquidacion.diferencia === 0 ? 'cuadró exacto' : (r.liquidacion.diferencia > 0 ? 'sobraron ' : 'faltaron ') + dinero(Math.abs(r.liquidacion.diferencia))}`, 'exito');
          if (r.productos_agotados && r.productos_agotados.length) mostrarToast('Se agotó: ' + r.productos_agotados.join(', '), 'error', 7000);
          PT.recargar();
        } catch (e) { err.textContent = e.message; err.classList.add('visible'); }
      };
    }
    pintar();
  }

  async function abrirLiquidaciones() {
    const l = await avisoError(() => apiFetch('/pedidos/liquidaciones'));
    if (!l) return;
    abrirModal({ titulo: '💵 Liquidaciones de repartidores', ancho: 900, cuerpo: l.length ? `<div class="pt-bloque" style="overflow-x:auto"><table class="pt-tabla"><thead><tr><th>Fecha</th><th>Repartidor</th><th class="num">Pedidos</th><th class="num">Debía</th><th class="num">Entregó</th><th class="num">Diferencia</th><th>Recibió</th></tr></thead><tbody>
      ${l.map((x) => `<tr><td>${new Date(x.creada_en).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td><td>${esc(x.repartidor_nombre)}</td><td class="num">${x.num_pedidos}</td><td class="num">${dinero(x.esperado_efectivo)}</td><td class="num">${dinero(x.entregado_efectivo)}</td><td class="num" style="color:${x.diferencia === 0 ? 'inherit' : '#B3261E'}"><b>${dinero(x.diferencia)}</b></td><td>${esc(x.recibido_por_nombre || '')}</td></tr>${x.notas ? `<tr><td></td><td colspan="6" style="color:var(--muted)">${esc(x.notas)}</td></tr>` : ''}`).join('')}</tbody></table></div>` : '<div class="pt-vacia" style="padding:30px">Todavía no hay liquidaciones.</div>' });
  }

  // =================================================================== REPORTE DE REPARTIDORES
  async function abrirReporte() {
    const hoy = PT.estado.hoy || new Date().toISOString().slice(0, 10);
    const m = abrirModal({ titulo: '📊 Reporte de repartidores', ancho: 900 });
    let desde = U.sumarDias(hoy, -6), hasta = hoy;
    async function cargar() {
      const r = await apiFetch(`/pedidos/reporte-repartidores?desde=${desde}&hasta=${hasta}`).catch((e) => ({ error: e.message }));
      m.html(`<div class="pt-bloque"><div class="pd-fila f2"><div><label class="pd-etq" style="margin-top:0" for="rp_d">Desde</label><input type="date" id="rp_d" value="${desde}"></div><div><label class="pd-etq" style="margin-top:0" for="rp_h">Hasta</label><input type="date" id="rp_h" value="${hasta}"></div></div></div>
        <div class="pt-bloque" style="overflow-x:auto">${r.error ? `<div class="pt-vacia">${esc(r.error)}</div>` : r.length ? `<table class="pt-tabla"><thead><tr><th>Repartidor</th><th class="num">Entregas</th><th class="num">No entregadas</th><th class="num">Vendido</th><th class="num">Min. promedio</th><th class="num">A tiempo</th><th class="num">Liquidaciones</th><th class="num">Diferencia</th></tr></thead><tbody>
          ${r.map((x) => `<tr><td><b>${esc(x.nombre)}</b></td><td class="num">${x.entregas}</td><td class="num">${x.no_entregadas}</td><td class="num">${dinero(x.total_entregado)}</td><td class="num">${x.min_promedio} min</td><td class="num">${x.con_hora ? Math.round(x.a_tiempo * 100 / x.con_hora) + '% (' + x.a_tiempo + '/' + x.con_hora + ')' : '—'}</td><td class="num">${x.liquidaciones}</td><td class="num" style="color:${x.diferencia === 0 ? 'inherit' : '#B3261E'}">${dinero(x.diferencia)}</td></tr>`).join('')}</tbody></table>
          <div class="pd-nota">“A tiempo” = entregado a más tardar 10 minutos después de la hora prometida (solo pedidos con hora).</div>` : '<div class="pt-vacia" style="padding:24px">No hay entregas en esas fechas.</div>'}</div>`);
      m.el.querySelector('#rp_d').onchange = (e) => { if (e.target.value) { desde = e.target.value; cargar(); } };
      m.el.querySelector('#rp_h').onchange = (e) => { if (e.target.value) { hasta = e.target.value; cargar(); } };
    }
    cargar();
  }

  // =================================================================== ZONAS DE ENVÍO Y AJUSTES
  async function abrirAjustes() {
    const [z, cfg] = await Promise.all([avisoError(() => apiFetch('/pedidos/zonas?todas=1')), apiFetch('/configuracion').catch(() => ({}))]);
    if (!z) return;
    const m = abrirModal({ titulo: '⚙ Zonas de envío y ajustes de pedidos', ancho: 860 });
    let zonas = z.zonas;
    function pintar() {
      m.html(`<div class="pt-bloque"><h4>Zonas de envío</h4>
          <div class="pd-nota" style="margin:0 0 8px">Cada zona tiene su costo. “Envío gratis desde” es opcional: si lo dejas vacío usa el monto general de abajo.</div>
          <div style="overflow-x:auto"><table class="pt-tabla"><thead><tr><th>Zona</th><th class="num">Costo</th><th class="num">Gratis desde</th><th>Activa</th><th></th></tr></thead><tbody>
          ${zonas.map((x, n) => `<tr data-n="${n}"><td><input type="text" class="zn" value="${esc(x.nombre)}" maxlength="80"></td><td class="num"><input type="number" class="zc" min="0" step="any" value="${x.costo}" style="width:90px"></td>
            <td class="num"><input type="number" class="zg" min="0" step="any" value="${x.envio_gratis_desde === null || x.envio_gratis_desde === undefined ? '' : x.envio_gratis_desde}" placeholder="general" style="width:100px"></td>
            <td><input type="checkbox" class="za" ${x.activo ? 'checked' : ''}></td><td><button type="button" class="pd-mini zs">Guardar</button></td></tr>`).join('')}
          <tr data-n="nueva"><td><input type="text" class="zn" placeholder="Nueva zona (ej. Zona 4: más de 9 km)" maxlength="80"></td><td class="num"><input type="number" class="zc" min="0" step="any" placeholder="0" style="width:90px"></td><td class="num"><input type="number" class="zg" min="0" step="any" placeholder="general" style="width:100px"></td><td></td><td><button type="button" class="pd-mini zs">＋ Agregar</button></td></tr></tbody></table></div></div>
        <div class="pt-bloque"><h4>Ajustes generales</h4>
          <div class="pd-fila f2"><div><label class="pd-etq" style="margin-top:0" for="aj_gratis">Envío gratis desde (general)</label><input type="number" id="aj_gratis" min="0" step="any" value="${Number(cfg.pedidos_envio_gratis_desde || 0)}"><div class="pd-nota">0 = nunca es gratis (salvo que la zona lo defina).</div></div>
            <div><label class="pd-etq" style="margin-top:0" for="aj_prep">Minutos de anticipación para preparar</label><input type="number" id="aj_prep" min="0" max="1440" value="${cfg.pedidos_min_preparacion === undefined ? 30 : Number(cfg.pedidos_min_preparacion)}"><div class="pd-nota">Un pedido programado pasa solo a “Preparando” esos minutos antes de su hora.</div></div></div>
          <div class="pd-fila f2"><div><label class="pd-etq" for="aj_hora">Hora para crear los pedidos fijos de mañana</label><input type="time" id="aj_hora" value="${esc(cfg.pedidos_hora_aviso_fijos || '18:00')}"></div><div></div></div>
          <label class="pd-imprimir" style="margin-top:12px"><input type="checkbox" id="aj_foto" ${cfg.pedidos_foto_obligatoria ? 'checked' : ''}> El repartidor debe tomar <b>foto</b> al entregar</label>
          <label class="pd-imprimir" style="margin-top:8px"><input type="checkbox" id="aj_firma" ${cfg.pedidos_firma_obligatoria ? 'checked' : ''}> El cliente debe <b>firmar</b> al recibir</label>
          <div class="pd-error" id="aj_error"></div></div>`);
      m.botones('<button type="button" class="btn btn-secondary" id="aj_cerrar">Cerrar</button><button type="button" class="btn btn-primary" id="aj_guardar">💾 Guardar ajustes</button>');
      m.el.querySelectorAll('tr[data-n]').forEach((tr) => {
        tr.querySelector('.zs').onclick = async () => {
          const n = tr.dataset.n;
          const cuerpo = { nombre: tr.querySelector('.zn').value, costo: tr.querySelector('.zc').value === '' ? 0 : Number(tr.querySelector('.zc').value), envio_gratis_desde: tr.querySelector('.zg').value === '' ? null : Number(tr.querySelector('.zg').value) };
          if (n !== 'nueva') { cuerpo.activo = tr.querySelector('.za').checked; cuerpo.orden = zonas[Number(n)].orden; }
          else cuerpo.orden = zonas.length + 1;
          const r = await avisoError(() => apiFetch(n === 'nueva' ? '/pedidos/zonas' : `/pedidos/zonas/${zonas[Number(n)].id}`, { method: n === 'nueva' ? 'POST' : 'PUT', body: JSON.stringify(cuerpo) }));
          if (r) {
            mostrarToast('Zona guardada', 'exito');
            const nuevo = await apiFetch('/pedidos/zonas?todas=1');
            zonas = nuevo.zonas; PT.estado.zonas = null; pintar();
          }
        };
      });
      m.el.querySelector('#aj_cerrar').onclick = () => m.cerrar();
      m.el.querySelector('#aj_guardar').onclick = async () => {
        const err = m.el.querySelector('#aj_error');
        err.classList.remove('visible');
        try {
          await apiFetch('/configuracion', { method: 'PUT', body: JSON.stringify({
            pedidos_envio_gratis_desde: Number(m.el.querySelector('#aj_gratis').value) || 0,
            pedidos_min_preparacion: Number(m.el.querySelector('#aj_prep').value) || 0,
            pedidos_hora_aviso_fijos: m.el.querySelector('#aj_hora').value || '18:00',
            pedidos_foto_obligatoria: m.el.querySelector('#aj_foto').checked,
            pedidos_firma_obligatoria: m.el.querySelector('#aj_firma').checked
          }) });
          mostrarToast('Ajustes guardados', 'exito');
        } catch (e) { err.textContent = e.message; err.classList.add('visible'); }
      };
    }
    pintar();
  }

  return { cargarFijos, editarFijo, pausarFijo, quitarFijo, generarFijosAhora, abrirRuta, abrirProduccion, liquidar, abrirLiquidaciones, abrirReporte, abrirAjustes, kg };
})();
window.PTX = PTX;
