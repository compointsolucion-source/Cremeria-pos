package main

import (
	"encoding/json"
	"testing"
)

func leer(t *testing.T, b []byte) map[string]interface{} {
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v\n%s", err, b)
	}
	return m
}

func TestHandoffPredeterminadoNoCambiaNada(t *testing.T) {
	b, err := construirInstalacion(Opciones{Modo: "pred", Uso: "caja"}, `C:\CompointPunto`)
	if err != nil {
		t.Fatal(err)
	}
	m := leer(t, b)
	if len(m) != 2 || m["version"].(float64) != 1 || m["origen"] != "instalador" {
		t.Errorf("el predeterminado solo debe decir de dónde viene: %v", m)
	}
}

func TestHandoffAvanzadoServidor(t *testing.T) {
	op := Opciones{Modo: "av", Uso: "servidor", Datos: `D:\Negocio\datos`, Respaldos: `D:\Negocio\Respaldos`,
		CopiaExtraOn: true, CopiaExtra: `E:\Respaldos Compoint`, AbrirConWindows: true, Intermediario: false}
	m := leer(t, mustBytes(construirInstalacion(op, `C:\CompointPunto`)))
	if m["modo"] != "servidor" || m["carpetaDatos"] != `D:\Negocio\datos` || m["carpetaRespaldos"] != `D:\Negocio\Respaldos` || m["copiaExtra"] != `E:\Respaldos Compoint` {
		t.Errorf("carpetas mal: %v", m)
	}
	if m["iniciarConWindows"] != true || m["intermediario"] != false {
		t.Errorf("opciones mal: %v", m)
	}
}

func TestHandoffCarpetasEstandarNoSeMandan(t *testing.T) {
	op := Opciones{Modo: "av", Uso: "servidor", Datos: `c:\compointpunto\DATOS`, Respaldos: `C:\CompointPunto\Respaldos\`}
	m := leer(t, mustBytes(construirInstalacion(op, `C:\CompointPunto`)))
	if _, hay := m["carpetaDatos"]; hay {
		t.Errorf("la carpeta de datos estándar no se manda: %v", m)
	}
	// los respaldos estándar se mandan vacíos para deshacer una carpeta personalizada anterior; la copia extra apagada también
	if v, hay := m["carpetaRespaldos"]; !hay || v != "" {
		t.Errorf("respaldos estándar = \"\": %v", m)
	}
	if v, hay := m["copiaExtra"]; !hay || v != "" {
		t.Errorf("copia extra apagada = \"\": %v", m)
	}
}

func TestHandoffAvanzadoCajaNoMandaCarpetas(t *testing.T) {
	m := leer(t, mustBytes(construirInstalacion(Opciones{Modo: "av", Uso: "caja", Escritorio: true, AbrirConWindows: true, Intermediario: true}, `C:\CompointPunto`)))
	for _, k := range []string{"modo", "carpetaDatos", "carpetaRespaldos", "copiaExtra"} {
		if _, hay := m[k]; hay {
			t.Errorf("una caja no manda %s: %v", k, m)
		}
	}
	if m["iniciarConWindows"] != true || m["intermediario"] != true {
		t.Errorf("faltan las opciones: %v", m)
	}
}

func mustBytes(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}
