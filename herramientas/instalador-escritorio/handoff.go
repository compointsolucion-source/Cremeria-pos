package main

import (
	"encoding/json"
)

// Lo que el instalador le deja dicho a la aplicación (la app lo lee una sola vez al abrir por
// primera vez y lo guarda en su configuración; ver escritorio/src/instalacion.js).
type instalacionJSON struct {
	Version           int     `json:"version"`
	Origen            string  `json:"origen"`
	Modo              string  `json:"modo,omitempty"`
	CarpetaDatos      *string `json:"carpetaDatos,omitempty"`
	CarpetaRespaldos  *string `json:"carpetaRespaldos,omitempty"`
	CopiaExtra        *string `json:"copiaExtra,omitempty"`
	IniciarConWindows *bool   `json:"iniciarConWindows,omitempty"`
	Intermediario     *bool   `json:"intermediario,omitempty"`
}

func ptr[T any](v T) *T { return &v }

// construirInstalacion arma el archivo. `base` es la carpeta estándar del servidor (C:\CompointPunto).
//
//   - Predeterminado: no cambia nada de lo que ya trae el programa (solo avisa que viene del instalador).
//   - Avanzado: manda lo que se eligió. Si una carpeta es la estándar no se manda (así el programa
//     sigue usando sus rutas normales); los respaldos en la estándar se mandan como "" para
//     deshacer cualquier carpeta personalizada anterior.
func construirInstalacion(op Opciones, base string) ([]byte, error) {
	o := instalacionJSON{Version: 1, Origen: "instalador"}
	if op.Modo == "av" {
		o.IniciarConWindows = ptr(op.AbrirConWindows)
		o.Intermediario = ptr(op.Intermediario)
		if op.Uso == "servidor" {
			o.Modo = "servidor"
			if !mismaRuta(op.Datos, unir(base, "datos")) {
				o.CarpetaDatos = ptr(op.Datos)
			}
			if mismaRuta(op.Respaldos, unir(base, "Respaldos")) {
				o.CarpetaRespaldos = ptr("")
			} else {
				o.CarpetaRespaldos = ptr(op.Respaldos)
			}
			if op.CopiaExtraOn && op.CopiaExtra != "" {
				o.CopiaExtra = ptr(op.CopiaExtra)
			} else {
				o.CopiaExtra = ptr("")
			}
		}
	}
	return json.MarshalIndent(o, "", "  ")
}
