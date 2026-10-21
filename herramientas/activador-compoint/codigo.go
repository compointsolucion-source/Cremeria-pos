package main

// Códigos de activación CPT1 y solicitudes CPT-REQ.
//
// Este archivo hace EXACTAMENTE las mismas cuentas que backend/utils/licenciaCodigo.js y
// backend/utils/licenciaSolicitud.js. Si algo cambia allá, cambia aquí (las pruebas de
// codigo_test.go comparan contra los mismos códigos de ejemplo fijos).
//
// Código CPT1 (84 bytes en base32, grupos de 5 letras):
//   0 versión (1) · 1 tipo (1 prueba, 2 anual, 3 permanente) · 2 plan (1 sin nube, 2 con nube)
//   3 sucursales (1-255) · 4-5 emisión · 6-7 vencimiento (0xFFFF = no vence)
//   8-15 ID del equipo (60 bits) · 16-19 serie   + 64 bytes de firma Ed25519 sobre "CPT1\0"+contenido

import (
	"bytes"
	"compress/flate"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	prefijoCodigo  = "CPT1"
	alfabeto       = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford: sin I, L, O, U
	largoContenido = 20
	largoFirma     = 64
	largoTotal     = largoContenido + largoFirma // 84
	caracteresCod  = 135                         // ceil(84*8/5)
	sinVencimiento = 0xFFFF
)

var dominioFirma = []byte("CPT1\x00")
var diaCero = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

var tipoNum = map[string]byte{"demo": 1, "anual": 2, "permanente": 3}
var planNum = map[string]byte{"local": 1, "nube": 2}
var tipoTexto = map[byte]string{1: "demo", 2: "anual", 3: "permanente"}
var planTexto = map[byte]string{1: "local", 2: "nube"}

// DatosCodigo es lo que lleva un código de activación.
type DatosCodigo struct {
	Tipo          string `json:"tipo"`          // demo | anual | permanente
	Plan          string `json:"plan"`          // local | nube
	MaxSucursales int    `json:"maxSucursales"` // 1 a 255
	Emitida       string `json:"emitida"`       // AAAA-MM-DD
	Vence         string `json:"vence"`         // AAAA-MM-DD, vacío = no vence
	IDEquipo      uint64 `json:"idEquipo"`      // 60 bits
	Serie         uint32 `json:"serie"`
}

// ---------------------------------------------------------------- base32

func aBase32(b []byte) string {
	var sb strings.Builder
	bits, valor := 0, 0
	for _, x := range b {
		valor = (valor << 8) | int(x)
		bits += 8
		for bits >= 5 {
			sb.WriteByte(alfabeto[(valor>>(bits-5))&31])
			bits -= 5
		}
		valor &= (1 << bits) - 1
	}
	if bits > 0 {
		sb.WriteByte(alfabeto[(valor<<(5-bits))&31])
	}
	return sb.String()
}

// deBase32 devuelve los bytes y lo que sobró (que debe ser 0 en un código bien formado).
func deBase32(t string) (bytes []byte, sobrante int, ok bool) {
	bits, valor := 0, 0
	for i := 0; i < len(t); i++ {
		v := strings.IndexByte(alfabeto, t[i])
		if v < 0 {
			return nil, 0, false
		}
		valor = (valor << 5) | v
		bits += 5
		if bits >= 8 {
			bytes = append(bytes, byte((valor>>(bits-8))&255))
			bits -= 8
		}
		valor &= (1 << bits) - 1
	}
	return bytes, valor, true
}

// normalizar: lo que una persona confunde al copiar (O por 0, I y L por 1).
func normalizar(t string) string {
	t = strings.ToUpper(t)
	t = strings.ReplaceAll(t, "O", "0")
	t = strings.ReplaceAll(t, "I", "1")
	t = strings.ReplaceAll(t, "L", "1")
	return t
}

// ---------------------------------------------------------------- fechas

var reFecha = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

func fechaADias(iso string) (int, error) {
	m := reFecha.FindStringSubmatch(strings.TrimSpace(iso))
	if m == nil {
		return 0, fmt.Errorf("Fecha no válida: %s", iso)
	}
	var a, mes, d int
	fmt.Sscanf(m[1], "%d", &a)
	fmt.Sscanf(m[2], "%d", &mes)
	fmt.Sscanf(m[3], "%d", &d)
	f := time.Date(a, time.Month(mes), d, 0, 0, 0, 0, time.UTC)
	// time.Date acepta 31 de febrero y lo corrige: aquí no se permite.
	if f.Year() != a || int(f.Month()) != mes || f.Day() != d {
		return 0, fmt.Errorf("Fecha no válida: %s", iso)
	}
	return int(f.Sub(diaCero).Hours() / 24), nil
}

func diasAFecha(dias int) string {
	return diaCero.AddDate(0, 0, dias).Format("2006-01-02")
}

// ---------------------------------------------------------------- ID del equipo

// leerIDEquipo lee un ID escrito por una persona («7kq2 9xma-4tpl»).
func leerIDEquipo(texto string) (uint64, bool) {
	limpio := strings.NewReplacer(" ", "", "-", "", "\t", "", "\n", "", "\r", "").Replace(texto)
	limpio = normalizar(limpio)
	if len(limpio) != 12 {
		return 0, false
	}
	var v uint64
	for i := 0; i < len(limpio); i++ {
		k := strings.IndexByte(alfabeto, limpio[i])
		if k < 0 {
			return 0, false
		}
		v = v*32 + uint64(k)
	}
	return v, true
}

func formatearIDEquipo(v uint64) string {
	var t [12]byte
	for i := 0; i < 12; i++ {
		t[i] = alfabeto[(v>>(5*uint(11-i)))&31]
	}
	return string(t[0:4]) + "-" + string(t[4:8]) + "-" + string(t[8:12])
}

// ---------------------------------------------------------------- emitir

func armarContenido(d DatosCodigo) ([]byte, error) {
	tipo, ok := tipoNum[d.Tipo]
	if !ok {
		return nil, fmt.Errorf("Tipo no válido: %s", d.Tipo)
	}
	plan, ok := planNum[d.Plan]
	if !ok {
		return nil, fmt.Errorf("Plan no válido: %s", d.Plan)
	}
	if d.MaxSucursales < 1 || d.MaxSucursales > 255 {
		return nil, errors.New("Sucursales: de 1 a 255")
	}
	emitida, err := fechaADias(d.Emitida)
	if err != nil {
		return nil, err
	}
	vence := sinVencimiento
	if d.Vence != "" {
		if vence, err = fechaADias(d.Vence); err != nil {
			return nil, err
		}
	}
	if emitida < 0 || emitida > 0xFFFE {
		return nil, errors.New("Fecha de emisión fuera de rango")
	}
	if vence != sinVencimiento && (vence < 0 || vence > 0xFFFE) {
		return nil, errors.New("Fecha de vencimiento fuera de rango")
	}
	if d.Tipo == "permanente" && vence != sinVencimiento {
		return nil, errors.New("Un código permanente no lleva vencimiento")
	}
	if d.Tipo != "permanente" && vence == sinVencimiento {
		return nil, errors.New("Este tipo de código necesita fecha de vencimiento")
	}
	if d.IDEquipo == 0 || d.IDEquipo >= 1<<60 {
		return nil, errors.New("El ID del equipo no es válido")
	}
	b := make([]byte, largoContenido)
	b[0], b[1], b[2], b[3] = 1, tipo, plan, byte(d.MaxSucursales)
	binary.BigEndian.PutUint16(b[4:], uint16(emitida))
	binary.BigEndian.PutUint16(b[6:], uint16(vence))
	binary.BigEndian.PutUint64(b[8:], d.IDEquipo)
	binary.BigEndian.PutUint32(b[16:], d.Serie)
	return b, nil
}

func agrupar(t string) string {
	var partes []string
	for len(t) > 5 {
		partes = append(partes, t[:5])
		t = t[5:]
	}
	partes = append(partes, t)
	return strings.Join(partes, "-")
}

// emitirCodigo firma un código con la llave privada. Antes de devolverlo lo vuelve a
// comprobar con la llave pública: si algo salió mal, no entrega un código dañado.
func emitirCodigo(d DatosCodigo, priv ed25519.PrivateKey) (string, error) {
	contenido, err := armarContenido(d)
	if err != nil {
		return "", err
	}
	firma := ed25519.Sign(priv, append(append([]byte{}, dominioFirma...), contenido...))
	if len(firma) != largoFirma {
		return "", errors.New("La firma no mide lo esperado")
	}
	codigo := prefijoCodigo + "-" + agrupar(aBase32(append(append([]byte{}, contenido...), firma...)))
	if _, err := verificarCodigo(codigo, priv.Public().(ed25519.PublicKey)); err != nil {
		return "", errors.New("El código recién creado no pasó la comprobación: " + err.Error())
	}
	return codigo, nil
}

// ---------------------------------------------------------------- comprobar

var reInicio = regexp.MustCompile(`CPT[1IL]-`)

func extraerCaracteres(texto string) (string, error) {
	t := strings.ToUpper(texto)
	loc := reInicio.FindStringIndex(t)
	if loc == nil {
		return "", errors.New("prefijo")
	}
	var sb strings.Builder
	for k := loc[1]; k < len(t) && sb.Len() < caracteresCod; k++ {
		c := t[k]
		if c == '-' || c == ' ' || c == '\n' || c == '\r' || c == '\t' {
			continue
		}
		n := normalizar(string(c))
		if strings.IndexByte(alfabeto, n[0]) < 0 {
			break
		}
		sb.WriteByte(n[0])
	}
	if sb.Len() < caracteresCod {
		return "", errors.New("incompleto")
	}
	return sb.String(), nil
}

// verificarCodigo comprueba la firma y devuelve lo que dice el código.
func verificarCodigo(texto string, pub ed25519.PublicKey) (DatosCodigo, error) {
	var vacio DatosCodigo
	ex, err := extraerCaracteres(texto)
	if err != nil {
		return vacio, err
	}
	bytesCod, sobrante, ok := deBase32(ex)
	if !ok || len(bytesCod) < largoTotal || sobrante != 0 {
		return vacio, errors.New("formato")
	}
	bytesCod = bytesCod[:largoTotal]
	contenido, firma := bytesCod[:largoContenido], bytesCod[largoContenido:]
	if !ed25519.Verify(pub, append(append([]byte{}, dominioFirma...), contenido...), firma) {
		return vacio, errors.New("firma")
	}
	if contenido[0] != 1 {
		return vacio, errors.New("version")
	}
	tipo, plan := tipoTexto[contenido[1]], planTexto[contenido[2]]
	if tipo == "" || plan == "" || contenido[3] < 1 {
		return vacio, errors.New("formato")
	}
	d := DatosCodigo{Tipo: tipo, Plan: plan, MaxSucursales: int(contenido[3]),
		Emitida:  diasAFecha(int(binary.BigEndian.Uint16(contenido[4:]))),
		IDEquipo: binary.BigEndian.Uint64(contenido[8:]), Serie: binary.BigEndian.Uint32(contenido[16:])}
	if v := binary.BigEndian.Uint16(contenido[6:]); v != sinVencimiento {
		d.Vence = diasAFecha(int(v))
	}
	return d, nil
}

// ---------------------------------------------------------------- llaves

func publicaHex(pub ed25519.PublicKey) string { return hex.EncodeToString(pub) }

// ---------------------------------------------------------------- solicitud CPT-REQ

const prefijoSolicitud = "CPT-REQ-"

// Solicitud es lo que manda el cliente (Licencia → Quiero contratar).
type Solicitud struct {
	V          int            `json:"v"`
	Tipo       string         `json:"tipo"` // contratar | renovar
	Plan       string         `json:"plan"`
	Sucursales int            `json:"sucursales"`
	IDEquipo   string         `json:"id_equipo"`
	Fecha      string         `json:"fecha"`
	App        string         `json:"app"`
	PruebaDias *int           `json:"prueba_dias_restantes"`
	Negocio    map[string]any `json:"negocio"`
	Nota       string         `json:"nota"`
}

var reSolicitud = regexp.MustCompile(`^((?:[A-Za-z0-9_\-]\s*)+)\.\s*([0-9A-Fa-f]\s*[0-9A-Fa-f]\s*[0-9A-Fa-f]\s*[0-9A-Fa-f])`)

func controlSolicitud(cuerpo string) string {
	h := sha256.Sum256([]byte("cpt-req|" + cuerpo))
	return strings.ToUpper(hex.EncodeToString(h[:])[:4])
}

// leerSolicitud lee un CPT-REQ (tolera texto alrededor, saltos de línea y espacios).
// El mensaje de error ya viene listo para mostrarse.
func leerSolicitud(texto string) (*Solicitud, error) {
	i := strings.Index(texto, prefijoSolicitud)
	if i < 0 {
		return nil, errors.New("No encontré un código de solicitud (empieza con CPT-REQ-).")
	}
	m := reSolicitud.FindStringSubmatch(texto[i+len(prefijoSolicitud):])
	if m == nil {
		return nil, errors.New("El código de solicitud está incompleto o cortado.")
	}
	cuerpo := strings.Join(strings.Fields(m[1]), "")
	ck := strings.ToUpper(strings.Join(strings.Fields(m[2]), ""))
	if ck != controlSolicitud(cuerpo) {
		return nil, errors.New("El código de solicitud llegó dañado (revisa que se copió completo).")
	}
	crudo, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(cuerpo, "="))
	if err != nil {
		return nil, errors.New("No se pudo leer el código de solicitud.")
	}
	lector := flate.NewReader(bytes.NewReader(crudo))
	defer lector.Close()
	plano, err := io.ReadAll(io.LimitReader(lector, 20000))
	if err != nil {
		return nil, errors.New("No se pudo leer el código de solicitud.")
	}
	var s Solicitud
	if err := json.Unmarshal(plano, &s); err != nil {
		return nil, errors.New("No se pudo leer el código de solicitud.")
	}
	if s.V != 1 {
		return nil, errors.New("Este código de solicitud es de una versión que no conozco.")
	}
	return &s, nil
}

// textosNegocio devuelve los datos del negocio como texto limpio (sin saltos de línea, máx. 200).
func (s *Solicitud) textosNegocio() map[string]string {
	salida := map[string]string{}
	for k, v := range s.Negocio {
		t := strings.Join(strings.Fields(fmt.Sprint(v)), " ")
		if r := []rune(t); len(r) > 200 {
			t = string(r[:200])
		}
		if t != "" && t != "<nil>" {
			salida[k] = t
		}
	}
	return salida
}
