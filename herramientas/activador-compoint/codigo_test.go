package main

import (
	"crypto/ed25519"
	"strings"
	"testing"
)

// Llave de PRUEBA con semilla fija (bytes 0..31): la misma de backend/pruebas/licencia-codigo.test.js.
func llavePrueba() ed25519.PrivateKey {
	semilla := make([]byte, 32)
	for i := range semilla {
		semilla[i] = byte(i)
	}
	return ed25519.NewKeyFromSeed(semilla)
}

const (
	ejemploAnual      = "CPT1-04104-0R3ZC-2PG12-JGXNS-0RDKM-W0000-07KP7-HDSD7-YJ3MR-F02T0-WD5M1-ZBVME-HXZNC-ZSYT9-VRYKC-7CHTG-6WN2G-ER744-H903Y-BW5ZW-ZXGSP-Y8TGZ-A8AT2-XB8MT-S7C7H-0WF2A-SJW3G"
	ejemploPermanente = "CPT1-041G2-083ZF-ZZY12-JGXNS-0RDKM-W0000-08R32-N9RRY-PPJ7X-E5VGC-XCF2D-0T1J2-J15JM-M92F8-SM1ZM-5YSFV-JMA75-FRR99-VZ0EF-D7282-7YJF8-KFYV4-V7VE7-K2XCB-7FPZM-5AZH0-EXW3R"
)

func idPrueba(t *testing.T) uint64 {
	v, ok := leerIDEquipo("8MM7-DE86-3CX7")
	if !ok {
		t.Fatal("no leyó el ID de prueba")
	}
	return v
}

func TestLlaveDePruebaEsLaMismaQueNode(t *testing.T) {
	if got := publicaHex(llavePrueba().Public().(ed25519.PublicKey)); got != "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8" {
		t.Fatalf("llave pública distinta: %s", got)
	}
}

func TestCodigosDeEjemploFijosSonIdenticosAlSistema(t *testing.T) {
	priv := llavePrueba()
	id := idPrueba(t)
	anual, err := emitirCodigo(DatosCodigo{Tipo: "anual", Plan: "nube", MaxSucursales: 3, Emitida: "2026-10-16", Vence: "2027-10-16", IDEquipo: id, Serie: 7}, priv)
	if err != nil || anual != ejemploAnual {
		t.Fatalf("anual distinto:\n got %s\nwant %s\nerr %v", anual, ejemploAnual, err)
	}
	perm, err := emitirCodigo(DatosCodigo{Tipo: "permanente", Plan: "local", MaxSucursales: 1, Emitida: "2026-10-16", IDEquipo: id, Serie: 8}, priv)
	if err != nil || perm != ejemploPermanente {
		t.Fatalf("permanente distinto:\n got %s\nwant %s\nerr %v", perm, ejemploPermanente, err)
	}
	d, err := verificarCodigo(ejemploAnual, priv.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	if d.Tipo != "anual" || d.Plan != "nube" || d.MaxSucursales != 3 || d.Emitida != "2026-10-16" || d.Vence != "2027-10-16" || d.Serie != 7 || formatearIDEquipo(d.IDEquipo) != "8MM7-DE86-3CX7" {
		t.Fatalf("datos leídos mal: %+v", d)
	}
}

func TestIDDeEquipoToleraMinusculasEspaciosYLetrasConfundibles(t *testing.T) {
	v := idPrueba(t)
	for _, txt := range []string{"8mm7 de86 3cx7", "8MM7DE863CX7", "  8MM7-DE86-3CX7\n", "8MM7-DE86-3CX7"} {
		if got, ok := leerIDEquipo(txt); !ok || got != v {
			t.Errorf("no leyó %q", txt)
		}
	}
	for _, txt := range []string{"8MM7-DE86", "8MM7-DE86-3CXU", "", "8MM7-DE86-3CX7-AAAA"} {
		if _, ok := leerIDEquipo(txt); ok {
			t.Errorf("aceptó %q", txt)
		}
	}
	// O se lee como 0, I y L como 1
	if got, ok := leerIDEquipo("OOOO-1111-IIII"); !ok || formatearIDEquipo(got) != "0000-1111-1111" {
		t.Errorf("confundibles: %v %v", got, formatearIDEquipo(got))
	}
	if formatearIDEquipo(v) != "8MM7-DE86-3CX7" {
		t.Error("formato del ID")
	}
}

func TestCodigoPegadoConTextoAlrededor(t *testing.T) {
	pub := llavePrueba().Public().(ed25519.PublicKey)
	partido := strings.ToLower(strings.ReplaceAll(ejemploAnual, "-", "-\n"))
	for _, txt := range []string{
		"Hola, tu código es:\n" + ejemploAnual + "\nGracias por tu compra",
		partido,
		"  " + strings.Replace(strings.ReplaceAll(ejemploAnual, "-", " - "), "CPT1 - ", "CPT1-", 1) + "  ",
		strings.ReplaceAll(strings.ReplaceAll(ejemploAnual, "0", "O"), "1", "I"),
	} {
		d, err := verificarCodigo(txt, pub)
		if err != nil || d.Serie != 7 {
			n := len(txt)
			if n > 60 {
				n = 60
			}
			t.Errorf("no aceptó %q: %v", txt[:n], err)
		}
	}
}

func TestCodigosMalosSeRechazan(t *testing.T) {
	pub := llavePrueba().Public().(ed25519.PublicKey)
	casos := map[string]string{
		"":                                  "prefijo",
		"hola, no hay código":               "prefijo",
		ejemploAnual[:len(ejemploAnual)-12]: "incompleto",
	}
	for txt, motivo := range casos {
		if _, err := verificarCodigo(txt, pub); err == nil || err.Error() != motivo {
			t.Errorf("%q: esperaba %s, dio %v", txt, motivo, err)
		}
	}
	// un solo carácter cambiado rompe la firma
	i := strings.Index(ejemploAnual, "ZC") + 1
	c := byte('A')
	if ejemploAnual[i] == 'A' {
		c = 'B'
	}
	alterado := ejemploAnual[:i] + string(c) + ejemploAnual[i+1:]
	if _, err := verificarCodigo(alterado, pub); err == nil || err.Error() != "firma" {
		t.Errorf("alterado: %v", err)
	}
	// código de otra llave
	otra := ed25519.NewKeyFromSeed(make([]byte, 32))
	deOtro, _ := emitirCodigo(DatosCodigo{Tipo: "anual", Plan: "nube", MaxSucursales: 3, Emitida: "2026-10-16", Vence: "2027-10-16", IDEquipo: idPrueba(t), Serie: 7}, otra)
	if _, err := verificarCodigo(deOtro, pub); err == nil || err.Error() != "firma" {
		t.Errorf("de otra llave: %v", err)
	}
}

func TestNoSePuedenEmitirCodigosIncoherentes(t *testing.T) {
	priv := llavePrueba()
	id := idPrueba(t)
	base := DatosCodigo{Tipo: "anual", Plan: "nube", MaxSucursales: 3, Emitida: "2026-10-16", Vence: "2027-10-16", IDEquipo: id, Serie: 7}
	malos := map[string]func(*DatosCodigo){
		"no lleva vencimiento": func(d *DatosCodigo) { d.Tipo = "permanente" },
		"necesita fecha":       func(d *DatosCodigo) { d.Vence = "" },
		"Sucursales":           func(d *DatosCodigo) { d.MaxSucursales = 0 },
		"Sucursales ":          func(d *DatosCodigo) { d.MaxSucursales = 300 },
		"Plan":                 func(d *DatosCodigo) { d.Plan = "otro" },
		"Tipo":                 func(d *DatosCodigo) { d.Tipo = "otro" },
		"ID del equipo":        func(d *DatosCodigo) { d.IDEquipo = 0 },
		"Fecha":                func(d *DatosCodigo) { d.Vence = "2027-13-40" },
		"Fecha no válida":      func(d *DatosCodigo) { d.Vence = "2027-02-31" },
		"emisión fuera":        func(d *DatosCodigo) { d.Emitida = "2023-12-31" },
		"vencimiento fuera":    func(d *DatosCodigo) { d.Vence = "2300-01-01" },
	}
	for esperado, cambiar := range malos {
		d := base
		cambiar(&d)
		_, err := emitirCodigo(d, priv)
		if err == nil || !strings.Contains(err.Error(), strings.TrimSpace(esperado)) {
			t.Errorf("%s: dio %v", esperado, err)
		}
	}
}

func TestCodigoDePruebaDemo(t *testing.T) {
	priv := llavePrueba()
	cod, err := emitirCodigo(DatosCodigo{Tipo: "demo", Plan: "nube", MaxSucursales: 1, Emitida: "2026-10-16", Vence: "2026-11-15", IDEquipo: idPrueba(t), Serie: 7}, priv)
	if err != nil {
		t.Fatal(err)
	}
	d, err := verificarCodigo(cod, priv.Public().(ed25519.PublicKey))
	if err != nil || d.Tipo != "demo" || d.Vence != "2026-11-15" {
		t.Fatalf("%+v %v", d, err)
	}
}

func TestBase32EsReversible(t *testing.T) {
	for _, n := range []int{1, 5, 20, 84} {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte(i*37 + 11)
		}
		atras, sobra, ok := deBase32(aBase32(b))
		if !ok || sobra != 0 || string(atras[:n]) != string(b) {
			t.Errorf("n=%d no regresó igual", n)
		}
	}
}
