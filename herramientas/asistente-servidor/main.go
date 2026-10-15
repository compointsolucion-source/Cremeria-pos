// Asistente del servidor — Compoint Punto
//
// Un solo .exe que reemplaza a los 3 .bat (permitir Firewall, fijar IP, quitar regla).
// Abre una ventana con el logo de Compoint (una página local que se muestra como app)
// y ofrece dos modos: Predeterminado (todo automático) y Avanzado (tú eliges).
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
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed ui/*
var interfazFS embed.FS

const version = "1.0.0"

// Sistema es lo que toca Windows. Hay una versión real (windows.go) y una simulada (simulado.go).
type Sistema interface {
	Estado() (Estado, error)
	// Ejecutar hace los pasos y avisa cada cambio. Bloquea hasta terminar.
	Ejecutar(op Opciones, avance func(fase string, pasos []Paso)) error
}

type trabajo struct {
	mu     sync.Mutex
	fase   string
	pasos  []Paso
	err    string
	puerto int
	modo   string
	activo bool
}

// vistaTrabajo es lo que se manda a la pantalla.
type vistaTrabajo struct {
	Fase   string `json:"fase"` // esperando-permiso, trabajando, terminado, error
	Pasos  []Paso `json:"pasos"`
	Error  string `json:"error"`
	Puerto int    `json:"puerto"`
	Modo   string `json:"modo"` // configurar | deshacer
}

func (t *trabajo) vista() vistaTrabajo {
	t.mu.Lock()
	defer t.mu.Unlock()
	return vistaTrabajo{Fase: t.fase, Pasos: append([]Paso(nil), t.pasos...), Error: t.err, Puerto: t.puerto, Modo: t.modo}
}

type servidor struct {
	sis   Sistema
	token string
	addr  string

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

// protegido: solo esta computadora, con la clave de esta sesión.
func (s *servidor) protegido(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.addr {
			http.Error(w, "No permitido", http.StatusForbidden)
			return
		}
		if r.Header.Get("X-Token") != s.token {
			http.Error(w, "No permitido", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

func (s *servidor) detectar(forzar bool) Estado {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.estado != nil && !forzar {
		return *s.estado
	}
	e, err := s.sis.Estado()
	if err != nil {
		registrar("Estado: " + err.Error())
		e.Aviso = "No pude revisar la red automáticamente. Puedes continuar con el modo Avanzado."
	}
	elegirPrincipal(e.Adaptadores)
	s.estado = &e
	return e
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
				http.Error(w, "Abre el asistente desde el programa.", http.StatusForbidden)
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

	mux.HandleFunc("/api/aplicar", s.protegido(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Método no permitido", http.StatusMethodNotAllowed)
			return
		}
		var op Opciones
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&op); err != nil {
			responder(w, 400, map[string]string{"error": "No entendí lo que se pidió."})
			return
		}
		if err := validar(&op); err != nil {
			responder(w, 400, map[string]string{"error": err.Error()})
			return
		}
		s.mu.Lock()
		if s.trabajo != nil && s.trabajo.activo {
			s.mu.Unlock()
			responder(w, 409, map[string]string{"error": "Ya hay un cambio en proceso. Espera a que termine."})
			return
		}
		modo := "configurar"
		if (op.QuitarFirewall || op.IPAutomatica) && !op.Firewall && !op.Ping && !op.RedPrivada && !op.IPFija {
			modo = "deshacer"
		}
		t := &trabajo{fase: "esperando-permiso", pasos: pasosDe(op), puerto: op.Puerto, modo: modo, activo: true}
		s.trabajo = t
		s.mu.Unlock()
		go s.correr(t, op)
		responder(w, 200, map[string]bool{"ok": true})
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

func (s *servidor) correr(t *trabajo, op Opciones) {
	err := s.sis.Ejecutar(op, func(fase string, pasos []Paso) {
		t.mu.Lock()
		if fase != "" {
			t.fase = fase
		}
		if pasos != nil {
			t.pasos = pasos
		}
		t.mu.Unlock()
	})
	t.mu.Lock()
	if err != nil {
		t.fase = "error"
		t.err = err.Error()
		registrar("Error: " + err.Error())
	} else {
		t.fase = "terminado"
	}
	t.activo = false
	t.mu.Unlock()
	// la próxima vez que se pregunte el estado se vuelve a leer
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

// vigilar cierra el programa cuando se cierra la ventana.
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

func registrar(texto string) {
	dir := filepath.Join(os.TempDir(), "CompointAsistente")
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "asistente-log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), texto)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--elevado" {
		os.Exit(ejecutarElevado(os.Args[2:]))
	}

	fl := flag.NewFlagSet("asistente", flag.ContinueOnError)
	simulado := fl.Bool("simulado", false, "no toca Windows (pruebas)")
	sinVentana := fl.Bool("sin-ventana", false, "no abre la ventana (pruebas)")
	puerto := fl.Int("puerto", 0, "puerto local fijo (pruebas)")
	token := fl.String("token", "", "clave fija (pruebas)")
	_ = fl.Parse(os.Args[1:])

	var sis Sistema
	if *simulado || runtime.GOOS != "windows" {
		sis = nuevoSimulado()
	} else {
		sis = nuevoSistemaReal()
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *puerto))
	if err != nil {
		registrar("No se pudo abrir el puerto local: " + err.Error())
		os.Exit(1)
	}
	s := &servidor{sis: sis, token: *token, addr: ln.Addr().String(), inicio: time.Now()}
	if s.token == "" {
		s.token = nuevoToken()
	}
	registrar("Inicio " + version + " en " + s.addr)

	// Revisar la red mientras abre la ventana
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
