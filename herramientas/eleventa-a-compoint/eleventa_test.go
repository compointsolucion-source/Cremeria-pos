package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------- utilidades de prueba

func normalizar(v any) any {
	switch x := v.(type) {
	case nil:
		return ""
	case float64:
		return math.Round(x*1e6) / 1e6
	case int:
		return float64(x)
	}
	return v
}

func ordenar(filas [][]any) []string {
	out := make([]string, len(filas))
	for i, f := range filas {
		g := make([]any, len(f))
		for j, v := range f {
			g[j] = normalizar(v)
		}
		b, _ := json.Marshal(g)
		out[i] = string(b)
	}
	sort.Strings(out)
	return out
}

type esperado struct {
	Productos [][]any `json:"productos"`
	Clientes  [][]any `json:"clientes"`
}

func leerEsperado(t *testing.T, ruta string) esperado {
	b, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	var e esperado
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return e
}

// leerXLSX lee de vuelta la primera hoja de un .xlsx escrito por nosotros.
func leerXLSX(t *testing.T, ruta string) (encabezados []string, filas [][]any) {
	z, err := zip.OpenReader(ruta)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	var data []byte
	for _, f := range z.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			data, _ = io.ReadAll(r)
			r.Close()
		}
	}
	if data == nil {
		t.Fatal("no hay hoja 1")
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	var fila []any
	var col int
	var esTexto bool
	var texto strings.Builder
	var enV, enT bool
	var estilo string
	filaNum := 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("XML mal formado: %v", err)
		}
		switch x := tok.(type) {
		case xml.StartElement:
			switch x.Name.Local {
			case "row":
				fila = nil
				filaNum++
			case "c":
				esTexto = false
				estilo = ""
				ref := ""
				for _, a := range x.Attr {
					if a.Name.Local == "t" && a.Value == "inlineStr" {
						esTexto = true
					}
					if a.Name.Local == "r" {
						ref = a.Value
					}
					if a.Name.Local == "s" {
						estilo = a.Value
					}
				}
				_ = estilo
				// columna a partir de la referencia (A, B, ...)
				col = 0
				for _, c := range ref {
					if c >= 'A' && c <= 'Z' {
						col = col*26 + int(c-'A') + 1
					}
				}
				col--
				for len(fila) < col {
					fila = append(fila, nil)
				}
				texto.Reset()
			case "v":
				enV = true
			case "t":
				enT = true
			}
		case xml.CharData:
			if enV || enT {
				texto.Write(x)
			}
		case xml.EndElement:
			switch x.Name.Local {
			case "v":
				enV = false
			case "t":
				enT = false
			case "c":
				if esTexto {
					fila = append(fila, texto.String())
				} else {
					n, _ := strconv.ParseFloat(texto.String(), 64)
					fila = append(fila, n)
				}
			case "row":
				if filaNum == 1 {
					for _, v := range fila {
						encabezados = append(encabezados, v.(string))
					}
				} else {
					filas = append(filas, fila)
				}
			}
		}
	}
	return
}

// ---------------------------------------------------------------- pruebas pequeñas

func TestDescomprimir(t *testing.T) {
	// 3 bytes literales, 3 veces la 'x', 128 ceros (el -128 es un caso límite), 1 literal
	in := []byte{3, 'a', 'b', 'c', 0xFD, 'x', 0x80, 0, 1, 'z'}
	esperado := append([]byte("abcxxx"), append(make([]byte, 128), 'z')...)
	if got := descomprimir(in); !bytes.Equal(got, esperado) {
		t.Fatalf("descomprimir: %v", got)
	}
}

func TestAplicarDiferencias(t *testing.T) {
	base := []byte("0123456789")
	// conserva 2, cambia 3 bytes por "ABC", conserva 5
	cinta := []byte{0xFE, 3, 'A', 'B', 'C', 0xFB}
	if got := string(aplicarDiferencias(base, cinta)); got != "01ABC56789" {
		t.Fatalf("diferencias: %q", got)
	}
}

func TestCP1252(t *testing.T) {
	got := decodificarCP1252("a\xf1o \x80 \x93x\x94 \xe9")
	if got != "año € “x” é" {
		t.Fatalf("cp1252: %q", got)
	}
	if (texto{"\xc3\xb1", 4}).String() != "ñ" { // columna declarada UTF8
		t.Fatal("utf8")
	}
}

func TestNumeroComoPython(t *testing.T) {
	casos := []struct {
		v    any
		n    int
		want float64
	}{
		{2.675, 2, 2.67},          // round(2.675, 2) de Python da 2.67
		{0.125, 2, 0.12},          // mitad al par
		{dec{12345, -4}, 2, 1.23}, // 1.2345 -> 1.23
		{dec{-5, -4}, 2, 0},       // -0.0005 -> 0 (no "-0")
		{int64(7), 2, 7},
		{nil, 2, 0},
		{1234.5678, 3, 1234.568},
	}
	for _, c := range casos {
		if got := numero(c.v, c.n); got != c.want || math.Signbit(got) {
			t.Errorf("numero(%v,%d) = %v, quería %v", c.v, c.n, got, c.want)
		}
	}
	if (dec{-5, -4}).String() != "-0.0005" || (dec{12345, -2}).String() != "123.45" || (dec{7, 0}).String() != "7" {
		t.Error("dec.String")
	}
}

func TestXLSXRoundTrip(t *testing.T) {
	tb := tablaExcel{
		Hoja: "Hoja <1>", Encabezados: []string{"Uno", "Dos", "Tres"}, Anchos: []float64{10, 20, 30},
		Estilos: []int{estiloTexto, 0, estiloDinero},
		Filas: [][]any{
			{"0012", "a & b <c> \"d\"", 12.5},
			{"", "con\x01control y ñandú €", nil},
			{"x", "  espacios  ", 0.0},
		},
	}
	ruta := filepath.Join(t.TempDir(), "p.xlsx")
	if err := escribirXLSX(ruta, tb); err != nil {
		t.Fatal(err)
	}
	enc, filas := leerXLSX(t, ruta)
	if strings.Join(enc, ",") != "Uno,Dos,Tres" || len(filas) != 3 {
		t.Fatalf("encabezados %v filas %d", enc, len(filas))
	}
	if filas[0][0] != "0012" || filas[0][1] != `a & b <c> "d"` || filas[0][2] != 12.5 {
		t.Errorf("fila 1: %v", filas[0])
	}
	if filas[1][1] != "concontrol y ñandú €" {
		t.Errorf("fila 2: %q", filas[1][1])
	}
	if filas[2][1] != "  espacios  " {
		t.Errorf("fila 3: %q", filas[2][1])
	}
	if letrasColumna(0) != "A" || letrasColumna(25) != "Z" || letrasColumna(26) != "AA" || letrasColumna(701) != "ZZ" || letrasColumna(702) != "AAA" {
		t.Error("letrasColumna")
	}
}

// ---------------------------------------------------------------- bases de prueba (hechas con Firebird real)

func comparar(t *testing.T, nombre string, got [][]any, want [][]any) {
	a, b := ordenar(got), ordenar(want)
	if len(a) != len(b) {
		t.Fatalf("%s: %d filas, el motor real da %d", nombre, len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("%s: fila distinta\n  lector: %s\n  motor:  %s", nombre, a[i], b[i])
		}
	}
}

func TestBasesDePrueba(t *testing.T) {
	// eleventa-caida.fdb se guardó con un programa que murió a media operación (versiones sin confirmar).
	for _, base := range []string{"eleventa-chica", "eleventa-caida"} {
		base := base
		t.Run(base, func(t *testing.T) {
			ruta := filepath.Join("testdata", base+".fdb")
			bd, err := abrirBD(ruta)
			if err != nil {
				t.Fatal(err)
			}
			defer bd.Cerrar()
			datos, err := leerEleventa(bd)
			if err != nil {
				t.Fatal(err)
			}
			esp := leerEsperado(t, filepath.Join("testdata", base+".esperado.json"))
			comparar(t, "productos", tablaProductos(datos.Productos).Filas, esp.Productos)
			comparar(t, "clientes", tablaClientes(datos.Clientes).Filas, esp.Clientes)

			// y de punta a punta: lo que queda en los Excel
			dir := t.TempDir()
			res, err := convertir(ruta, dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Archivos) != 2 {
				t.Fatalf("archivos: %v", res.Archivos)
			}
			enc, filas := leerXLSX(t, filepath.Join(dir, "Productos-Eleventa.xlsx"))
			if strings.Join(enc, "|") != strings.Join(encabezadosProductos(), "|") {
				t.Fatalf("encabezados: %v", enc)
			}
			comparar(t, "excel productos", filas, esp.Productos)
			_, filas = leerXLSX(t, filepath.Join(dir, "Clientes-Eleventa.xlsx"))
			comparar(t, "excel clientes", filas, esp.Clientes)
		})
	}
}

func copiaTemporal(t *testing.T, base string, cambiar func([]byte) []byte) string {
	b, err := os.ReadFile(filepath.Join("testdata", base+".fdb"))
	if err != nil {
		t.Fatal(err)
	}
	if cambiar != nil {
		b = cambiar(b)
	}
	ruta := filepath.Join(t.TempDir(), "x.fdb")
	if err := os.WriteFile(ruta, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return ruta
}

func TestArchivosInvalidos(t *testing.T) {
	casos := []struct {
		nombre  string
		cambiar func([]byte) []byte
		mensaje string
	}{
		{"texto", func(b []byte) []byte { return bytes.Repeat([]byte("no soy una base\n"), 400) }, "no es una base de datos de Firebird"},
		{"vacío", func(b []byte) []byte { return nil }, "demasiado chico"},
		{"truncado", func(b []byte) []byte { return b[:len(b)*6/10] }, "incompleto o dañado"},
		{"ods12", func(b []byte) []byte { b[18], b[19] = 12, 0x80; return b }, "más nueva"},
		{"ods10", func(b []byte) []byte { b[18], b[19] = 10, 0; return b }, "InterBase"},
	}
	for _, c := range casos {
		ruta := copiaTemporal(t, "eleventa-chica", c.cambiar)
		_, err := convertir(ruta, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), c.mensaje) {
			t.Errorf("%s: error = %v, esperaba que dijera %q", c.nombre, err, c.mensaje)
		}
	}
	if _, err := convertir(filepath.Join(t.TempDir(), "noexiste.fdb"), t.TempDir()); !os.IsNotExist(unwrapPath(err)) {
		t.Errorf("archivo inexistente: %v", err)
	}
}

func unwrapPath(err error) error {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err
	}
	return err
}

// Un archivo dañado nunca debe tronar el programa ni quedarse dando vueltas: o termina o avisa.
func TestArchivoDanadoNoTrona(t *testing.T) {
	rnd := rand.New(rand.NewSource(7))
	for i := 0; i < 60; i++ {
		ruta := copiaTemporal(t, "eleventa-chica", func(b []byte) []byte {
			for k := 0; k < []int{3, 30, 300}[i%3]; k++ {
				b[rnd.Intn(len(b))] = byte(rnd.Intn(256))
			}
			return b
		})
		_, _ = convertir(ruta, t.TempDir()) // si hubiera un pánico sin capturar, la prueba fallaría aquí
	}
}
