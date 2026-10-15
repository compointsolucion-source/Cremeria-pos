package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type banco struct {
	t   *testing.T
	s   *servidor
	web *httptest.Server
}

func nuevoBanco(t *testing.T) *banco {
	t.Helper()
	t.Setenv("INSTALADOR_SIM_ESPERA", "5")
	logRuta = filepath.Join(t.TempDir(), "log.txt")
	s := &servidor{sis: nuevoSimulado(), meta: metaSimulada(), simulado: true, token: "clave-de-prueba", inicio: time.Now()}
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.rutas().ServeHTTP(w, r) }))
	s.addr = strings.TrimPrefix(web.URL, "http://")
	t.Cleanup(web.Close)
	return &banco{t: t, s: s, web: web}
}

func (b *banco) llamar(metodo, ruta string, cuerpo interface{}, destino interface{}) int {
	b.t.Helper()
	var lector io.Reader
	if cuerpo != nil {
		j, _ := json.Marshal(cuerpo)
		lector = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(metodo, b.web.URL+ruta, lector)
	req.Header.Set("X-Token", b.s.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer resp.Body.Close()
	if destino != nil {
		_ = json.NewDecoder(resp.Body).Decode(destino)
	}
	return resp.StatusCode
}

func (b *banco) esperarFin() vistaTrabajo {
	b.t.Helper()
	for i := 0; i < 400; i++ {
		var v vistaTrabajo
		b.llamar("GET", "/api/progreso", nil, &v)
		if v.Fase == "terminado" || v.Fase == "error" {
			return v
		}
		time.Sleep(25 * time.Millisecond)
	}
	b.t.Fatal("la instalación no terminó")
	return vistaTrabajo{}
}

func TestSeguridad(t *testing.T) {
	b := nuevoBanco(t)
	// sin clave
	resp, _ := http.Get(b.web.URL + "/api/estado")
	if resp.StatusCode != 403 {
		t.Errorf("sin clave debe ser 403: %d", resp.StatusCode)
	}
	// la página pide la clave
	resp, _ = http.Get(b.web.URL + "/")
	if resp.StatusCode != 403 {
		t.Errorf("la página sin clave debe ser 403: %d", resp.StatusCode)
	}
	resp, _ = http.Get(b.web.URL + "/?t=" + url.QueryEscape(b.s.token))
	cuerpo, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(cuerpo), b.s.token) {
		t.Errorf("la página con clave debe abrir y llevar la clave: %d", resp.StatusCode)
	}
	// otro nombre de equipo (ataque de DNS rebinding)
	req, _ := http.NewRequest("GET", b.web.URL+"/api/estado", nil)
	req.Host = "malo.example.com"
	req.Header.Set("X-Token", b.s.token)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Errorf("otro Host debe ser 403: %d", resp.StatusCode)
	}
}

func TestEstado(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_NEGOCIO", "Cremería La Vaquita")
	b := nuevoBanco(t)
	b.s.meta = metaSimulada()
	var e Estado
	if c := b.llamar("GET", "/api/estado", nil, &e); c != 200 {
		t.Fatalf("estado: %d", c)
	}
	if e.Negocio != "Cremería La Vaquita" || e.Programa != `C:\Users\Compoint\AppData\Local\Programs\Compoint Punto` || e.Datos != `C:\CompointPunto\datos` || e.Respaldos != `C:\CompointPunto\Respaldos` {
		t.Errorf("sugerencias mal: %+v", e)
	}
	if e.CopiaExtra != `E:\Respaldos Compoint` || len(e.Unidades) != 3 || !e.Simulado || e.SinPaquete || e.AppAbierta {
		t.Errorf("estado mal: %+v", e)
	}
	if e.TamanoNecesario < 452*mb {
		t.Errorf("tamaño necesario: %d", e.TamanoNecesario)
	}
}

func TestSelectorDeCarpetas(t *testing.T) {
	b := nuevoBanco(t)
	var l Listado
	if c := b.llamar("GET", "/api/carpetas?ruta=", nil, &l); c != 200 || len(l.Unidades) != 3 || len(l.Carpetas) != 0 || l.Ruta != "" {
		t.Errorf("lista de unidades: %d %+v", c, l)
	}
	l = Listado{}
	b.llamar("GET", "/api/carpetas?ruta="+url.QueryEscape(`D:\`), nil, &l)
	nombres := []string{}
	for _, c := range l.Carpetas {
		nombres = append(nombres, c.Nombre)
	}
	if l.Ruta != `D:\` || l.Padre != "" || strings.Join(nombres, ",") != "Compoint Punto Viejo,Datos,Fotos,Mis archivos,Programas,Solo lectura" || !l.Info.Escribible {
		t.Errorf("contenido de D: %+v", l)
	}
	// una carpeta que no existe muestra la más cercana
	l = Listado{}
	b.llamar("GET", "/api/carpetas?ruta="+url.QueryEscape(`D:\Programas\Compoint Punto`), nil, &l)
	if l.Ruta != `D:\Programas` || l.Padre != `D:\` {
		t.Errorf("la más cercana: %+v", l)
	}
	// ruta con forma mala
	var e map[string]string
	if c := b.llamar("GET", "/api/carpetas?ruta="+url.QueryEscape(`Compoint`), nil, &e); c != 400 || e["error"] == "" {
		t.Errorf("ruta mala debe dar 400: %d %v", c, e)
	}
	// crear carpeta
	l = Listado{}
	if c := b.llamar("POST", "/api/carpetas/nueva", map[string]string{"ruta": `D:\`, "nombre": "Mi Negocio"}, &l); c != 200 || l.Ruta != `D:\Mi Negocio` || !l.Info.Vacia {
		t.Errorf("nueva carpeta: %d %+v", c, l)
	}
	e = nil
	if c := b.llamar("POST", "/api/carpetas/nueva", map[string]string{"ruta": `D:\`, "nombre": "Mi Negocio"}, &e); c != 400 || !strings.Contains(e["error"], "Ya existe") {
		t.Errorf("repetida: %d %v", c, e)
	}
	for _, malo := range []string{"", "a\\b", "CON", "a:b", "x."} {
		if c := b.llamar("POST", "/api/carpetas/nueva", map[string]string{"ruta": `D:\`, "nombre": malo}, &e); c != 400 {
			t.Errorf("nombre %q debería fallar: %d", malo, c)
		}
	}
	if c := b.llamar("POST", "/api/carpetas/nueva", map[string]string{"ruta": `D:\Solo lectura`, "nombre": "x"}, &e); c != 400 || !strings.Contains(e["error"], "permiso") {
		t.Errorf("sin permiso: %d %v", c, e)
	}
}

func TestInstalarCajaPredeterminado(t *testing.T) {
	handoff := filepath.Join(t.TempDir(), "instalacion.json")
	t.Setenv("INSTALADOR_SIM_HANDOFF", handoff)
	b := nuevoBanco(t)
	var e Estado
	b.llamar("GET", "/api/estado", nil, &e)
	var r map[string]interface{}
	if c := b.llamar("POST", "/api/instalar", Opciones{Modo: "pred", Uso: "caja", Programa: e.Programa, Escritorio: true, Inicio: true}, &r); c != 200 {
		t.Fatalf("instalar: %d %v", c, r)
	}
	v := b.esperarFin()
	if v.Fase != "terminado" || v.Pct != 100 || v.Resumen == nil {
		t.Fatalf("debió terminar: %+v", v)
	}
	if v.Resumen.Exe != e.Programa+`\Compoint Punto.exe` || v.Resumen.Datos != "" || v.Resumen.Elevado {
		t.Errorf("resumen: %+v", v.Resumen)
	}
	for _, p := range v.Pasos {
		if p.Estado != "ok" {
			t.Errorf("paso sin terminar: %+v", p)
		}
	}
	m := leer(t, mustBytes(os.ReadFile(handoff)))
	if len(m) != 2 {
		t.Errorf("el predeterminado no debe cambiar nada: %v", m)
	}
	// abrir
	if c := b.llamar("POST", "/api/abrir", map[string]string{"que": "app"}, nil); c != 200 {
		t.Errorf("abrir app: %d", c)
	}
	if c := b.llamar("POST", "/api/abrir", map[string]string{"que": "borrar-todo"}, nil); c != 400 {
		t.Errorf("abrir algo raro debe fallar: %d", c)
	}
}

func TestInstalarServidorAvanzado(t *testing.T) {
	handoff := filepath.Join(t.TempDir(), "instalacion.json")
	t.Setenv("INSTALADOR_SIM_HANDOFF", handoff)
	b := nuevoBanco(t)
	op := Opciones{Modo: "av", Uso: "servidor", Programa: `D:\Programas\Compoint Punto`, Datos: `D:\Negocio\datos`, Respaldos: `D:\Negocio\Respaldos`,
		CopiaExtraOn: true, CopiaExtra: `E:\Respaldos Compoint`, Escritorio: true, AbrirConWindows: true, Intermediario: true}
	if c := b.llamar("POST", "/api/instalar", op, nil); c != 200 {
		t.Fatalf("instalar: %d", c)
	}
	v := b.esperarFin()
	if v.Fase != "terminado" || v.Resumen.Datos != `D:\Negocio\datos` || v.Resumen.CopiaExtra != `E:\Respaldos Compoint` {
		t.Fatalf("resumen: %+v", v)
	}
	// las carpetas quedaron creadas
	var l Listado
	b.llamar("GET", "/api/carpetas?ruta="+url.QueryEscape(`E:\`), nil, &l)
	if len(l.Carpetas) != 3 {
		t.Errorf("debió crearse la carpeta de la copia extra: %+v", l.Carpetas)
	}
	m := leer(t, mustBytes(os.ReadFile(handoff)))
	if m["modo"] != "servidor" || m["carpetaDatos"] != `D:\Negocio\datos` || m["copiaExtra"] != `E:\Respaldos Compoint` {
		t.Errorf("handoff: %v", m)
	}
}

func TestInstalarRechazaMalasOpciones(t *testing.T) {
	b := nuevoBanco(t)
	var r struct {
		Error      string
		Validacion Validacion
	}
	op := Opciones{Modo: "av", Uso: "servidor", Programa: `D:\Programas\Compoint Punto`, Datos: `D:\Programas\Compoint Punto\datos`, Respaldos: `C:\CompointPunto\Respaldos`}
	if c := b.llamar("POST", "/api/instalar", op, &r); c != 400 || r.Error == "" || r.Validacion.Campos["datos"] == "" {
		t.Errorf("debe rechazar: %d %+v", c, r)
	}
	var p map[string]string
	b.llamar("GET", "/api/progreso", nil, &p)
	if p["fase"] != "ninguno" {
		t.Errorf("no debió arrancar nada: %v", p)
	}
}

func TestAppAbiertaSeAvisaYLuegoSigue(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_ABIERTA", "1")
	b := nuevoBanco(t)
	op := Opciones{Modo: "pred", Uso: "caja", Programa: b.s.sis.Defaults().Programa}
	var r map[string]interface{}
	if c := b.llamar("POST", "/api/instalar", op, &r); c != 409 || r["appAbierta"] != true {
		t.Fatalf("debe avisar que está abierta: %d %v", c, r)
	}
	if c := b.llamar("POST", "/api/instalar", op, nil); c != 200 {
		t.Fatalf("al cerrarla debe seguir: %d", c)
	}
	if v := b.esperarFin(); v.Fase != "terminado" {
		t.Errorf("debió terminar: %+v", v)
	}
}

func TestPermisoDeAdministradorNegado(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_UAC", "no")
	b := nuevoBanco(t)
	op := Opciones{Modo: "av", Uso: "caja", Programa: `C:\Program Files\Compoint Punto`}
	if c := b.llamar("POST", "/api/instalar", op, nil); c != 200 {
		t.Fatalf("instalar: %d", c)
	}
	v := b.esperarFin()
	if v.Fase != "error" || !strings.Contains(v.Error, "administrador") {
		t.Errorf("debe explicar el permiso: %+v", v)
	}
}

func TestPermisoDeAdministradorConcedido(t *testing.T) {
	b := nuevoBanco(t)
	op := Opciones{Modo: "av", Uso: "caja", Programa: `C:\Program Files\Compoint Punto`}
	b.llamar("POST", "/api/instalar", op, nil)
	v := b.esperarFin()
	if v.Fase != "terminado" || !v.Resumen.Elevado {
		t.Errorf("con permiso debe terminar: %+v", v)
	}
}

func TestErrorEnUnPaso(t *testing.T) {
	for _, paso := range []string{"carpetas", "copiar", "accesos", "config"} {
		t.Run(paso, func(t *testing.T) {
			t.Setenv("INSTALADOR_SIM_ERROR", paso)
			b := nuevoBanco(t)
			op := Opciones{Modo: "pred", Uso: "caja", Programa: b.s.sis.Defaults().Programa}
			b.llamar("POST", "/api/instalar", op, nil)
			v := b.esperarFin()
			if v.Fase != "error" || v.Error == "" {
				t.Fatalf("debe fallar: %+v", v)
			}
			hallado := false
			for _, p := range v.Pasos {
				if p.Clave == paso && p.Estado == "error" {
					hallado = true
				}
			}
			if !hallado {
				t.Errorf("el paso %s debe marcarse con error: %+v", paso, v.Pasos)
			}
			// se puede reintentar
			t.Setenv("INSTALADOR_SIM_ERROR", "")
			if c := b.llamar("POST", "/api/instalar", op, nil); c != 200 {
				t.Errorf("reintentar: %d", c)
			}
			if v := b.esperarFin(); v.Fase != "terminado" {
				t.Errorf("el reintento debe terminar: %+v", v)
			}
		})
	}
}

func TestNoSeCierraMientrasInstala(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_ESPERA", "200")
	b := nuevoBanco(t)
	t.Setenv("INSTALADOR_SIM_ESPERA", "200")
	op := Opciones{Modo: "pred", Uso: "caja", Programa: b.s.sis.Defaults().Programa}
	b.llamar("POST", "/api/instalar", op, nil)
	if c := b.llamar("POST", "/api/cerrar", nil, nil); c != 409 {
		t.Errorf("no debe cerrar mientras instala: %d", c)
	}
	if c := b.llamar("POST", "/api/instalar", op, nil); c != 409 {
		t.Errorf("no debe empezar otra instalación: %d", c)
	}
	b.esperarFin()
}

func TestSinPaqueteEnWindowsReal(t *testing.T) {
	b := nuevoBanco(t)
	b.s.simulado = false
	b.s.carga = nil
	var e Estado
	b.llamar("GET", "/api/estado?refrescar=1", nil, &e)
	if !e.SinPaquete {
		t.Errorf("debe avisar que falta el paquete: %+v", e)
	}
	op := Opciones{Modo: "pred", Uso: "caja", Programa: b.s.sis.Defaults().Programa}
	if c := b.llamar("POST", "/api/instalar", op, nil); c != 500 {
		t.Errorf("sin paquete no se instala: %d", c)
	}
}
