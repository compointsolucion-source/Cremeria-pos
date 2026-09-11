// Componentes de UI compartidos: Toast (notificaciones) y Modal de confirmación.
// Reemplazan alert()/confirm() nativos del navegador por una experiencia más
// profesional y consistente en todo el sistema.

function asegurarContenedorToast() {
  let cont = document.getElementById('toastContainer');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'toastContainer';
    cont.className = 'toast-container';
    document.body.appendChild(cont);
  }
  return cont;
}

// tipo: 'info' (default), 'exito', 'error'
function mostrarToast(mensaje, tipo = 'info', duracionMs = 3500) {
  const cont = asegurarContenedorToast();
  const toast = document.createElement('div');
  toast.className = `toast ${tipo}`;
  toast.textContent = mensaje;
  cont.appendChild(toast);

  // Forzar reflow para que la transición de entrada se vea
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 250);
  }, duracionMs);
}

function asegurarModalConfirmacion() {
  let overlay = document.getElementById('modalConfirmGlobal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modalConfirmGlobal';
    overlay.className = 'modal-confirm-overlay';
    overlay.innerHTML = `
      <div class="modal-confirm-caja">
        <p id="modalConfirmMensaje"></p>
        <div class="modal-confirm-botones">
          <button class="btn btn-secondary" id="modalConfirmCancelar">Cancelar</button>
          <button class="btn btn-danger" id="modalConfirmAceptar">Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  return overlay;
}

function asegurarModalInput() {
  let overlay = document.getElementById('modalInputGlobal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modalInputGlobal';
    overlay.className = 'modal-confirm-overlay';
    overlay.innerHTML = `
      <div class="modal-confirm-caja">
        <p id="modalInputMensaje"></p>
        <input type="text" id="modalInputCampo" style="margin-bottom:14px;">
        <div class="modal-confirm-botones">
          <button class="btn btn-secondary" id="modalInputCancelar">Cancelar</button>
          <button class="btn btn-primary" id="modalInputAceptar">Aceptar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  return overlay;
}

// Reemplaza prompt(): devuelve una Promise<string|null>. Uso: const valor = await solicitarTexto('Mensaje', 'valor inicial');
function solicitarTexto(mensaje, valorInicial = '') {
  return new Promise((resolve) => {
    const overlay = asegurarModalInput();
    document.getElementById('modalInputMensaje').textContent = mensaje;
    const campo = document.getElementById('modalInputCampo');
    campo.value = valorInicial;
    overlay.classList.add('abierto');
    campo.focus();

    const limpiar = (resultado) => {
      overlay.classList.remove('abierto');
      botonAceptar.removeEventListener('click', onAceptar);
      botonCancelar.removeEventListener('click', onCancelar);
      campo.removeEventListener('keyup', onEnter);
      resolve(resultado);
    };
    const botonAceptar = document.getElementById('modalInputAceptar');
    const botonCancelar = document.getElementById('modalInputCancelar');
    const onAceptar = () => limpiar(campo.value);
    const onCancelar = () => limpiar(null);
    const onEnter = (e) => { if (e.key === 'Enter') limpiar(campo.value); };
    botonAceptar.addEventListener('click', onAceptar);
    botonCancelar.addEventListener('click', onCancelar);
    campo.addEventListener('keyup', onEnter);
  });
}
// Reemplaza confirm(): devuelve una Promise<boolean>. Uso: if (await confirmarAccion('¿Seguro?')) { ... }
function confirmarAccion(mensaje) {
  return new Promise((resolve) => {
    const overlay = asegurarModalConfirmacion();
    document.getElementById('modalConfirmMensaje').textContent = mensaje;
    overlay.classList.add('abierto');

    const limpiar = (resultado) => {
      overlay.classList.remove('abierto');
      botonAceptar.removeEventListener('click', onAceptar);
      botonCancelar.removeEventListener('click', onCancelar);
      resolve(resultado);
    };
    const botonAceptar = document.getElementById('modalConfirmAceptar');
    const botonCancelar = document.getElementById('modalConfirmCancelar');
    const onAceptar = () => limpiar(true);
    const onCancelar = () => limpiar(false);
    botonAceptar.addEventListener('click', onAceptar);
    botonCancelar.addEventListener('click', onCancelar);
  });
}
