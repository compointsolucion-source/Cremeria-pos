package main

import (
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// sistemaSimulado no toca el equipo: tiene unos discos y carpetas inventados para probar la pantalla
// y el recorrido completo en cualquier computadora.
//
// Variables para probar casos (todas opcionales):
//
//	INSTALADOR_SIM_ERROR=<paso>              falla ese paso (carpetas, copiar, accesos, config)
//	INSTALADOR_SIM_ADMIN=1                   el instalador ya tiene permisos de administrador
//	INSTALADOR_SIM_UAC=no                    la persona dice «No» al permiso de administrador
//	INSTALADOR_SIM_ESPERA=<ms>               duración de cada tramo (por defecto 450)
//	INSTALADOR_SIM_DATOS_EXISTENTES=1        ya hay información de un negocio en C:\CompointPunto\datos
//	INSTALADOR_SIM_YA_INSTALADO=1            ya está instalado Compoint Punto
//	INSTALADOR_SIM_ABIERTA=1                 Compoint Punto está abierto (se «cierra» tras avisar una vez)
//	INSTALADOR_SIM_POCO_ESPACIO=1            C: casi sin espacio
//	INSTALADOR_SIM_SIN_USB=1                 no hay USB conectada
//	INSTALADOR_SIM_NEGOCIO=<nombre>          nombre del negocio que trae el instalador
//	INSTALADOR_SIM_CONURL=1                  el instalador ya trae la dirección del sistema
//	INSTALADOR_SIM_HANDOFF=<archivo>         dónde escribir el archivo que lee la aplicación
type sistemaSimulado struct {
	mu       sync.Mutex
	dirs     map[string]*dirSim // clave(ruta) -> carpeta
	abierta  bool
	abiertos []string
}

type dirSim struct {
	ruta     string
	archivos []string
}

func nuevoSimulado() *sistemaSimulado {
	s := &sistemaSimulado{dirs: map[string]*dirSim{}}
	for _, r := range []string{
		`C:\`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\Windows`, `C:\Users`,
		`C:\Users\Compoint\AppData\Local\Programs`, `C:\Users\Compoint\Documents`, `C:\Users\Compoint\Desktop`,
		`D:\`, `D:\Datos`, `D:\Fotos`, `D:\Programas`, `D:\Solo lectura`,
		`E:\`, `E:\Documentos`, `E:\Fotos de viaje`,
	} {
		s.anadir(r)
	}
	s.dirs[clave(`D:\Datos`)].archivos = []string{"ventas-2025.xlsx"}
	s.anadir(`D:\Mis archivos`, "nota.txt", "contrato.pdf")
	s.anadir(`D:\Compoint Punto Viejo`, "nota.txt")
	if os.Getenv("INSTALADOR_SIM_DATOS_EXISTENTES") == "1" {
		s.anadir(`C:\CompointPunto\datos`, "PG_VERSION", "postgresql.conf")
		s.anadir(`C:\CompointPunto\Respaldos`, "respaldo-2026-10-14.json.gz")
	}
	if os.Getenv("INSTALADOR_SIM_YA_INSTALADO") == "1" {
		s.anadir(`C:\Users\Compoint\AppData\Local\Programs\Compoint Punto`, nombreProgramaExe, "Uninstall "+nombreProgramaExe)
	}
	s.abierta = os.Getenv("INSTALADOR_SIM_ABIERTA") == "1"
	return s
}

func (s *sistemaSimulado) anadir(ruta string, archivos ...string) {
	r := norm(ruta)
	for r != "" {
		k := clave(r)
		if _, hay := s.dirs[k]; !hay {
			s.dirs[k] = &dirSim{ruta: r}
		}
		r = padreDe(r)
	}
	if len(archivos) > 0 {
		d := s.dirs[clave(ruta)]
		d.archivos = append(d.archivos, archivos...)
	}
}

func (s *sistemaSimulado) existe(ruta string) bool { _, hay := s.dirs[clave(ruta)]; return hay }

func (s *sistemaSimulado) hijos(ruta string) []*dirSim {
	var h []*dirSim
	k := clave(ruta)
	for _, d := range s.dirs {
		if clave(d.ruta) != k && clave(padreDe(d.ruta)) == k {
			h = append(h, d)
		}
	}
	sort.Slice(h, func(i, j int) bool {
		return strings.ToLower(nombreBase(h[i].ruta)) < strings.ToLower(nombreBase(h[j].ruta))
	})
	return h
}

func (s *sistemaSimulado) sinPermiso(ruta string) bool {
	if os.Getenv("INSTALADOR_SIM_ADMIN") == "1" {
		return false
	}
	for _, p := range []string{`C:\Program Files`, `C:\Program Files (x86)`, `C:\Windows`, `D:\Solo lectura`} {
		if dentroDe(ruta, p) {
			return true
		}
	}
	return false
}

func (s *sistemaSimulado) Defaults() Predeterminados {
	return Predeterminados{Programa: `C:\Users\Compoint\AppData\Local\Programs\Compoint Punto`, Base: `C:\CompointPunto`}
}
func (s *sistemaSimulado) Equipo() string     { return "CAJA-PRINCIPAL" }
func (s *sistemaSimulado) EsAdmin() bool      { return os.Getenv("INSTALADOR_SIM_ADMIN") == "1" }
func (s *sistemaSimulado) TempUnidad() string { return "C:" }

func (s *sistemaSimulado) Unidades() []Unidad {
	libreC := 118 * 1024 * mb
	if os.Getenv("INSTALADOR_SIM_POCO_ESPACIO") == "1" {
		libreC = 300 * mb
	}
	u := []Unidad{
		{Letra: "C:", Etiqueta: "Windows", Tipo: "fijo", Libre: libreC, Total: 237 * 1024 * mb},
		{Letra: "D:", Etiqueta: "Datos", Tipo: "fijo", Libre: 420 * 1024 * mb, Total: 931 * 1024 * mb},
	}
	if os.Getenv("INSTALADOR_SIM_SIN_USB") != "1" {
		u = append(u, Unidad{Letra: "E:", Etiqueta: "RESPALDOS", Tipo: "usb", Libre: 28 * 1024 * mb, Total: 29 * 1024 * mb})
	}
	return u
}

func (s *sistemaSimulado) InfoRuta(ruta string) InfoRuta {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info(ruta)
}

// info es InfoRuta para usarse con el candado ya tomado.
func (s *sistemaSimulado) info(ruta string) InfoRuta {
	var i InfoRuta
	r := norm(ruta)
	if d, hay := s.dirs[clave(r)]; hay {
		i.Existe, i.EsCarpeta = true, true
		i.Vacia = len(d.archivos) == 0 && len(s.hijos(r)) == 0
		for _, a := range d.archivos {
			if a == "PG_VERSION" {
				i.TieneBD = true
			}
			if a == nombreProgramaExe || a == "Uninstall "+nombreProgramaExe {
				i.TienePrograma = true
			}
		}
	}
	cerca := r
	for cerca != "" && !s.existe(cerca) {
		cerca = padreDe(cerca)
	}
	i.Escribible = cerca != "" && !s.sinPermiso(cerca)
	return i
}

func (s *sistemaSimulado) DatosExistentes() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, hay := s.dirs[clave(`C:\CompointPunto\datos`)]; hay {
		for _, a := range d.archivos {
			if a == "PG_VERSION" {
				return d.ruta
			}
		}
	}
	return ""
}

func (s *sistemaSimulado) YaInstalado() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, hay := s.dirs[clave(`C:\Users\Compoint\AppData\Local\Programs\Compoint Punto`)]; hay {
		for _, a := range d.archivos {
			if a == nombreProgramaExe {
				return d.ruta
			}
		}
	}
	return ""
}

func (s *sistemaSimulado) AppAbierta() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.abierta
}

// CerrarApp: en la prueba, la persona «cierra» el programa después de que se le avisó.
func (s *sistemaSimulado) CerrarApp() {
	s.mu.Lock()
	s.abierta = false
	s.mu.Unlock()
}

func (s *sistemaSimulado) Listar(ruta string) (Listado, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := Listado{Unidades: s.Unidades(), Carpetas: []Entrada{}}
	r := norm(ruta)
	if r == "" {
		return l, nil
	}
	for r != "" && !s.existe(r) {
		r = padreDe(r)
	}
	if r == "" {
		return l, nil
	}
	// una unidad que no está conectada no se puede abrir
	if unidadDe(l.Unidades, r) == nil {
		return l, errors.New("Esa unidad no está disponible.")
	}
	l.Ruta, l.Padre = s.dirs[clave(r)].ruta, padreDe(r)
	for _, h := range s.hijos(r) {
		l.Carpetas = append(l.Carpetas, Entrada{Nombre: nombreBase(h.ruta), Ruta: h.ruta})
	}
	l.Info = s.info(r)
	return l, nil
}

func (s *sistemaSimulado) CrearCarpeta(ruta string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := norm(ruta)
	if s.existe(r) {
		return errors.New("Ya existe una carpeta con ese nombre.")
	}
	if !s.existe(padreDe(r)) {
		return errors.New("La carpeta de arriba no existe.")
	}
	if s.sinPermiso(padreDe(r)) {
		return errors.New("No tienes permiso para crear carpetas ahí.")
	}
	s.anadir(r)
	return nil
}

func (s *sistemaSimulado) Abrir(que string, r Resumen) error {
	s.mu.Lock()
	s.abiertos = append(s.abiertos, que)
	s.mu.Unlock()
	registrar("(simulado) abrir " + que)
	return nil
}

func esperaSim() time.Duration {
	if v := os.Getenv("INSTALADOR_SIM_ESPERA"); v != "" {
		if d, err := time.ParseDuration(v + "ms"); err == nil {
			return d
		}
	}
	return 450 * time.Millisecond
}

func (s *sistemaSimulado) Instalar(op Opciones, meta Meta, carga *Carga, avance func(fase string, pasos []Paso, pct int)) (Resumen, error) {
	espera := esperaSim()
	pasos := pasosDe(op)
	res := Resumen{Uso: op.Uso, Modo: op.Modo, Programa: op.Programa}
	pct := 0
	emitir := func(fase string) { avance(fase, copiaPasos(pasos), pct) }
	paso := func(i int, estado, detalle string) {
		pasos[i].Estado = estado
		if detalle != "" {
			pasos[i].Detalle = detalle
		}
		emitir("")
	}
	fallo := func(i int, detalle string) (Resumen, error) {
		pasos[i].Estado, pasos[i].Detalle = "error", detalle
		emitir("")
		return res, errPaso(pasos[i])
	}
	simError := os.Getenv("INSTALADOR_SIM_ERROR")

	if s.AppAbierta() {
		return res, errors.New("Compoint Punto está abierto. Ciérralo y vuelve a intentarlo.")
	}
	necesitaAdmin := !s.EsAdmin() && !s.InfoRuta(op.Programa).Escribible
	emitir("trabajando")

	// 1 · carpetas
	paso(0, "haciendo", "")
	time.Sleep(espera)
	if simError == "carpetas" {
		return fallo(0, "No se pudo crear la carpeta (simulado).")
	}
	s.mu.Lock()
	if !necesitaAdmin {
		s.anadir(op.Programa)
	}
	if op.Uso == "servidor" {
		s.anadir(op.Datos)
		s.anadir(op.Respaldos)
		if op.CopiaExtraOn {
			s.anadir(op.CopiaExtra)
		}
	}
	s.mu.Unlock()
	pct = 5
	paso(0, "ok", "Carpetas listas")

	// 2 · copiar
	paso(1, "haciendo", "Preparando el instalador…")
	for i := 1; i <= 4; i++ {
		time.Sleep(espera / 2)
		pct = 5 + i*9
		emitir("")
	}
	if necesitaAdmin {
		emitir("esperando-permiso")
		time.Sleep(espera)
		if os.Getenv("INSTALADOR_SIM_UAC") == "no" {
			return res, errPermisoDenegado
		}
		emitir("trabajando")
		res.Elevado = true
	}
	paso(1, "haciendo", "Copiando archivos…")
	for i := 1; i <= 6; i++ {
		time.Sleep(espera / 2)
		pct = 41 + i*7
		emitir("")
	}
	if simError == "copiar" {
		return fallo(1, "El instalador del programa terminó con un error (código 2, simulado).")
	}
	s.mu.Lock()
	s.anadir(op.Programa, nombreProgramaExe, "Uninstall "+nombreProgramaExe)
	s.mu.Unlock()
	res.Exe = unir(op.Programa, nombreProgramaExe)
	pct = 90
	paso(1, "ok", tamanoLegible(meta.TamanoInstalado)+" copiados")

	// 3 · accesos
	paso(2, "haciendo", "")
	time.Sleep(espera)
	if simError == "accesos" {
		return fallo(2, "No se pudieron crear los accesos (simulado).")
	}
	var quedan []string
	if op.Escritorio {
		quedan = append(quedan, "escritorio")
	}
	if op.Inicio {
		quedan = append(quedan, "menú Inicio")
	}
	if op.AbrirConWindows {
		quedan = append(quedan, "arranque con Windows")
	}
	if len(quedan) == 0 {
		paso(2, "ok", "Sin accesos directos")
	} else {
		paso(2, "ok", strings.Join(quedan, " · "))
	}
	pct = 95

	// 4 · config
	paso(3, "haciendo", "")
	time.Sleep(espera)
	if simError == "config" {
		return fallo(3, "No se pudo guardar la configuración (simulado).")
	}
	datos, err := construirInstalacion(op, s.Defaults().Base)
	if err != nil {
		return fallo(3, err.Error())
	}
	if ruta := os.Getenv("INSTALADOR_SIM_HANDOFF"); ruta != "" {
		_ = os.WriteFile(ruta, datos, 0o644)
	}
	if op.Uso == "servidor" {
		res.Datos, res.Respaldos = op.Datos, op.Respaldos
		if op.CopiaExtraOn {
			res.CopiaExtra = op.CopiaExtra
		}
	}
	pct = 100
	paso(3, "ok", "Lista para abrir")
	return res, nil
}
