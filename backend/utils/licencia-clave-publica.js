// LLAVE PÚBLICA de Compoint para comprobar los códigos de activación.
//
// Esta llave NO es secreta (solo sirve para COMPROBAR códigos, no para crearlos),
// por eso puede estar en GitHub. La llave PRIVADA (la que crea los códigos)
// vive solo en la computadora de Compoint, dentro del programa «Activador
// Compoint», y NUNCA debe subirse a GitHub ni mandarse a nadie.
module.exports = {
  CLAVE_PUBLICA_HEX: '0896fe83a3221b383f299a497ae70b7f83a71e60814e6475a9f5f6d7d8d3ed86'   // 64 caracteres (0-9 y a-f)
};
