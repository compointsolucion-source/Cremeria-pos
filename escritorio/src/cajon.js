'use strict';
// Abrir el cajón de dinero con una impresora instalada en Windows.
// El cajón va conectado a la impresora (cable RJ11/RJ12): se le manda la orden "abrir cajón" de
// ESC/POS directo por el spooler de Windows (el mismo camino que usa el ticket), sin diálogo.

// ESC @ (reiniciar) + ESC p m t1 t2 (pulso al cajón). Se manda por los dos pines (m = 0 y m = 1):
// cada cajón está cableado a uno solo, así que se abre con cualquiera.
const COMANDO_CAJON = Buffer.from([
  0x1B, 0x40,
  0x1B, 0x70, 0x00, 0x19, 0xFA,
  0x1B, 0x70, 0x01, 0x19, 0xFA
]);

// instaladas: [{ name, isDefault }] (lo que da Electron);  nombre: la elegida ('' = predeterminada de Windows).
// Devuelve { destino } o { error } con un texto que el dueño pueda entender.
function resolverImpresoraCajon(instaladas, nombre) {
  const lista = Array.isArray(instaladas) ? instaladas : [];
  nombre = String(nombre || '');
  if (nombre) {
    if (!lista.some(p => p && p.name === nombre)) {
      return { error: `La impresora "${nombre}" no está instalada en esta computadora.` };
    }
    return { destino: nombre };
  }
  const predeterminada = lista.find(p => p && p.isDefault);
  if (!predeterminada) {
    return { error: 'Windows no tiene una impresora predeterminada. Elige la impresora del ticket en Configuración → Impresión de este dispositivo.' };
  }
  return { destino: predeterminada.name };
}

module.exports = { COMANDO_CAJON, resolverImpresoraCajon };
