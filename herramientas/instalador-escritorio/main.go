// Instalador de Compoint Punto
//
// Un solo .exe con el logo de Compoint (una página local que se muestra como app), igual al Asistente
// del servidor. Lleva dentro el instalador del programa y deja elegir dónde guardar el programa,
// la información del negocio y los respaldos (más una copia extra en otra unidad).
//
// Modos: Predeterminado (todo automático) y Avanzado (se elige cada cosa).
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed ui/*
var interfazFS embed.FS

const version = "1.0.0"

type trabajo struct {
	mu      sync.Mutex
	fase    string // esperando-permiso, trabajando, terminado, error
	pasos   []Paso
	pct     int
	err     string
	resumen *Resumen
	activo  bool
}

// vistaTrabajo es lo que se manda a la pantalla.
type vistaTrabajo struct {
	Fase    string   `json:"fase"`
	Pasos   []Paso   `json:"pasos"`
	Pct     int      `json:"pct"`
	Error   string   `json:"error"`
	Resumen *Resumen `json:"resumen,omitempty"`
}

func (t *trabajo) vista() vistaTrabajo {
	t.mu.Lock()
	defer t.mu.Unlock()
	v := vistaTrabajo{Fase: t.fase, Pasos: copiaPasos(t.pasos), Pct: t.pct, Error: t.err}
	if t.resumen != nil {
		r := *t.resumen
		v.Resumen = &r
	}
	return v
}

type servidor struct {
	sis      Sistema
	meta     Meta
	carga    *Carga
	simulado bool
	token    string
	addr     string

	mu      sync.Mutex
	estado  *Estado
	trabajo *trabajo

	latidoMu     sync.Mutex
	ultimoLatido time.Time
	huboLatido   bool
	inicio       time.Time

	ventana *exec.Cmd
}

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

func fallaTexto(w http.ResponseWriter, codigo int, texto string) {
	responder(w, codigo, map[string]string{"error": texto})
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

// sugerirCopiaExtra propone una carpeta en OTRA unidad para la copia extra: primero una USB, si no un
// segundo disco. Si no hay dónde, no propone nada (la copia extra queda apagada).
func sugerirCopiaExtra(us []Unidad, datos, respaldos string) string {
	const minimo = 1024 * mb
	for _, u := range us {
		if u.Tipo == "usb" && u.Libre > minimo {
			return unir(u.Letra+`\`, subcarpetaResp)
		}
	}
	for _, u := range us {
		if u.Tipo == "fijo" && u.Libre > 5*minimo && !strings.EqualFold(u.Letra, letraDe(datos)) && !strings.EqualFold(u.Letra, letraDe(respaldos)) {
			return unir(u.Letra+`\`, subcarpetaResp)
		}
	}
	return ""
}

func (s *servidor) construirEstado() Estado {
	d := s.sis.Defaults()
	us := s.sis.Unidades()
	e := Estado{
		Version:       s.meta.Version,
		Equipo:        s.sis.Equipo(),
		Negocio:       s.meta.Negocio,
		ConUrl:        s.meta.ConUrl,
		Unidades:      us,
		Programa:      d.Programa,
		Datos:         unir(d.Base, "datos"),
		Respaldos:     unir(d.Base, "Respaldos"),
		EsAdmin:       s.sis.EsAdmin(),
		Simulado:      s.simulado,
		SinPaquete:    s.carga == nil && !s.simulado,
		TamanoPaquete: s.meta.TamanoPaquete,
	}
	if e.Version == "" {
		e.Version = version
	}
	inst := s.meta.TamanoInstalado
	if inst <= 0 {
		inst = 450 * mb
	}
	e.TamanoNecesario = inst + inst/10
	if y := s.sis.YaInstalado(); y != "" {
		e.YaInstalado, e.Programa = y, y
	}
	if x := s.sis.DatosExistentes(); x != "" {
		e.DatosExistentes, e.Datos = x, x
	}
	e.CopiaExtra = sugerirCopiaExtra(us, e.Datos, e.Respaldos)
	e.AppAbierta = s.sis.AppAbierta()
	return e
}

func (s *servidor) detectar(forzar bool) Estado {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.estado != nil && !forzar {
		e := *s.estado
		return e
	}
	e := s.construirEstado()
	s.estado = &e
	return e
}

func leerJSON(w http.ResponseWriter, r *http.Request, destino interface{}) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "Método no permitido", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(destino); err != nil {
		fallaTexto(w, 400, "No entendí lo que se pidió.")
		return false
	}
	return true
}

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
				http.Error(w, "Abre el instalador desde el programa.", http.StatusForbidden)
				return
			}
			datos, err := fs.ReadFile(sub, "index.html")
			if err != nil {
				http.Error(w, "No se encontró la pantalla", http.StatusInternalServerError)
				return
			}
			html := strings.Replace(string(datos), "__TOKEN__", s.token, 1)
			html = strings.Replace(html, "__VERSION__", version, 1)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(html))
			return
		}
		if strings.HasSuffix(r.URL.Path, ".png") {
			archivos.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})

	mux.HandleFunc("/api/estado", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		responder(w, 200, s.detectar(r.URL.Query().Get("refrescar") == "1"))
	}))

	mux.HandleFunc("/api/carpetas", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		ruta := strings.TrimSpace(r.URL.Query().Get("ruta"))
		if ruta != "" {
			ruta2, err := validarRuta(ruta, true)
			if err != nil {
				fallaTexto(w, 400, err.Error())
				return
			}
			ruta = ruta2
		}
		l, err := s.sis.Listar(ruta)
		if err != nil {
			registrar("Listar " + ruta + ": " + err.Error())
			fallaTexto(w, 400, err.Error())
			return
		}
		responder(w, 200, l)
	}))

	mux.HandleFunc("/api/carpetas/nueva", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Ruta, Nombre string }
		if !leerJSON(w, r, &q) {
			return
		}
		nombre := strings.TrimSpace(q.Nombre)
		if err := segmentoValido(nombre); err != nil {
			fallaTexto(w, 400, err.Error())
			return
		}
		if strings.ContainsAny(nombre, `\/`) {
			fallaTexto(w, 400, "El nombre no puede llevar barras.")
			return
		}
		padre, err := validarRuta(q.Ruta, true)
		if err != nil {
			fallaTexto(w, 400, err.Error())
			return
		}
		nueva := unir(padre, nombre)
		if err := s.sis.CrearCarpeta(nueva); err != nil {
			registrar("Crear carpeta " + nueva + ": " + err.Error())
			fallaTexto(w, 400, err.Error())
			return
		}
		l, err := s.sis.Listar(nueva)
		if err != nil {
			fallaTexto(w, 400, err.Error())
			return
		}
		responder(w, 200, l)
	}))

	mux.HandleFunc("/api/validar", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var op Opciones
		if !leerJSON(w, r, &op) {
			return
		}
		responder(w, 200, validar(&op, s.sis, s.meta))
	}))

	mux.HandleFunc("/api/instalar", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var op Opciones
		if !leerJSON(w, r, &op) {
			return
		}
		if s.carga == nil && !s.simulado {
			fallaTexto(w, 500, "Este instalador está incompleto (no trae el programa). Descárgalo otra vez.")
			return
		}
		v := validar(&op, s.sis, s.meta)
		if !v.ok() {
			responder(w, 400, map[string]interface{}{"error": v.Errores[0], "validacion": v})
			return
		}
		s.mu.Lock()
		if s.trabajo != nil && s.trabajo.activo {
			s.mu.Unlock()
			fallaTexto(w, 409, "Ya hay una instalación en proceso. Espera a que termine.")
			return
		}
		if s.sis.AppAbierta() {
			s.mu.Unlock()
			responder(w, 409, map[string]interface{}{"error": "Compoint Punto está abierto. Ciérralo (junto al reloj: clic derecho en su icono → Salir por completo) y vuelve a intentarlo.", "appAbierta": true})
			if c, ok := s.sis.(interface{ CerrarApp() }); ok {
				c.CerrarApp()
			}
			return
		}
		t := &trabajo{fase: "trabajando", pasos: pasosDe(op), activo: true}
		s.trabajo = t
		s.mu.Unlock()
		registrar(fmt.Sprintf("Instalar: modo=%s uso=%s programa=%q datos=%q respaldos=%q copiaExtra=%q", op.Modo, op.Uso, op.Programa, op.Datos, op.Respaldos, op.CopiaExtra))
		go s.correr(t, op)
		responder(w, 200, map[string]interface{}{"ok": true, "avisos": v.Avisos})
	}))

	mux.HandleFunc("/api/progreso", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		t := s.trabajo
		s.mu.Unlock()
		if t == nil {
			responder(w, 200, map[string]string{"fase": "ninguno"})
			return
		}
		responder(w, 200, t.vista())
	}))

	mux.HandleFunc("/api/abrir", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Que string }
		if !leerJSON(w, r, &q) {
			return
		}
		s.mu.Lock()
		t := s.trabajo
		s.mu.Unlock()
		var res *Resumen
		if t != nil {
			t.mu.Lock()
			res = t.resumen
			t.mu.Unlock()
		}
		if res == nil {
			fallaTexto(w, 400, "Todavía no hay nada instalado.")
			return
		}
		switch q.Que {
		case "app", "programa", "datos", "respaldos", "copia":
		default:
			fallaTexto(w, 400, "No sé abrir eso.")
			return
		}
		if err := s.sis.Abrir(q.Que, *res); err != nil {
			registrar("Abrir " + q.Que + ": " + err.Error())
			fallaTexto(w, 500, err.Error())
			return
		}
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
		if s.hayTrabajo() {
			fallaTexto(w, 409, "Espera a que termine la instalación.")
			return
		}
		responder(w, 200, map[string]bool{"ok": true})
		go func() {
			time.Sleep(400 * time.Millisecond)
			s.terminar(0)
		}()
	}))
	return mux
}

func (s *servidor) correr(t *trabajo, op Opciones) {
	res, err := s.sis.Instalar(op, s.meta, s.carga, func(fase string, pasos []Paso, pct int) {
		t.mu.Lock()
		if fase != "" {
			t.fase = fase
		}
		if pasos != nil {
			t.pasos = pasos
		}
		if pct > t.pct {
			t.pct = pct
		}
		t.mu.Unlock()
	})
	t.mu.Lock()
	if err != nil {
		t.fase = "error"
		t.err = err.Error()
		registrar("Error: " + err.Error())
		// si ningún paso quedó marcado con error, se marca el que estaba en curso
		hayError := false
		for _, p := range t.pasos {
			if p.Estado == "error" {
				hayError = true
			}
		}
		if !hayError {
			for i := range t.pasos {
				if t.pasos[i].Estado == "haciendo" {
					t.pasos[i].Estado, t.pasos[i].Detalle = "error", err.Error()
					break
				}
			}
		}
	} else {
		t.fase = "terminado"
		t.pct = 100
		r := res
		t.resumen = &r
		registrar("Instalación terminada en " + res.Programa)
	}
	t.activo = false
	t.mu.Unlock()
	s.mu.Lock()
	s.estado = nil
	s.mu.Unlock()
}

func (s *servidor) hayTrabajo() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.trabajo != nil && s.trabajo.activo
}

func (s *servidor) terminar(codigo int) {
	if s.ventana != nil && s.ventana.Process != nil {
		_ = s.ventana.Process.Kill()
	}
	os.Exit(codigo)
}

// vigilar cierra el programa cuando se cierra la ventana (nunca mientras se instala).
func (s *servidor) vigilar() {
	for {
		time.Sleep(2 * time.Second)
		if s.hayTrabajo() {
			continue
		}
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

func metaSimulada() Meta {
	m := Meta{Formato: 1, Version: version, Negocio: "Compoint Punto", Archivo: "Payload-CompointPunto.exe", TamanoInstalado: 452 * mb, TamanoPaquete: 118 * mb}
	if v := strings.TrimSpace(os.Getenv("INSTALADOR_SIM_NEGOCIO")); v != "" {
		m.Negocio = v
	}
	m.ConUrl = os.Getenv("INSTALADOR_SIM_CONURL") == "1"
	return m
}

func main() {
	fl := flag.NewFlagSet("instalador", flag.ContinueOnError)
	simulado := fl.Bool("simulado", false, "no toca el equipo (pruebas)")
	sinVentana := fl.Bool("sin-ventana", false, "no abre la ventana (pruebas)")
	puerto := fl.Int("puerto", 0, "puerto local fijo (pruebas)")
	token := fl.String("token", "", "clave fija (pruebas)")
	rutaCarga := fl.String("carga", "", "archivo que trae el paquete (por defecto, este mismo programa)")
	_ = fl.Parse(os.Args[1:])

	if !*simulado && runtime.GOOS == "windows" && !unaInstancia() {
		os.Exit(0)
	}

	s := &servidor{token: *token, inicio: time.Now()}
	if *simulado || runtime.GOOS != "windows" {
		s.simulado = true
		s.sis = nuevoSimulado()
		s.meta = metaSimulada()
	} else {
		s.sis = nuevoSistemaReal()
	}
	// ¿Trae el paquete?
	ruta := *rutaCarga
	if ruta == "" {
		ruta, _ = os.Executable()
	}
	if ruta != "" {
		c, err := abrirCarga(ruta)
		switch {
		case err == nil:
			s.carga = c
			if !s.simulado || *rutaCarga != "" {
				s.meta = c.Meta
			}
			if s.meta.Version == "" {
				s.meta.Version = version
			}
		case err != errSinCarga:
			registrar("Paquete: " + err.Error())
		}
	}
	if s.meta.Version == "" {
		s.meta.Version = version
	}
	if s.meta.Negocio == "" {
		s.meta.Negocio = "Compoint Punto"
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *puerto))
	if err != nil {
		registrar("No se pudo abrir el puerto local: " + err.Error())
		os.Exit(1)
	}
	s.addr = ln.Addr().String()
	if s.token == "" {
		s.token = nuevoToken()
	}
	registrar(fmt.Sprintf("Inicio %s en %s (paquete: %v, simulado: %v)", version, s.addr, s.carga != nil, s.simulado))

	go s.detectar(true)
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
				// Si el navegador entregó la ventana a otro proceso, el latido se encarga.
				if time.Since(s.inicio) < 4*time.Second {
					return
				}
				for s.hayTrabajo() {
					time.Sleep(time.Second)
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
