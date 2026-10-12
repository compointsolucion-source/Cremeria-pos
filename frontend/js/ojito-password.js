// Pone el "ojito" para mostrar/ocultar la contraseña en TODOS los campos
// de contraseña del sistema (también los que se creen después).
(function () {
  const OJO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const OJO_TACHADO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

  function agregarOjito(input) {
    if (input.dataset.ojito || input.type !== 'password') return;
    input.dataset.ojito = '1';
    const cs = getComputedStyle(input);
    const envoltura = document.createElement('span');
    envoltura.style.cssText = 'position:relative;display:block;margin:' + cs.margin + ';';
    input.parentNode.insertBefore(envoltura, input);
    envoltura.appendChild(input);
    input.style.margin = '0';
    input.style.paddingRight = '46px';

    const boton = document.createElement('button');
    boton.type = 'button';
    boton.tabIndex = -1;
    boton.setAttribute('aria-label', 'Mostrar u ocultar contraseña');
    boton.innerHTML = OJO;
    boton.style.cssText = 'position:absolute;top:0;right:0;height:100%;width:44px;border:0;background:transparent;color:#777;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;';
    boton.addEventListener('click', function (e) {
      e.preventDefault();
      const ver = input.type === 'password';
      input.type = ver ? 'text' : 'password';
      boton.innerHTML = ver ? OJO_TACHADO : OJO;
      input.focus();
    });
    envoltura.appendChild(boton);
  }

  function revisar(raiz) {
    (raiz || document).querySelectorAll('input[type="password"]').forEach(agregarOjito);
  }

  function iniciar() {
    revisar();
    new MutationObserver(function () { revisar(); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
