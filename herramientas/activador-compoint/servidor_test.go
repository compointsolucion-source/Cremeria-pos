package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Solicitud REAL armada por backend/utils/licenciaSolicitud.js (renovar, nube, 2 sucursales, ID 8MM7-DE86-3CX7).
const solicitudNode = "CPT-REQ-VZDBTsJAEIZfZfOft6TbKjR7UpGQGImRkzcytENZ03brbhcNhEfy5CPwYmYlhHib5J9_vnxzwA5aSQymt9Bw3NkdOUj0DXXQ6MKaIeFDGZynhj10JmGqFX-Ec6VYLCbJ46wYJ_n0bQKJDZdbgkaWZuNEpUmWQqLj2pbGQh-uI6aOW3anbxLPJGa-Z0fdniBRG_cvjwdsu3a8qgJ3MVpaT2J--ml5D4nPLQ2e-h4aeS5Ult-I2_GkgAS3ZJooZj3dNcQXyKj9gkRpQkUVNOaBKmronVxksR-oipQnaowvLSTcpoxrL4tlkaYqVfcPCkeJM1ON1OhP0g5R_DUYdlZQ7bgmJ-zgSFweiOMv.253A"

type banco struct {
	t   *testing.T
	s   *servidor
	ts  *httptest.Server
	dir string
}

func nuevoBanco(t *testing.T, dir string) *banco {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	s := &servidor{dir: dir, token: "tok", ahora: func() time.Time { return time.Date(2026, 10, 20, 20, 0, 0, 0, time.Local) }, elegir: func(string) (string, error) { return "", nil }}
	s.inicio = time.Now()
	ts := httptest.NewServer(s.rutas())
	s.addr = ts.Listener.Addr().String()
	t.Cleanup(ts.Close)
	return &banco{t: t, s: s, ts: ts, dir: dir}
}

func (b *banco) llamar(metodo, ruta string, cuerpo interface{}, token string) (int, map[string]interface{}) {
	b.t.Helper()
	var rd io.Reader
	if cuerpo != nil {
		j, _ := json.Marshal(cuerpo)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(metodo, b.ts.URL+ruta, rd)
	if token != "" {
		req.Header.Set("X-Token", token)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer r.Body.Close()
	var m map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&m)
	return r.StatusCode, m
}
func (b *banco) get(ruta string) (int, map[string]interface{}) {
	return b.llamar("GET", ruta, nil, "tok")
}
func (b *banco) post(ruta string, c interface{}) (int, map[string]interface{}) {
	return b.llamar("POST", ruta, c, "tok")
}

func (b *banco) crearYAbrir() {
	b.t.Helper()
	if c, m := b.post("/api/crear-llave", map[string]string{"clave": "contraseña-segura"}); c != 200 {
		b.t.Fatalf("crear llave: %d %v", c, m)
	}
}

func pubDe(b *banco) ed25519.PublicKey {
	_, m := b.get("/api/estado")
	h, _ := hex.DecodeString(m["llavePublica"].(string))
	return ed25519.PublicKey(h)
}

func pedido(extra map[string]interface{}) map[string]interface{} {
	p := map[string]interface{}{"negocio": "Cremería La Esperanza", "contacto": "Rosa Gómez", "whatsapp": "33 1234 5678",
		"idEquipo": "8MM7-DE86-3CX7", "tipo": "anual", "plan": "nube", "sucursales": 2, "vence": "2027-10-20"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func TestPBKDF2ConVectoresConocidos(t *testing.T) {
	casos := []struct {
		iter int
		esp  string
	}{
		{1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
		{4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
	}
	for _, c := range casos {
		if got := hex.EncodeToString(pbkdf2SHA256([]byte("password"), []byte("salt"), c.iter, 32)); got != c.esp {
			t.Errorf("iter %d: %s", c.iter, got)
		}
	}
}

func TestSinTokenOHostIncorrectoNoPasa(t *testing.T) {
	b := nuevoBanco(t, "")
	if c, _ := b.llamar("GET", "/api/estado", nil, ""); c != 403 {
		t.Errorf("sin token: %d", c)
	}
	if c, _ := b.llamar("GET", "/api/estado", nil, "otro"); c != 403 {
		t.Errorf("token malo: %d", c)
	}
	req, _ := http.NewRequest("GET", b.ts.URL+"/api/estado", nil)
	req.Host = "evil.example.com"
	req.Header.Set("X-Token", "tok")
	r, _ := http.DefaultClient.Do(req)
	if r.StatusCode != 403 {
		t.Errorf("host malo: %d", r.StatusCode)
	}
	// la pantalla tampoco se entrega sin la clave
	r2, _ := http.Get(b.ts.URL + "/")
	if r2.StatusCode != 403 {
		t.Errorf("pantalla sin clave: %d", r2.StatusCode)
	}
	r3, _ := http.Get(b.ts.URL + "/?t=tok")
	cuerpo, _ := io.ReadAll(r3.Body)
	if r3.StatusCode != 200 || !strings.Contains(string(cuerpo), "const TOKEN = 'tok'") {
		t.Errorf("pantalla con clave: %d", r3.StatusCode)
	}
}

func TestSinContrasenaNoSeVeNiSeEmiteNada(t *testing.T) {
	b := nuevoBanco(t, "")
	if _, m := b.get("/api/estado"); m["fase"] != "crear" {
		t.Fatalf("fase: %v", m["fase"])
	}
	for _, r := range []string{"/api/clientes", "/api/historial"} {
		if c, _ := b.get(r); c != 401 {
			t.Errorf("%s: %d", r, c)
		}
	}
	if c, _ := b.post("/api/generar", pedido(nil)); c != 401 {
		t.Errorf("generar: %d", c)
	}
	if c, m := b.post("/api/crear-llave", map[string]string{"clave": "corta"}); c != 400 || !strings.Contains(m["error"].(string), "8 caracteres") {
		t.Errorf("contraseña corta: %d %v", c, m)
	}
}

func TestFlujoCompletoCrearEmitirRenovarYPersistir(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	if c, _ := b.post("/api/crear-llave", map[string]string{"clave": "otra-contraseña"}); c != 400 {
		t.Error("dejó crear una segunda llave encima de la primera")
	}
	pub := pubDe(b)

	c, m := b.post("/api/generar", pedido(nil))
	if c != 200 {
		t.Fatalf("generar: %d %v", c, m)
	}
	cod1 := m["codigo"].(string)
	if m["serie"].(float64) != 1 {
		t.Errorf("serie: %v", m["serie"])
	}
	d, err := verificarCodigo(cod1, pub)
	if err != nil || d.Tipo != "anual" || d.Plan != "nube" || d.MaxSucursales != 2 || d.Emitida != "2026-10-20" || d.Vence != "2027-10-20" || d.Serie != 1 || formatearIDEquipo(d.IDEquipo) != "8MM7-DE86-3CX7" {
		t.Fatalf("código mal: %+v %v", d, err)
	}

	// renovar al mismo equipo (escrito distinto) = mismo cliente, serie 2
	c, m = b.post("/api/generar", pedido(map[string]interface{}{"idEquipo": "8mm7 de86 3cx7", "vence": "2028-10-20", "sucursales": 3}))
	if c != 200 || m["serie"].(float64) != 2 {
		t.Fatalf("renovar: %d %v", c, m)
	}
	_, lc := b.get("/api/clientes")
	clientes := lc["clientes"].([]interface{})
	if len(clientes) != 1 {
		t.Fatalf("clientes: %d", len(clientes))
	}
	cl := clientes[0].(map[string]interface{})
	if cl["vence"] != "2028-10-20" || cl["sucursales"].(float64) != 3 || cl["ultimaSerie"].(float64) != 2 {
		t.Errorf("cliente no se actualizó: %v", cl)
	}

	// un equipo distinto = cliente nuevo; permanente ignora la fecha
	c, m = b.post("/api/generar", pedido(map[string]interface{}{"negocio": "Abarrotes Doña Lupe", "idEquipo": "7KQ2-9XMA-4TPL", "tipo": "permanente", "plan": "local", "sucursales": 1, "vence": "2030-01-01"}))
	if c != 200 {
		t.Fatalf("permanente: %d %v", c, m)
	}
	dp, _ := verificarCodigo(m["codigo"].(string), pub)
	if dp.Tipo != "permanente" || dp.Vence != "" || dp.Serie != 3 {
		t.Errorf("permanente: %+v", dp)
	}

	_, h := b.get("/api/historial")
	cods := h["codigos"].([]interface{})
	if len(cods) != 3 || cods[0].(map[string]interface{})["serie"].(float64) != 3 {
		t.Errorf("historial: %v", cods)
	}

	// se cierra y se vuelve a abrir: todo sigue y la serie continúa
	b2 := nuevoBanco(t, b.dir)
	if _, e := b2.get("/api/estado"); e["fase"] != "bloqueado" {
		t.Fatalf("fase: %v", e["fase"])
	}
	if c, m := b2.post("/api/abrir", map[string]string{"clave": "equivocada-123"}); c != 400 || !strings.Contains(m["error"].(string), "contraseña no es correcta") {
		t.Errorf("contraseña mala: %d %v", c, m)
	}
	if c, _ := b2.get("/api/clientes"); c != 401 {
		t.Errorf("con contraseña mala dejó ver clientes: %d", c)
	}
	if c, m := b2.post("/api/abrir", map[string]string{"clave": "contraseña-segura"}); c != 200 {
		t.Fatalf("abrir: %d %v", c, m)
	}
	_, lc = b2.get("/api/clientes")
	if len(lc["clientes"].([]interface{})) != 2 {
		t.Errorf("clientes tras reabrir: %v", lc["clientes"])
	}
	if !pubDe(b2).Equal(pub) {
		t.Error("la llave pública cambió al reabrir")
	}
	c, m = b2.post("/api/generar", pedido(map[string]interface{}{"negocio": "Otro", "idEquipo": "2BXM-0CV9-TT6H"}))
	if c != 200 || m["serie"].(float64) != 4 {
		t.Errorf("serie tras reabrir: %d %v", c, m)
	}
}

func TestLaLlaveNoQuedaEnClaroEnElDisco(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	b.s.mu.Lock()
	semilla := b.s.priv.Seed()
	b.s.mu.Unlock()
	for _, f := range []string{"llave.cptkey", "datos.json"} {
		contenido, err := os.ReadFile(filepath.Join(b.dir, f))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(contenido, semilla) || strings.Contains(string(contenido), hex.EncodeToString(semilla)) {
			t.Errorf("%s contiene la llave privada en claro", f)
		}
		if strings.Contains(string(contenido), "contraseña-segura") {
			t.Errorf("%s contiene la contraseña", f)
		}
	}
}

func TestValidacionesAlGenerar(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	malos := map[string]map[string]interface{}{
		"nombre":               {"negocio": "  "},
		"ID del":               {"idEquipo": "7KQ2-9XMA"},
		"tipo":                 {"tipo": "gratis"},
		"plan":                 {"plan": "x"},
		"sucursales":           {"sucursales": 0},
		"pasó":                 {"vence": "2026-10-19"},
		"no es válida":         {"vence": "2027-02-31"},
		"fecha de vencimiento": {"vence": ""},
	}
	for esperado, extra := range malos {
		c, m := b.post("/api/generar", pedido(extra))
		if c != 400 || !strings.Contains(m["error"].(string), esperado) {
			t.Errorf("%s: %d %v", esperado, c, m)
		}
	}
	// hoy mismo sí se puede (vence = emisión)
	if c, m := b.post("/api/generar", pedido(map[string]interface{}{"vence": "2026-10-20"})); c != 200 {
		t.Errorf("vence hoy: %d %v", c, m)
	}
	// ID de otro cliente: no se puede pasar un cliente a un equipo que ya es de otro
	b.post("/api/generar", pedido(map[string]interface{}{"negocio": "Otro", "idEquipo": "7KQ2-9XMA-4TPL"}))
	_, lc := b.get("/api/clientes")
	var idOtro float64
	for _, x := range lc["clientes"].([]interface{}) {
		if x.(map[string]interface{})["negocio"] == "Otro" {
			idOtro = x.(map[string]interface{})["id"].(float64)
		}
	}
	c, m := b.post("/api/generar", pedido(map[string]interface{}{"clienteId": idOtro}))
	if c != 400 || !strings.Contains(m["error"].(string), "ya pertenece a otro cliente") {
		t.Errorf("choque de ID: %d %v", c, m)
	}
	// los errores no consumen número de serie
	_, e := b.get("/api/estado")
	if e["siguienteSerie"].(float64) != 3 {
		t.Errorf("siguienteSerie: %v", e["siguienteSerie"])
	}
}

func TestLeerSolicitudHechaPorElSistema(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	c, m := b.post("/api/leer-solicitud", map[string]string{"texto": "Hola Compoint, quiero renovar.\n" + solicitudNode + "\nGracias"})
	if c != 200 || m["ok"] != true {
		t.Fatalf("leer: %d %v", c, m)
	}
	d := m["datos"].(map[string]interface{})
	n := d["negocio"].(map[string]interface{})
	if d["tipo"] != "renovar" || d["plan"] != "nube" || d["sucursales"].(float64) != 2 || d["id_equipo"] != "8MM7-DE86-3CX7" || n["negocio"] != "Cremería La Esperanza" || n["rfc"] != "GOMR800101AB1" || d["nota"] != "Quiero agregar otra sucursal" {
		t.Errorf("datos mal leídos: %v", d)
	}
	if m["clienteId"].(float64) != 0 {
		t.Errorf("no debería conocerlo todavía: %v", m["clienteId"])
	}
	// al emitir con la solicitud, queda guardado lo que mandó (giro, ciudad, factura…)
	c, g := b.post("/api/generar", pedido(map[string]interface{}{"solicitud": solicitudNode}))
	if c != 200 {
		t.Fatalf("generar: %d %v", c, g)
	}
	_, lc := b.get("/api/clientes")
	extra := lc["clientes"].([]interface{})[0].(map[string]interface{})["datosNegocio"].(map[string]interface{})
	if extra["ciudad"] != "Guadalajara" || extra["rfc"] != "GOMR800101AB1" {
		t.Errorf("datosNegocio: %v", extra)
	}
	// ahora sí lo reconoce como cliente existente
	_, m = b.post("/api/leer-solicitud", map[string]string{"texto": solicitudNode})
	if m["clienteId"].(float64) != 1 {
		t.Errorf("clienteId: %v", m["clienteId"])
	}
	// cortada o dañada
	c, m = b.post("/api/leer-solicitud", map[string]string{"texto": solicitudNode[:len(solicitudNode)-30]})
	if m["ok"] != false || m["mensaje"] == "" {
		t.Errorf("cortada: %v", m)
	}
	alterada := strings.Replace(solicitudNode, "DBTsJ", "DBTsK", 1)
	_, m = b.post("/api/leer-solicitud", map[string]string{"texto": alterada})
	if m["ok"] != false || !strings.Contains(m["mensaje"].(string), "dañado") {
		t.Errorf("alterada: %v", m)
	}
	_, m = b.post("/api/leer-solicitud", map[string]string{"texto": "hola"})
	if m["ok"] != false || !strings.Contains(m["mensaje"].(string), "CPT-REQ") {
		t.Errorf("sin código: %v", m)
	}
}

func TestRespaldoYRestauracion(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	pub := pubDe(b)
	b.post("/api/generar", pedido(nil))
	usb, otro := t.TempDir(), t.TempDir()

	// elegir carpeta que no existe
	if c, _ := b.post("/api/respaldo", map[string]string{"carpeta": filepath.Join(usb, "no-existe")}); c != 400 {
		t.Errorf("carpeta inexistente: %d", c)
	}
	c, m := b.post("/api/respaldo", map[string]string{"carpeta": usb})
	if c != 200 || m["nuevo"] != true {
		t.Fatalf("respaldo 1: %d %v", c, m)
	}
	archivo := m["ruta"].(string)
	if !strings.HasSuffix(archivo, "Respaldo-Activador-Compoint-2026-10-20.cptbak") {
		t.Errorf("nombre: %s", archivo)
	}
	// el mismo lugar otra vez no cuenta como segundo respaldo
	_, m = b.post("/api/respaldo", map[string]string{"carpeta": usb})
	if m["nuevo"] != false {
		t.Errorf("mismo lugar: %v", m)
	}
	_, e := b.get("/api/estado")
	if e["respaldos"].(map[string]interface{})["hechos"].(float64) != 1 {
		t.Errorf("hechos: %v", e["respaldos"])
	}
	b.post("/api/respaldo", map[string]string{"carpeta": otro})
	b.post("/api/generar", pedido(map[string]interface{}{"idEquipo": "7KQ2-9XMA-4TPL", "negocio": "Segundo"}))
	_, e = b.get("/api/estado")
	r := e["respaldos"].(map[string]interface{})
	if r["hechos"].(float64) != 2 || r["nuevosDesde"].(float64) != 1 {
		t.Errorf("respaldos: %v", r)
	}

	// el respaldo no deja ver la llave en claro
	crudo, _ := os.ReadFile(archivo)
	b.s.mu.Lock()
	semilla := b.s.priv.Seed()
	b.s.mu.Unlock()
	if bytes.Contains(crudo, semilla) || strings.Contains(string(crudo), "Esperanza") {
		t.Error("el respaldo trae datos en claro")
	}

	// computadora nueva: restaurar
	nuevo := nuevoBanco(t, "")
	texto := string(crudo)
	if c, m := nuevo.post("/api/restaurar", map[string]interface{}{"archivo": texto, "clave": "contraseña-mala"}); c != 400 || !strings.Contains(m["error"].(string), "contraseña no es correcta") {
		t.Errorf("clave mala: %d %v", c, m)
	}
	if c, _ := nuevo.post("/api/restaurar", map[string]interface{}{"archivo": "esto no es un respaldo", "clave": "x"}); c != 400 {
		t.Errorf("archivo raro: %d", c)
	}
	if c, m := nuevo.post("/api/restaurar", map[string]interface{}{"archivo": texto, "clave": "contraseña-segura"}); c != 200 {
		t.Fatalf("restaurar: %d %v", c, m)
	}
	if !pubDe(nuevo).Equal(pub) {
		t.Error("la llave restaurada no es la misma")
	}
	_, lc := nuevo.get("/api/clientes")
	if len(lc["clientes"].([]interface{})) != 1 { // el respaldo se hizo cuando solo había 1 cliente
		t.Errorf("clientes restaurados: %v", lc["clientes"])
	}
	// y la llave restaurada firma códigos que la pública original acepta
	_, g := nuevo.post("/api/generar", pedido(map[string]interface{}{"idEquipo": "2BXM-0CV9-TT6H", "negocio": "Nuevo"}))
	if _, err := verificarCodigo(g["codigo"].(string), pub); err != nil {
		t.Errorf("el código de la llave restaurada no pasa con la pública original: %v", err)
	}
	// reabre con la contraseña en la computadora nueva
	otra := nuevoBanco(t, nuevo.dir)
	if c, _ := otra.post("/api/abrir", map[string]string{"clave": "contraseña-segura"}); c != 200 {
		t.Error("no abre tras restaurar")
	}

	// restaurar encima de una llave que ya existe pide confirmación y conserva lo anterior
	c, m = nuevo.post("/api/restaurar", map[string]interface{}{"archivo": texto, "clave": "contraseña-segura"})
	if c != 409 || m["confirmar"] != true {
		t.Errorf("sin confirmar: %d %v", c, m)
	}
	if c, _ := nuevo.post("/api/restaurar", map[string]interface{}{"archivo": texto, "clave": "contraseña-segura", "confirmar": true}); c != 200 {
		t.Errorf("confirmado: %d", c)
	}
	antes, _ := filepath.Glob(filepath.Join(nuevo.dir, "llave.cptkey.antes-*"))
	if len(antes) != 1 {
		t.Errorf("no conservó la llave anterior: %v", antes)
	}
}

func TestArchivoDeDatosDanadoUsaLaCopia(t *testing.T) {
	b := nuevoBanco(t, "")
	b.crearYAbrir()
	b.post("/api/generar", pedido(nil))
	b.post("/api/generar", pedido(map[string]interface{}{"idEquipo": "7KQ2-9XMA-4TPL", "negocio": "Segundo"}))
	if err := os.WriteFile(filepath.Join(b.dir, "datos.json"), []byte("{ roto"), 0o600); err != nil {
		t.Fatal(err)
	}
	b2 := nuevoBanco(t, b.dir)
	if c, m := b2.post("/api/abrir", map[string]string{"clave": "contraseña-segura"}); c != 200 {
		t.Fatalf("abrir con datos rotos: %d %v", c, m)
	}
	_, lc := b2.get("/api/clientes")
	if n := len(lc["clientes"].([]interface{})); n != 1 { // la .bak es la versión anterior al último guardado
		t.Errorf("clientes desde la copia: %d", n)
	}
}
