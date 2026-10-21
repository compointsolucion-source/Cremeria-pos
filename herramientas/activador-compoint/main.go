// Activador Compoint
//
// Programa SOLO para Compoint (no se entrega a los clientes). Crea y guarda la llave que firma
// los códigos de licencia, lleva la lista de clientes con sus vencimientos y genera los códigos
// CPT1-… que se mandan por WhatsApp o correo.
//
// Igual que el Asistente del servidor, abre una ventana (Edge o Chrome en modo «app») que muestra
// una página local (127.0.0.1, con clave de sesión). Todo queda en esta computadora.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed ui/*
var interfazFS embed.FS

const version = "1.0.0"

type servidor struct {
	dir    string // carpeta de datos (llave.cptkey, datos.json)
	token  string
	addr   string
	ahora  func() time.Time
	elegir func(titulo string) (string, error) // selector de carpeta (Windows lo muestra)

	mu    sync.Mutex // protege todo lo de abajo
	priv  ed25519.PrivateKey
	clave string
	datos *Datos

	latidoMu     sync.Mutex
	ultimoLatido time.Time
	huboLatido   bool
	inicio       time.Time
	ventana      *exec.Cmd
}

func (s *servidor) rutaLlave() string { return filepath.Join(s.dir, "llave.cptkey") }
func (s *servidor) rutaDatos() string { return filepath.Join(s.dir, "datos.json") }
func (s *servidor) hoy() string       { return s.ahora().Format("2006-01-02") }
func (s *servidor) abierto() bool     { return s.priv != nil }
func (s *servidor) hayLlave() bool    { _, err := os.Stat(s.rutaLlave()); return err == nil }
func nuevoToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func responder(w http.ResponseWriter, codigo int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(codigo)
	_ = json.NewEncoder(w).Encode(v)
}

func fallo(w http.ResponseWriter, codigo int, msg string) {
	responder(w, codigo, map[string]string{"error": msg})
}

// protegido: solo esta computadora, con la clave de esta sesión.
func (s *servidor) protegido(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.addr || r.Header.Get("X-Token") != s.token {
			http.Error(w, "No permitido", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

// conLlave: además de lo anterior, exige haber escrito la contraseña.
func (s *servidor) conLlave(h func(w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return s.protegido(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		abierto := s.abierto()
		s.mu.Unlock()
		if !abierto {
			fallo(w, http.StatusUnauthorized, "Primero escribe tu contraseña.")
			return
		}
		h(w, r)
	})
}

func leerJSON(w http.ResponseWriter, r *http.Request, destino interface{}, max int64) bool {
	if r.Method != http.MethodPost {
		fallo(w, http.StatusMethodNotAllowed, "Método no permitido")
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, max)).Decode(destino); err != nil {
		fallo(w, http.StatusBadRequest, "No entendí lo que se pidió.")
		return false
	}
	return true
}

// ---------------------------------------------------------------- estado

type vistaRespaldos struct {
	Hechos      int        `json:"hechos"`
	Ultimo      string     `json:"ultimo"`
	Lugares     []Respaldo `json:"lugares"`
	NuevosDesde int        `json:"nuevosDesde"` // códigos emitidos después del último respaldo
}

type vistaEstado struct {
	Fase           string          `json:"fase"` // crear | bloqueado | abierto
	Version        string          `json:"version"`
	Respaldos      *vistaRespaldos `json:"respaldos,omitempty"`
	LlavePublica   string          `json:"llavePublica,omitempty"`
	SiguienteSerie uint32          `json:"siguienteSerie,omitempty"`
}

func (s *servidor) estado() vistaEstado {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := vistaEstado{Version: version}
	switch {
	case !s.hayLlave():
		e.Fase = "crear"
	case !s.abierto():
		e.Fase = "bloqueado"
	default:
		e.Fase = "abierto"
		e.LlavePublica = publicaHex(s.priv.Public().(ed25519.PublicKey))
		e.SiguienteSerie = s.datos.SiguienteSerie
		v := &vistaRespaldos{Lugares: append([]Respaldo{}, s.datos.Respaldos...)}
		v.Hechos = len(v.Lugares)
		var maxSerie uint32
		for _, r := range v.Lugares {
			if r.Fecha > v.Ultimo {
				v.Ultimo = r.Fecha
			}
			if r.Serie > maxSerie {
				maxSerie = r.Serie
			}
		}
		if v.Hechos > 0 && s.datos.SiguienteSerie-1 > maxSerie {
			v.NuevosDesde = int(s.datos.SiguienteSerie - 1 - maxSerie)
		}
		e.Respaldos = v
	}
	return e
}

// ---------------------------------------------------------------- llave

func (s *servidor) crearLlave(clave string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hayLlave() {
		return errors.New("Ya hay una llave en esta computadora.")
	}
	if len([]rune(clave)) < 8 {
		return errors.New("La contraseña debe tener al menos 8 caracteres.")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	env, err := sellar(formatoLlave, priv.Seed(), clave, publicaHex(pub), s.hoy())
	if err != nil {
		return err
	}
	cuerpo, _ := json.MarshalIndent(env, "", "  ")
	datos := datosNuevos()
	// primero los datos y al final la llave: si algo falla, no queda una llave sin lista
	if err := guardarDatos(s.rutaDatos(), datos); err != nil {
		return errors.New("No pude guardar en esta computadora: " + err.Error())
	}
	if err := escribirAtomico(s.rutaLlave(), cuerpo, false); err != nil {
		return errors.New("No pude guardar la llave: " + err.Error())
	}
	s.priv, s.clave, s.datos = priv, clave, datos
	return nil
}

func (s *servidor) abrir(clave string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.abierto() {
		return nil
	}
	b, err := os.ReadFile(s.rutaLlave())
	if err != nil {
		return errors.New("No encontré la llave en esta computadora.")
	}
	env, err := leerSobre(b)
	if err != nil {
		return err
	}
	semilla, err := abrirSobre(env, formatoLlave, clave)
	if err != nil {
		time.Sleep(700 * time.Millisecond) // frena a quien pruebe contraseñas una tras otra
		return err
	}
	priv, err := llaveDeSemilla(semilla, env.Publica)
	if err != nil {
		return err
	}
	datos, err := leerDatos(s.rutaDatos())
	if err != nil {
		return err
	}
	s.priv, s.clave, s.datos = priv, clave, datos
	return nil
}

// ---------------------------------------------------------------- clientes y códigos

type vistaSolicitud struct {
	Tipo       string            `json:"tipo"`
	Plan       string            `json:"plan"`
	Sucursales int               `json:"sucursales"`
	IDEquipo   string            `json:"id_equipo"`
	Fecha      string            `json:"fecha"`
	App        string            `json:"app"`
	PruebaDias *int              `json:"prueba_dias_restantes"`
	Negocio    map[string]string `json:"negocio"`
	Nota       string            `json:"nota"`
}

func (s *servidor) leerSolicitudHTTP(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Texto string `json:"texto"`
	}
	if !leerJSON(w, r, &p, 1<<17) {
		return
	}
	sol, err := leerSolicitud(p.Texto)
	if err != nil {
		responder(w, 200, map[string]interface{}{"ok": false, "mensaje": err.Error()})
		return
	}
	v := vistaSolicitud{Tipo: sol.Tipo, Plan: sol.Plan, Sucursales: sol.Sucursales, IDEquipo: sol.IDEquipo,
		Fecha: sol.Fecha, App: sol.App, PruebaDias: sol.PruebaDias, Negocio: sol.textosNegocio(), Nota: limpiarTexto(sol.Nota, 300)}
	clienteID := 0
	if id, ok := leerIDEquipo(sol.IDEquipo); ok {
		v.IDEquipo = formatearIDEquipo(id)
		s.mu.Lock()
		if c := s.datos.clientePorEquipo(id); c != nil {
			clienteID = c.ID
		}
		s.mu.Unlock()
	}
	responder(w, 200, map[string]interface{}{"ok": true, "datos": v, "clienteId": clienteID})
}

type pedidoGenerar struct {
	ClienteID  int    `json:"clienteId"`
	Negocio    string `json:"negocio"`
	Contacto   string `json:"contacto"`
	WhatsApp   string `json:"whatsapp"`
	Email      string `json:"email"`
	IDEquipo   string `json:"idEquipo"`
	Tipo       string `json:"tipo"`
	Plan       string `json:"plan"`
	Sucursales int    `json:"sucursales"`
	Vence      string `json:"vence"`
	Solicitud  string `json:"solicitud"`
}

func (s *servidor) generar(p pedidoGenerar) (codigo string, serie uint32, clienteID int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p.Negocio = limpiarTexto(p.Negocio, 80)
	if p.Negocio == "" {
		return "", 0, 0, errors.New("Falta el nombre del negocio.")
	}
	id, ok := leerIDEquipo(p.IDEquipo)
	if !ok || id == 0 {
		return "", 0, 0, errors.New("El ID del equipo no parece correcto (son 12 letras y números, como 7KQ2-9XMA-4TPL).")
	}
	if _, ok := tipoNum[p.Tipo]; !ok {
		return "", 0, 0, errors.New("Elige el tipo de licencia.")
	}
	if _, ok := planNum[p.Plan]; !ok {
		return "", 0, 0, errors.New("Elige el plan.")
	}
	if p.Sucursales < 1 || p.Sucursales > 255 {
		return "", 0, 0, errors.New("Las sucursales deben ser de 1 a 255.")
	}
	emitida := s.hoy()
	vence := strings.TrimSpace(p.Vence)
	if p.Tipo == "permanente" {
		vence = ""
	} else {
		if vence == "" {
			return "", 0, 0, errors.New("Elige la fecha de vencimiento.")
		}
		dv, err := fechaADias(vence)
		if err != nil {
			return "", 0, 0, errors.New("La fecha de vencimiento no es válida.")
		}
		de, _ := fechaADias(emitida)
		if dv < de {
			return "", 0, 0, errors.New("La fecha de vencimiento ya pasó. Elige una fecha de hoy en adelante.")
		}
	}

	// ¿a qué cliente pertenece?
	var cli *Cliente
	if p.ClienteID != 0 {
		cli = s.datos.clientePorID(p.ClienteID)
	}
	if cli == nil {
		cli = s.datos.clientePorEquipo(id)
	}
	if otro := s.datos.clientePorEquipo(id); otro != nil && cli != nil && otro.ID != cli.ID {
		return "", 0, 0, fmt.Errorf("Ese ID de equipo ya pertenece a otro cliente (%s).", otro.Negocio)
	}

	serie = s.datos.SiguienteSerie
	codigo, err = emitirCodigo(DatosCodigo{Tipo: p.Tipo, Plan: p.Plan, MaxSucursales: p.Sucursales,
		Emitida: emitida, Vence: vence, IDEquipo: id, Serie: serie}, s.priv)
	if err != nil {
		return "", 0, 0, err
	}

	// Se trabaja sobre una copia: si no se puede guardar, no cambia nada ni se entrega el código.
	copia := *s.datos
	copia.Clientes = append([]Cliente{}, s.datos.Clientes...)
	copia.Emitidos = append([]Emitido{}, s.datos.Emitidos...)
	ahora := s.ahora().Format("2006-01-02 15:04")
	var objetivo *Cliente
	if cli != nil {
		for i := range copia.Clientes {
			if copia.Clientes[i].ID == cli.ID {
				objetivo = &copia.Clientes[i]
			}
		}
	}
	if objetivo == nil {
		copia.Clientes = append(copia.Clientes, Cliente{ID: copia.SiguienteID, Creado: ahora})
		copia.SiguienteID++
		objetivo = &copia.Clientes[len(copia.Clientes)-1]
	}
	objetivo.Negocio = p.Negocio
	objetivo.Contacto = limpiarTexto(p.Contacto, 80)
	objetivo.WhatsApp = limpiarTexto(p.WhatsApp, 25)
	objetivo.Email = limpiarTexto(p.Email, 80)
	objetivo.IDEquipo = formatearIDEquipo(id)
	objetivo.Plan, objetivo.Sucursales, objetivo.Tipo = p.Plan, p.Sucursales, p.Tipo
	objetivo.Vence, objetivo.Emitida, objetivo.UltimaSerie, objetivo.Actualizado = vence, emitida, serie, ahora
	if sol, e := leerSolicitud(p.Solicitud); e == nil {
		extra := sol.textosNegocio()
		if len(extra) > 0 {
			mezcla := map[string]string{}
			for k, v := range objetivo.DatosNegocio {
				mezcla[k] = v
			}
			for k, v := range extra {
				mezcla[k] = v
			}
			objetivo.DatosNegocio = mezcla
		}
	}
	copia.Emitidos = append(copia.Emitidos, Emitido{Serie: serie, Fecha: emitida, ClienteID: objetivo.ID, Negocio: objetivo.Negocio,
		Tipo: p.Tipo, Plan: p.Plan, Sucursales: p.Sucursales, Emitida: emitida, Vence: vence, IDEquipo: objetivo.IDEquipo, Codigo: codigo})
	copia.SiguienteSerie = serie + 1
	if err := guardarDatos(s.rutaDatos(), &copia); err != nil {
		return "", 0, 0, errors.New("No pude guardar en esta computadora: " + err.Error())
	}
	s.datos = &copia
	return codigo, serie, objetivo.ID, nil
}

// ---------------------------------------------------------------- respaldo y restauración

type contenidoRespaldo struct {
	Semilla string `json:"semilla"`
	Datos   *Datos `json:"datos"`
	Creado  string `json:"creado"`
}

func mismaRuta(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }

// respaldar escribe el respaldo cifrado en la carpeta y lo comprueba leyéndolo de vuelta.
func (s *servidor) respaldar(carpeta string) (ruta string, nuevo bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, e := os.Stat(carpeta)
	if e != nil || !info.IsDir() {
		return "", false, errors.New("No encontré esa carpeta.")
	}
	carpeta = filepath.Clean(carpeta)
	nuevo = true
	lista := []Respaldo{}
	for _, r := range s.datos.Respaldos {
		if mismaRuta(r.Ruta, carpeta) {
			nuevo = false
			continue
		}
		lista = append(lista, r)
	}
	lista = append(lista, Respaldo{Ruta: carpeta, Fecha: s.hoy(), Serie: s.datos.SiguienteSerie - 1})
	copia := *s.datos
	copia.Respaldos = lista

	semilla := s.priv.Seed()
	plano, _ := json.Marshal(contenidoRespaldo{Semilla: base64.StdEncoding.EncodeToString(semilla), Datos: &copia, Creado: s.hoy()})
	pub := publicaHex(s.priv.Public().(ed25519.PublicKey))
	env, err := sellar(formatoRespaldo, plano, s.clave, pub, s.hoy())
	if err != nil {
		return "", false, err
	}
	cuerpo, _ := json.MarshalIndent(env, "", "  ")
	ruta = filepath.Join(carpeta, "Respaldo-Activador-Compoint-"+s.hoy()+".cptbak")
	if err := escribirAtomico(ruta, cuerpo, false); err != nil {
		return "", false, errors.New("No pude escribir en esa carpeta: " + err.Error())
	}
	// comprobar: leer de vuelta y abrir con la contraseña
	leido, err := os.ReadFile(ruta)
	if err == nil {
		var e2 *sobre
		if e2, err = leerSobre(leido); err == nil {
			var p2 []byte
			if p2, err = abrirSobre(e2, formatoRespaldo, s.clave); err == nil {
				var c2 contenidoRespaldo
				if json.Unmarshal(p2, &c2) != nil || c2.Semilla != base64.StdEncoding.EncodeToString(semilla) {
					err = errors.New("el archivo no quedó igual")
				}
			}
		}
	}
	if err != nil {
		_ = os.Remove(ruta)
		return "", false, errors.New("El respaldo no pasó la comprobación, no se guardó: " + err.Error())
	}
	sort.SliceStable(lista, func(i, j int) bool { return lista[i].Fecha < lista[j].Fecha })
	copia.Respaldos = lista
	if err := guardarDatos(s.rutaDatos(), &copia); err != nil {
		return "", false, errors.New("El respaldo se hizo, pero no pude anotarlo: " + err.Error())
	}
	s.datos = &copia
	return ruta, nuevo, nil
}

func (s *servidor) restaurar(archivo, clave string, confirmar bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := leerSobre([]byte(archivo))
	if err != nil {
		return err
	}
	plano, err := abrirSobre(env, formatoRespaldo, clave)
	if err != nil {
		time.Sleep(700 * time.Millisecond)
		return err
	}
	var c contenidoRespaldo
	if json.Unmarshal(plano, &c) != nil || c.Datos == nil {
		return errors.New("El archivo está dañado.")
	}
	semilla, err := base64.StdEncoding.DecodeString(c.Semilla)
	if err != nil {
		return errors.New("El archivo está dañado.")
	}
	priv, err := llaveDeSemilla(semilla, env.Publica)
	if err != nil {
		return err
	}
	if s.hayLlave() && !confirmar {
		return errors.New("confirmar")
	}
	c.Datos.normalizar()
	nueva, err := sellar(formatoLlave, semilla, clave, env.Publica, s.hoy())
	if err != nil {
		return err
	}
	cuerpo, _ := json.MarshalIndent(nueva, "", "  ")
	// lo que había antes no se borra: queda con la fecha en el nombre
	marca := s.ahora().Format("20060102-150405")
	for _, f := range []string{s.rutaLlave(), s.rutaDatos()} {
		if _, e := os.Stat(f); e == nil {
			_ = os.Rename(f, f+".antes-"+marca)
		}
	}
	if err := guardarDatos(s.rutaDatos(), c.Datos); err != nil {
		return err
	}
	if err := escribirAtomico(s.rutaLlave(), cuerpo, false); err != nil {
		return err
	}
	s.priv, s.clave, s.datos = priv, clave, c.Datos
	return nil
}

// ---------------------------------------------------------------- rutas

func (s *servidor) rutas() *http.ServeMux {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(interfazFS, "ui")
	archivos := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.addr {
			http.Error(w, "No permitido", http.StatusForbidden)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if r.URL.Query().Get("t") != s.token {
				http.Error(w, "Abre el Activador desde el programa.", http.StatusForbidden)
				return
			}
			datos, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				http.Error(w, "No se encontró la pantalla", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(strings.Replace(string(datos), "__TOKEN__", s.token, 1)))
			return
		}
		if strings.HasSuffix(r.URL.Path, ".png") {
			archivos.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})

	mux.HandleFunc("/api/estado", s.protegido(func(w http.ResponseWriter, r *http.Request) { responder(w, 200, s.estado()) }))

	mux.HandleFunc("/api/crear-llave", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Clave string `json:"clave"`
		}
		if !leerJSON(w, r, &p, 1<<12) {
			return
		}
		if err := s.crearLlave(p.Clave); err != nil {
			fallo(w, 400, err.Error())
			return
		}
		registrar("Llave creada")
		responder(w, 200, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("/api/abrir", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Clave string `json:"clave"`
		}
		if !leerJSON(w, r, &p, 1<<12) {
			return
		}
		if err := s.abrir(p.Clave); err != nil {
			fallo(w, 400, err.Error())
			return
		}
		responder(w, 200, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("/api/clientes", s.conLlave(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		lista := append([]Cliente{}, s.datos.Clientes...)
		s.mu.Unlock()
		responder(w, 200, map[string]interface{}{"clientes": lista})
	}))

	mux.HandleFunc("/api/historial", s.conLlave(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		lista := make([]Emitido, 0, len(s.datos.Emitidos))
		for i := len(s.datos.Emitidos) - 1; i >= 0; i-- {
			lista = append(lista, s.datos.Emitidos[i])
		}
		s.mu.Unlock()
		responder(w, 200, map[string]interface{}{"codigos": lista})
	}))

	mux.HandleFunc("/api/leer-solicitud", s.conLlave(s.leerSolicitudHTTP))

	mux.HandleFunc("/api/generar", s.conLlave(func(w http.ResponseWriter, r *http.Request) {
		var p pedidoGenerar
		if !leerJSON(w, r, &p, 1<<17) {
			return
		}
		codigo, serie, cid, err := s.generar(p)
		if err != nil {
			fallo(w, 400, err.Error())
			return
		}
		registrar(fmt.Sprintf("Código emitido: serie %d", serie)) // el código y el cliente no se anotan en el registro
		responder(w, 200, map[string]interface{}{"ok": true, "codigo": codigo, "serie": serie, "clienteId": cid})
	}))

	mux.HandleFunc("/api/respaldo", s.conLlave(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Carpeta string `json:"carpeta"`
		}
		if !leerJSON(w, r, &p, 1<<12) {
			return
		}
		carpeta := strings.TrimSpace(p.Carpeta)
		if carpeta == "" {
			c, err := s.elegir("Elige dónde guardar el respaldo (una memoria USB o una carpeta de tu nube)")
			if err != nil {
				fallo(w, 500, "No pude abrir el selector de carpetas: "+err.Error())
				return
			}
			if c == "" {
				responder(w, 200, map[string]interface{}{"ok": true, "cancelado": true})
				return
			}
			carpeta = c
		}
		ruta, nuevo, err := s.respaldar(carpeta)
		if err != nil {
			fallo(w, 400, err.Error())
			return
		}
		registrar("Respaldo hecho")
		responder(w, 200, map[string]interface{}{"ok": true, "ruta": ruta, "nuevo": nuevo})
	}))

	mux.HandleFunc("/api/restaurar", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Archivo   string `json:"archivo"`
			Clave     string `json:"clave"`
			Confirmar bool   `json:"confirmar"`
		}
		if !leerJSON(w, r, &p, 8<<20) {
			return
		}
		if err := s.restaurar(p.Archivo, p.Clave, p.Confirmar); err != nil {
			if err.Error() == "confirmar" {
				responder(w, 409, map[string]interface{}{"error": "Ya hay una llave en esta computadora. Si la reemplazas, la actual se guarda con la fecha en el nombre.", "confirmar": true})
				return
			}
			fallo(w, 400, err.Error())
			return
		}
		registrar("Llave restaurada desde un respaldo")
		responder(w, 200, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("/api/latido", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		s.latidoMu.Lock()
		s.ultimoLatido = time.Now()
		s.huboLatido = true
		s.latidoMu.Unlock()
		responder(w, 200, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("/api/cerrar", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		responder(w, 200, map[string]bool{"ok": true})
		go func() {
			time.Sleep(400 * time.Millisecond)
			s.terminar(0)
		}()
	}))
	return mux
}

func (s *servidor) terminar(codigo int) {
	if s.ventana != nil && s.ventana.Process != nil {
		_ = s.ventana.Process.Kill()
	}
	os.Exit(codigo)
}

// vigilar cierra el programa cuando se cierra la ventana.
func (s *servidor) vigilar() {
	for {
		time.Sleep(2 * time.Second)
		s.latidoMu.Lock()
		hubo, ultimo := s.huboLatido, s.ultimoLatido
		s.latidoMu.Unlock()
		if hubo && time.Since(ultimo) > 90*time.Second {
			registrar("Sin latido: cerrando")
			s.terminar(0)
		}
		if !hubo && time.Since(s.inicio) > 3*time.Minute {
			registrar("La ventana nunca abrió: cerrando")
			s.terminar(1)
		}
	}
}

// registrar anota en el registro de soporte. NUNCA se escriben contraseñas, códigos ni datos de clientes.
func registrar(texto string) {
	dir := filepath.Join(os.TempDir(), "CompointActivador")
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "activador-log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), texto)
}

func carpetaDatos() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Compoint Activador")
}

func main() {
	fl := flag.NewFlagSet("activador", flag.ContinueOnError)
	datos := fl.String("datos", "", "carpeta de datos (pruebas)")
	sinVentana := fl.Bool("sin-ventana", false, "no abre la ventana (pruebas)")
	puerto := fl.Int("puerto", 0, "puerto local fijo (pruebas)")
	token := fl.String("token", "", "clave fija (pruebas)")
	_ = fl.Parse(os.Args[1:])

	if *datos == "" && !instanciaUnica() {
		os.Exit(0) // ya hay un Activador abierto
	}
	dir := *datos
	if dir == "" {
		dir = carpetaDatos()
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		registrar("No se pudo crear la carpeta de datos: " + err.Error())
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *puerto))
	if err != nil {
		registrar("No se pudo abrir el puerto local: " + err.Error())
		os.Exit(1)
	}
	s := &servidor{dir: dir, token: *token, addr: ln.Addr().String(), ahora: time.Now, elegir: elegirCarpeta, inicio: time.Now()}
	if s.token == "" {
		s.token = nuevoToken()
	}
	registrar("Inicio " + version)
	go s.vigilar()

	url := fmt.Sprintf("http://%s/?t=%s", s.addr, s.token)
	if *sinVentana {
		fmt.Println("URL:", url)
	} else {
		cmd, err := abrirVentana(url)
		if err != nil {
			registrar("No se pudo abrir la ventana: " + err.Error())
		} else if cmd != nil {
			s.ventana = cmd
			go func() {
				_ = cmd.Wait()
				if time.Since(s.inicio) < 4*time.Second {
					return // el navegador entregó la ventana a otro proceso: el latido se encarga
				}
				registrar("Ventana cerrada")
				os.Exit(0)
			}()
		}
	}
	srv := &http.Server{Handler: s.rutas(), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		registrar("Servidor: " + err.Error())
		os.Exit(1)
	}
}
