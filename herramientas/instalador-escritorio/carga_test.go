package main

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
)

func TestCargaIdaYVuelta(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "base.exe")
	if err := os.WriteFile(base, []byte("MZ-programa-falso"), 0o755); err != nil {
		t.Fatal(err)
	}
	paquete := make([]byte, 3*1024*1024+17)
	_, _ = rand.Read(paquete)
	final := filepath.Join(dir, "final.exe")
	meta := Meta{Formato: 1, Version: "1.2.3", Negocio: "Cremería Ñandú", Archivo: "Payload-CompointPunto.exe", TamanoInstalado: 450 * mb, ConUrl: true}
	if err := escribirCarga(final, base, paquete, meta); err != nil {
		t.Fatal(err)
	}
	c, err := abrirCarga(final)
	if err != nil {
		t.Fatal(err)
	}
	if c.Meta.Negocio != "Cremería Ñandú" || c.Meta.Version != "1.2.3" || !c.Meta.ConUrl || c.Meta.TamanoPaquete != int64(len(paquete)) {
		t.Errorf("meta mal leído: %+v", c.Meta)
	}
	salida := filepath.Join(dir, "sacado.exe")
	var ultimo int64
	if err := c.Extraer(salida, func(h, tot int64) { ultimo = h }); err != nil {
		t.Fatal(err)
	}
	if ultimo != int64(len(paquete)) {
		t.Errorf("el avance no llegó al final: %d", ultimo)
	}
	b, _ := os.ReadFile(salida)
	if !bytes.Equal(b, paquete) {
		t.Error("el paquete sacado no es igual")
	}
}

func TestCargaSinPaqueteODanada(t *testing.T) {
	dir := t.TempDir()
	solo := filepath.Join(dir, "solo.exe")
	_ = os.WriteFile(solo, []byte("MZ-programa-sin-nada-pegado-al-final-de-mas-de-64-bytes-................................"), 0o755)
	if _, err := abrirCarga(solo); err != errSinCarga {
		t.Errorf("sin paquete debe dar errSinCarga: %v", err)
	}
	// paquete con un byte cambiado: se detecta al sacarlo
	base := filepath.Join(dir, "base.exe")
	_ = os.WriteFile(base, []byte("MZ"), 0o755)
	final := filepath.Join(dir, "final.exe")
	if err := escribirCarga(final, base, bytes.Repeat([]byte("abc"), 1000), Meta{Formato: 1}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(final)
	b[100] ^= 0xFF
	_ = os.WriteFile(final, b, 0o755)
	c, err := abrirCarga(final)
	if err != nil {
		t.Fatal(err)
	}
	salida := filepath.Join(dir, "x.exe")
	if err := c.Extraer(salida, nil); err == nil {
		t.Error("un paquete dañado debe fallar")
	}
	if _, err := os.Stat(salida); err == nil {
		t.Error("no debe quedar el archivo dañado")
	}
	// descarga cortada (falta el final)
	b2, _ := os.ReadFile(final)
	_ = os.WriteFile(final, b2[:len(b2)-30], 0o755)
	if _, err := abrirCarga(final); err != errSinCarga {
		t.Errorf("sin el pie debe dar errSinCarga: %v", err)
	}
}

// Comprueba que un instalador armado por escritorio/scripts/empaquetar-instalador.js (Node) lo lee este programa.
// Se corre con:  CARGA_NODE=<instalador armado> CARGA_NODE_PAQUETE=<paquete original> go test -run TestCargaDeNode
func TestCargaDeNode(t *testing.T) {
	armado, original := os.Getenv("CARGA_NODE"), os.Getenv("CARGA_NODE_PAQUETE")
	if armado == "" || original == "" {
		t.Skip("sin archivos de Node para comparar")
	}
	c, err := abrirCarga(armado)
	if err != nil {
		t.Fatal(err)
	}
	if c.Meta.Negocio != "Cremería Ñandú" || c.Meta.Version != "1.2.3" || !c.Meta.ConUrl || c.Meta.TamanoInstalado != 450*mb || c.Meta.Archivo != "Payload.exe" {
		t.Errorf("meta mal leído: %+v", c.Meta)
	}
	salida := filepath.Join(t.TempDir(), "sacado.exe")
	if err := c.Extraer(salida, nil); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(salida)
	b, _ := os.ReadFile(original)
	if !bytes.Equal(a, b) {
		t.Error("el paquete sacado no es igual al original")
	}
}
