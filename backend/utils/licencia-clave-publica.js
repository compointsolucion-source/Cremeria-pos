// LLAVE PÚBLICA de Compoint para comprobar los códigos de activación.
//
// Esta llave NO es secreta (solo sirve para COMPROBAR códigos, no para crearlos),
// por eso puede estar en GitHub. La llave PRIVADA (la que crea los códigos)
// vive solo en la computadora de Compoint, dentro del programa «Activador
// Compoint», y NUNCA debe subirse a GitHub ni mandarse a nadie.
//
// CÓMO SE LLENA:
//   1. Abre el Activador Compoint en tu computadora (la primera vez crea tu llave).
//   2. Entra a «Mi llave» y pulsa «Guardar archivo para el sistema».
//   3. Reemplaza este archivo por el que te dio el Activador, y súbelo a GitHub.
//
// Mientras esté vacía, el sistema funciona (incluida la prueba de 30 días),
// pero NO acepta códigos de activación.
module.exports = {
  CLAVE_PUBLICA_HEX: ''   // 64 caracteres (0-9 y a-f)
};
