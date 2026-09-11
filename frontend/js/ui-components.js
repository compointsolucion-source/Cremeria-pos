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
