package main

import (
	"errors"
	"fmt"
	"strings"
)

const (
	nombreProgramaExe = "Compoint Punto.exe"
	nombreAcceso      = "Compoint Punto.lnk"
	subcarpetaProg    = "Compoint Punto"
	subcarpetaDatos   = "Compoint datos"
	subcarpetaResp    = "Respaldos Compoint"
	mb                = int64(1024 * 1024)
)

var errPermisoDenegado = errors.New("No diste el permiso de administrador. Elige una carpeta dentro de tu usuario (como la que viene por defecto) o vuelve a intentarlo y pulsa «Sí» cuando Windows pregunte.")

// Unidad es un disco o memoria conectada a esta computadora.
type Unidad struct {
	Letra    string `json:"letra"` // "C:"
	Etiqueta string `json:"etiqueta"`
	Tipo     string `json:"tipo"` // fijo | usb | red
	Libre    int64  `json:"libre"`
	Total    int64  `json:"total"`
}

// Meta es lo que el armado del instalador dejó escrito dentro del .exe.
type Meta struct {
	Formato         int    `json:"formato"`
	Version         string `json:"version"`
	Negocio         string `json:"negocio"`
	Archivo         string `json:"archivo"`
	TamanoInstalado int64  `json:"tamanoInstalado"`
	ConUrl          bool   `json:"conUrl"` // el instalador ya trae la dirección del sistema del cliente
	TamanoPaquete   int64  `json:"-"`
}

// InfoRuta es lo que se sabe de una carpeta.
type InfoRuta struct {
	Existe        bool `json:"existe"`
	EsCarpeta     bool `json:"esCarpeta"`
	Vacia         bool `json:"vacia"`
	TieneBD       bool `json:"tieneBD"`       // ya hay información de un negocio de Compoint (PG_VERSION)
	TienePrograma bool `json:"tienePrograma"` // ya hay un Compoint Punto instalado ahí
	Escribible    bool `json:"escribible"`    // la carpeta (o la más cercana que existe) deja guardar archivos
}

// Estado es lo que se muestra al empezar.
type Estado struct {
	Version         string   `json:"version"`
	Equipo          string   `json:"equipo"`
	Negocio         string   `json:"negocio"`
	ConUrl          bool     `json:"conUrl"`
	Unidades        []Unidad `json:"unidades"`
	Programa        string   `json:"programa"`  // carpeta sugerida
	Datos           string   `json:"datos"`     // sugerida
	Respaldos       string   `json:"respaldos"` // sugerida
	CopiaExtra      string   `json:"copiaExtra"`
	DatosExistentes string   `json:"datosExistentes"` // carpeta con información de un negocio ya existente
	YaInstalado     string   `json:"yaInstalado"`
	AppAbierta      bool     `json:"appAbierta"`
	EsAdmin         bool     `json:"esAdmin"`
	TamanoNecesario int64    `json:"tamanoNecesario"`
	TamanoPaquete   int64    `json:"tamanoPaquete"`
	SinPaquete      bool     `json:"sinPaquete"`
	Simulado        bool     `json:"simulado"`
	Aviso           string   `json:"aviso,omitempty"`
}

// Opciones es lo que la persona eligió.
type Opciones struct {
	Modo            string `json:"modo"` // pred | av
	Uso             string `json:"uso"`  // caja | servidor
	Programa        string `json:"programa"`
	Datos           string `json:"datos"`
	Respaldos       string `json:"respaldos"`
	CopiaExtraOn    bool   `json:"copiaExtraOn"`
	CopiaExtra      string `json:"copiaExtra"`
	Escritorio      bool   `json:"escritorio"`
	Inicio          bool   `json:"inicio"`
	AbrirConWindows bool   `json:"abrirConWindows"`
	Intermediario   bool   `json:"intermediario"`
}

// Validacion es la respuesta de revisar las opciones antes de instalar.
type Validacion struct {
	Errores       []string          `json:"errores"`
	Avisos        []string          `json:"avisos"`
	Campos        map[string]string `json:"campos"` // error por campo: programa, datos, respaldos, copiaExtra
	NecesitaAdmin bool              `json:"necesitaAdmin"`
	Opciones      Opciones          `json:"opciones"` // ya limpias
}

func (v Validacion) ok() bool { return len(v.Errores) == 0 }

// Paso es una línea de la lista de avance.
type Paso struct {
	Clave   string `json:"clave"`
	Titulo  string `json:"titulo"`
	Detalle string `json:"detalle"`
	Estado  string `json:"estado"` // pendiente, haciendo, ok, aviso, error
}

// Resumen es lo que quedó instalado.
type Resumen struct {
	Programa   string   `json:"programa"`
	Exe        string   `json:"exe"`
	Uso        string   `json:"uso"`
	Modo       string   `json:"modo"`
	Datos      string   `json:"datos"`
	Respaldos  string   `json:"respaldos"`
	CopiaExtra string   `json:"copiaExtra"`
	Elevado    bool     `json:"elevado"`
	Avisos     []string `json:"avisos,omitempty"`
}

// Listado es el contenido de una carpeta para el selector de carpetas.
type Listado struct {
	Ruta     string    `json:"ruta"`  // "" = lista de unidades
	Padre    string    `json:"padre"` // "" = unidades
	Carpetas []Entrada `json:"carpetas"`
	Unidades []Unidad  `json:"unidades"`
	Info     InfoRuta  `json:"info"`
	Cortado  bool      `json:"cortado,omitempty"`
}

type Entrada struct {
	Nombre string `json:"nombre"`
	Ruta   string `json:"ruta"`
}

func pasosDe(op Opciones) []Paso {
	return []Paso{
		{Clave: "carpetas", Titulo: "Preparar las carpetas", Estado: "pendiente"},
		{Clave: "copiar", Titulo: "Copiar los archivos del programa", Estado: "pendiente"},
		{Clave: "accesos", Titulo: "Crear accesos directos y arranque con Windows", Estado: "pendiente"},
		{Clave: "config", Titulo: "Dejar lista la configuración", Estado: "pendiente"},
	}
}

func errPaso(p Paso) error {
	d := strings.TrimSpace(p.Detalle)
	if d == "" {
		d = "Algo salió mal."
	}
	return errors.New(d)
}

func tamanoLegible(b int64) string {
	switch {
	case b >= 1024*mb:
		return fmt.Sprintf("%.1f GB", float64(b)/float64(1024*mb))
	case b >= mb:
		return fmt.Sprintf("%d MB", b/mb)
	default:
		return fmt.Sprintf("%d KB", b/1024)
	}
}

func unidadDe(us []Unidad, ruta string) *Unidad {
	l := letraDe(ruta)
	if l == "" {
		return nil
	}
	for i := range us {
		if strings.EqualFold(us[i].Letra, l) {
			return &us[i]
		}
	}
	return nil
}

// Predeterminados son las carpetas que propone cada equipo.
type Predeterminados struct {
	Programa string // donde se instala el programa (sin pedir permisos)
	Base     string // carpeta del modo servidor; adentro van datos\ y Respaldos\
}

// Sistema es lo que toca Windows. Hay una versión real (windows.go) y una simulada (simulado.go).
type Sistema interface {
	Defaults() Predeterminados
	Equipo() string
	Unidades() []Unidad
	InfoRuta(ruta string) InfoRuta
	EsAdmin() bool
	TempUnidad() string
	DatosExistentes() string // carpeta con información de un negocio ya existente en este equipo, o ""
	YaInstalado() string     // carpeta donde ya está Compoint Punto, o ""
	AppAbierta() bool
	Listar(ruta string) (Listado, error)
	CrearCarpeta(ruta string) error
	// Instalar hace todo el trabajo. Bloquea hasta terminar y avisa cada cambio.
	Instalar(op Opciones, meta Meta, carga *Carga, avance func(fase string, pasos []Paso, pct int)) (Resumen, error)
	Abrir(que string, r Resumen) error
}

// asegurarNombrePrograma garantiza que la carpeta del programa lleve «Compoint Punto» en su ruta.
// El instalador de Windows agrega esa subcarpeta por su cuenta cuando no la trae; así la ruta que ve
// la persona es exactamente donde queda instalado.
func asegurarNombrePrograma(r string) string {
	if strings.Contains(strings.ToLower(r), strings.ToLower(subcarpetaProg)) {
		return r
	}
	return unir(r, subcarpetaProg)
}

// validar revisa lo elegido contra este equipo. Corrige formas (barras, mayúsculas) en `op`.
func validar(op *Opciones, sis Sistema, meta Meta) Validacion {
	v := Validacion{Campos: map[string]string{}}
	err := func(campo, texto string) {
		if _, hay := v.Campos[campo]; !hay {
			v.Campos[campo] = texto
		}
		v.Errores = append(v.Errores, texto)
	}
	aviso := func(texto string) { v.Avisos = append(v.Avisos, texto) }

	if op.Modo != "av" {
		op.Modo = "pred"
	}
	if op.Uso != "servidor" {
		op.Uso = "caja"
	}
	unidades := sis.Unidades()
	instalado := meta.TamanoInstalado
	if instalado <= 0 {
		instalado = 450 * mb
	}

	// ---------------- Programa
	prog, e := validarRuta(op.Programa, false)
	if e != nil {
		err("programa", e.Error())
	} else {
		prog = asegurarNombrePrograma(prog)
		op.Programa = prog
		switch {
		default:
			u := unidadDe(unidades, prog)
			switch {
			case u == nil:
				err("programa", fmt.Sprintf("La unidad %s no existe o no está conectada.", letraDe(prog)))
			case u.Tipo == "usb":
				err("programa", "El programa no se puede instalar en una USB: si la quitas, Compoint Punto dejaría de abrir. Elige un disco de la computadora.")
			case u.Tipo == "red":
				err("programa", "El programa se instala en un disco de esta computadora, no en uno de red.")
			default:
				info := sis.InfoRuta(prog)
				switch {
				case info.Existe && !info.EsCarpeta:
					err("programa", "Esa ruta es un archivo, no una carpeta.")
				case info.Existe && !info.Vacia && !info.TienePrograma:
					err("programa", "Esa carpeta ya tiene otros archivos. Elige una carpeta vacía o una nueva.")
				default:
					necesario := instalado + instalado/10
					if u2 := unidadDe(unidades, sis.TempUnidad()); u2 != nil && strings.EqualFold(u2.Letra, u.Letra) {
						necesario += meta.TamanoPaquete
					}
					if u.Libre < necesario {
						err("programa", fmt.Sprintf("No hay espacio suficiente en %s: faltan %s. Libera espacio o elige otra unidad.", u.Letra, tamanoLegible(necesario-u.Libre)))
					}
					if !sis.EsAdmin() && !info.Escribible {
						v.NecesitaAdmin = true
						aviso("Para instalar en esa carpeta, Windows te pedirá permiso de administrador.")
					}
				}
			}
		}
	}
	if y := sis.YaInstalado(); y != "" && prog != "" && v.Campos["programa"] == "" && !dentroDe(prog, y) && !dentroDe(y, prog) {
		aviso("Ya tienes Compoint Punto en " + y + ". Si lo instalas en otra carpeta quedarán dos copias del programa.")
	}
	// Espacio temporal para preparar el instalador (suele ser C:)
	if meta.TamanoPaquete > 0 {
		if t := unidadDe(unidades, sis.TempUnidad()); t != nil && t.Libre < meta.TamanoPaquete+meta.TamanoPaquete/20 {
			err("programa", fmt.Sprintf("No hay espacio en %s para preparar el instalador (faltan %s). Libera espacio en esa unidad.", t.Letra, tamanoLegible(meta.TamanoPaquete+meta.TamanoPaquete/20-t.Libre)))
		}
	}

	if op.Uso != "servidor" {
		op.Datos, op.Respaldos, op.CopiaExtra, op.CopiaExtraOn = "", "", "", false
		return finalizar(v, *op)
	}

	// ---------------- Información del negocio (base de datos)
	existente := sis.DatosExistentes()
	datos, e := validarRuta(op.Datos, false)
	if e != nil {
		err("datos", e.Error())
	} else {
		op.Datos = datos
		switch {
		case existente != "" && !mismaRuta(datos, existente):
			err("datos", "Ya hay información del negocio en "+existente+". Para no perderla, tiene que quedarse ahí.")
		case esRaiz(datos):
			err("datos", "Elige una carpeta, no la unidad completa. Por ejemplo:  "+unir(datos, subcarpetaDatos))
		case prog != "" && (dentroDe(datos, prog) || dentroDe(prog, datos)):
			err("datos", "La información del negocio no puede estar dentro de la carpeta del programa (se borraría al actualizar o desinstalar). Elige otra carpeta.")
		default:
			u := unidadDe(unidades, datos)
			switch {
			case u == nil:
				err("datos", fmt.Sprintf("La unidad %s no existe o no está conectada.", letraDe(datos)))
			case u.Tipo != "fijo":
				err("datos", "La información del negocio debe estar en un disco de esta computadora. En una USB o en la red, si se desconecta, el sistema se detiene y puede dañarse.")
			default:
				info := sis.InfoRuta(datos)
				switch {
				case info.Existe && !info.EsCarpeta:
					err("datos", "Esa ruta es un archivo, no una carpeta.")
				case info.Existe && !info.Vacia && !info.TieneBD:
					err("datos", "Esa carpeta ya tiene otros archivos. Elige una carpeta vacía o una nueva, por ejemplo:  "+unir(datos, subcarpetaDatos))
				case !info.Escribible:
					err("datos", "No tienes permiso para guardar en esa carpeta. Elige otra.")
				default:
					if info.TieneBD {
						aviso("Se encontró información de un negocio en la carpeta de datos: se conserva y se vuelve a usar.")
					}
					if u.Libre < 1024*mb {
						err("datos", fmt.Sprintf("Queda muy poco espacio en %s (%s). Elige otra unidad.", u.Letra, tamanoLegible(u.Libre)))
					} else if u.Libre < 5*1024*mb {
						aviso(fmt.Sprintf("En %s quedan %s libres: poco para una base de datos que crece con el tiempo.", u.Letra, tamanoLegible(u.Libre)))
					}
				}
			}
		}
	}

	// ---------------- Respaldos
	resp, e := validarRuta(op.Respaldos, false)
	if e != nil {
		err("respaldos", e.Error())
	} else {
		op.Respaldos = resp
		switch {
		case esRaiz(resp):
			err("respaldos", "Elige una carpeta, no la unidad completa. Por ejemplo:  "+unir(resp, subcarpetaResp))
		case prog != "" && (dentroDe(resp, prog) || dentroDe(prog, resp)):
			err("respaldos", "Los respaldos no pueden estar dentro de la carpeta del programa (se borrarían al actualizar o desinstalar). Elige otra carpeta.")
		case datos != "" && (dentroDe(resp, datos) || dentroDe(datos, resp)):
			err("respaldos", "Los respaldos no pueden estar dentro de la carpeta de información del negocio, ni al revés. Elige otra carpeta.")
		default:
			u := unidadDe(unidades, resp)
			switch {
			case u == nil:
				err("respaldos", fmt.Sprintf("La unidad %s no existe o no está conectada.", letraDe(resp)))
			case u.Tipo == "red":
				err("respaldos", "Para guardar en la red usa la «copia extra». Aquí elige una carpeta de esta computadora o una USB.")
			default:
				info := sis.InfoRuta(resp)
				switch {
				case info.Existe && !info.EsCarpeta:
					err("respaldos", "Esa ruta es un archivo, no una carpeta.")
				case !info.Escribible:
					err("respaldos", "No tienes permiso para guardar en esa carpeta. Elige otra.")
				default:
					if u.Tipo == "usb" {
						aviso("Los respaldos irán a una USB: si no está conectada, se guardarán temporalmente en la carpeta estándar del programa.")
					}
					if u.Libre < 1024*mb {
						err("respaldos", fmt.Sprintf("Queda muy poco espacio en %s (%s). Elige otra unidad.", u.Letra, tamanoLegible(u.Libre)))
					}
				}
			}
		}
	}

	// ---------------- Copia extra
	if !op.CopiaExtraOn {
		op.CopiaExtra = ""
	} else {
		extra, e := validarRuta(op.CopiaExtra, true)
		if e != nil {
			err("copiaExtra", e.Error())
		} else {
			op.CopiaExtra = extra
			switch {
			case esRaiz(extra) && !esUNC(extra):
				err("copiaExtra", "Elige una carpeta, no la unidad completa. Por ejemplo:  "+unir(extra, subcarpetaResp))
			case prog != "" && (dentroDe(extra, prog) || dentroDe(prog, extra)):
				err("copiaExtra", "La copia extra no puede estar dentro de la carpeta del programa. Elige otra carpeta.")
			case datos != "" && (dentroDe(extra, datos) || dentroDe(datos, extra)):
				err("copiaExtra", "La copia extra no puede estar dentro de la carpeta de información del negocio. Elige otra carpeta.")
			case resp != "" && (dentroDe(extra, resp) || dentroDe(resp, extra)):
				err("copiaExtra", "La copia extra tiene que ser una carpeta distinta a la de los respaldos.")
			case esUNC(extra):
				aviso("No se puede comprobar ahora la carpeta de red de la copia extra; si no está disponible, se reintenta sola.")
			default:
				u := unidadDe(unidades, extra)
				if u == nil {
					err("copiaExtra", fmt.Sprintf("La unidad %s no existe o no está conectada.", letraDe(extra)))
				} else {
					info := sis.InfoRuta(extra)
					switch {
					case info.Existe && !info.EsCarpeta:
						err("copiaExtra", "Esa ruta es un archivo, no una carpeta.")
					case !info.Escribible:
						err("copiaExtra", "No tienes permiso para guardar en esa carpeta. Elige otra.")
					default:
						if datos != "" && strings.EqualFold(letraDe(datos), u.Letra) {
							aviso("La copia extra está en la misma unidad que la información del negocio: no te protege si ese disco falla. Mejor una USB u otro disco.")
						} else if resp != "" && strings.EqualFold(letraDe(resp), u.Letra) {
							aviso("La copia extra está en la misma unidad que los respaldos: no te protege si ese disco falla. Mejor una USB u otro disco.")
						}
					}
				}
			}
		}
	}
	return finalizar(v, *op)
}

func finalizar(v Validacion, op Opciones) Validacion {
	v.Opciones = op
	if v.Errores == nil {
		v.Errores = []string{}
	}
	if v.Avisos == nil {
		v.Avisos = []string{}
	}
	return v
}
