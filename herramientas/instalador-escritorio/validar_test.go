package main

import (
	"strings"
	"testing"
)

func metaPrueba() Meta {
	return Meta{Formato: 1, Version: "1.0.0", Negocio: "Compoint Punto", TamanoInstalado: 452 * mb, TamanoPaquete: 118 * mb}
}

func servidorOpc() Opciones {
	return Opciones{Modo: "av", Uso: "servidor",
		Programa: `C:\Users\Compoint\AppData\Local\Programs\Compoint Punto`,
		Datos:    `C:\CompointPunto\datos`, Respaldos: `C:\CompointPunto\Respaldos`}
}

func hay(v Validacion, campo, trozo string) bool {
	return strings.Contains(v.Campos[campo], trozo)
}

func tieneAviso(v Validacion, trozo string) bool {
	for _, a := range v.Avisos {
		if strings.Contains(a, trozo) {
			return true
		}
	}
	return false
}

func TestValidarPredeterminado(t *testing.T) {
	sis := nuevoSimulado()
	op := Opciones{Modo: "pred", Uso: "caja", Programa: sis.Defaults().Programa}
	v := validar(&op, sis, metaPrueba())
	if !v.ok() || v.NecesitaAdmin {
		t.Fatalf("lo predeterminado debe valer sin permisos: %+v", v)
	}
}

func TestValidarPrograma(t *testing.T) {
	sis := nuevoSimulado()
	m := metaPrueba()
	prueba := func(ruta string) Validacion {
		op := Opciones{Modo: "av", Uso: "caja", Programa: ruta}
		return validar(&op, sis, m)
	}
	if v := prueba(`D:\`); !v.ok() || v.Opciones.Programa != `D:\Compoint Punto` {
		t.Errorf("la raíz se completa con la subcarpeta: %+v %q", v.Campos, v.Opciones.Programa)
	}
	if v := prueba(`E:\Compoint Punto`); !hay(v, "programa", "USB") {
		t.Errorf("USB no debe valer: %+v", v.Campos)
	}
	if v := prueba(`Z:\Compoint Punto`); !hay(v, "programa", "no existe") {
		t.Errorf("unidad inexistente: %+v", v.Campos)
	}
	if v := prueba(`D:\Mis archivos`); !v.ok() || v.Opciones.Programa != `D:\Mis archivos\Compoint Punto` {
		t.Errorf("carpeta con archivos: se instala en una subcarpeta: %+v %q", v.Campos, v.Opciones.Programa)
	}
	if v := prueba(`D:\Compoint Punto Viejo`); !hay(v, "programa", "otros archivos") {
		t.Errorf("carpeta «Compoint Punto…» con archivos ajenos no debe valer: %+v", v.Campos)
	}
	if v := prueba(`d:/programas/COMPOINT PUNTO/`); !v.ok() || v.Opciones.Programa != `D:\programas\COMPOINT PUNTO` {
		t.Errorf("mayúsculas y barras: %+v %q", v.Campos, v.Opciones.Programa)
	}
	if v := prueba(`D:\Programas\Compoint Punto`); !v.ok() || v.NecesitaAdmin {
		t.Errorf("carpeta nueva en D: debe valer: %+v", v)
	}
	if v := prueba(`C:\Program Files`); !v.ok() || !v.NecesitaAdmin || len(v.Avisos) == 0 || v.Opciones.Programa != `C:\Program Files\Compoint Punto` {
		t.Errorf("Program Files debe pedir administrador: %+v", v)
	}
	t.Setenv("INSTALADOR_SIM_ADMIN", "1")
	if v := prueba(`C:\Program Files\Compoint Punto`); !v.ok() || v.NecesitaAdmin {
		t.Errorf("siendo administrador no hace falta pedir permiso: %+v", v)
	}
}

func TestValidarEspacio(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_POCO_ESPACIO", "1")
	sis := nuevoSimulado()
	op := Opciones{Modo: "pred", Uso: "caja", Programa: sis.Defaults().Programa}
	v := validar(&op, sis, metaPrueba())
	if v.ok() || !hay(v, "programa", "No hay espacio") {
		t.Errorf("debería faltar espacio: %+v", v)
	}
}

func TestValidarServidorBueno(t *testing.T) {
	sis := nuevoSimulado()
	op := servidorOpc()
	if v := validar(&op, sis, metaPrueba()); !v.ok() {
		t.Fatalf("servidor con carpetas estándar debe valer: %+v", v)
	}
	// con copia extra en la USB
	op = servidorOpc()
	op.CopiaExtraOn, op.CopiaExtra = true, `E:\Respaldos Compoint`
	if v := validar(&op, sis, metaPrueba()); !v.ok() || len(v.Avisos) != 0 {
		t.Errorf("copia extra en USB debe valer sin avisos: %+v", v)
	}
	// carpetas elegidas en D:
	op = servidorOpc()
	op.Datos, op.Respaldos = `D:\Negocio\datos`, `D:\Negocio\Respaldos`
	if v := validar(&op, sis, metaPrueba()); !v.ok() {
		t.Errorf("carpetas nuevas en D: deben valer: %+v", v)
	}
}

func TestValidarServidorMalo(t *testing.T) {
	sis := nuevoSimulado()
	m := metaPrueba()
	casos := []struct {
		nombre string
		cambia func(*Opciones)
		campo  string
		texto  string
	}{
		{"datos dentro del programa", func(o *Opciones) { o.Datos = o.Programa + `\datos` }, "datos", "dentro de la carpeta del programa"},
		{"programa dentro de datos", func(o *Opciones) { o.Programa = `D:\Negocio\datos\app`; o.Datos = `D:\Negocio\datos` }, "datos", "dentro de la carpeta del programa"},
		{"datos en USB", func(o *Opciones) { o.Datos = `E:\datos` }, "datos", "disco de esta computadora"},
		{"datos en la raíz", func(o *Opciones) { o.Datos = `D:\` }, "datos", "no la unidad completa"},
		{"datos en carpeta ajena", func(o *Opciones) { o.Datos = `D:\Datos` }, "datos", "otros archivos"},
		{"datos en red", func(o *Opciones) { o.Datos = `\\srv\comp\datos` }, "datos", "disco de esta computadora"},
		{"datos sin permiso", func(o *Opciones) { o.Datos = `D:\Solo lectura\datos` }, "datos", "permiso"},
		{"respaldos en el programa", func(o *Opciones) { o.Respaldos = o.Programa + `\Respaldos` }, "respaldos", "dentro de la carpeta del programa"},
		{"respaldos dentro de datos", func(o *Opciones) { o.Respaldos = o.Datos + `\Respaldos` }, "respaldos", "ni al revés"},
		{"respaldos en red", func(o *Opciones) { o.Respaldos = `\\srv\comp\r` }, "respaldos", "disco de esta computadora"},
		{"copia extra igual a respaldos", func(o *Opciones) { o.CopiaExtraOn, o.CopiaExtra = true, o.Respaldos }, "copiaExtra", "distinta"},
		{"copia extra dentro de datos", func(o *Opciones) { o.CopiaExtraOn, o.CopiaExtra = true, o.Datos+`\copia` }, "copiaExtra", "información del negocio"},
		{"copia extra sin carpeta", func(o *Opciones) { o.CopiaExtraOn, o.CopiaExtra = true, `` }, "copiaExtra", "Elige o escribe"},
		{"copia extra en la raíz", func(o *Opciones) { o.CopiaExtraOn, o.CopiaExtra = true, `E:\` }, "copiaExtra", "no la unidad completa"},
	}
	for _, c := range casos {
		op := servidorOpc()
		c.cambia(&op)
		v := validar(&op, sis, m)
		if v.ok() || !hay(v, c.campo, c.texto) {
			t.Errorf("%s: esperaba error en %s con %q, salió %+v", c.nombre, c.campo, c.texto, v.Campos)
		}
	}
}

func TestValidarAvisos(t *testing.T) {
	sis := nuevoSimulado()
	m := metaPrueba()
	op := servidorOpc()
	op.Respaldos = `E:\Respaldos Compoint`
	v := validar(&op, sis, m)
	if !v.ok() || !tieneAviso(v, "USB") {
		t.Errorf("respaldos en USB: valen, con aviso: %+v", v)
	}
	op = servidorOpc()
	op.CopiaExtraOn, op.CopiaExtra = true, `C:\Copia`
	v = validar(&op, sis, m)
	if !v.ok() || !tieneAviso(v, "misma unidad") {
		t.Errorf("copia extra en el mismo disco: avisa: %+v", v)
	}
	op = servidorOpc()
	op.CopiaExtraOn, op.CopiaExtra = true, `\\servidor\respaldos\compoint`
	v = validar(&op, sis, m)
	if !v.ok() || !tieneAviso(v, "carpeta de red") {
		t.Errorf("copia extra en red: vale, con aviso: %+v", v)
	}
}

func TestValidarDatosExistentes(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_DATOS_EXISTENTES", "1")
	sis := nuevoSimulado()
	m := metaPrueba()
	op := servidorOpc()
	op.Datos = `D:\Negocio\datos`
	v := validar(&op, sis, m)
	if v.ok() || !hay(v, "datos", "Para no perderla") {
		t.Errorf("con información existente no se puede mover: %+v", v.Campos)
	}
	op = servidorOpc()
	v = validar(&op, sis, m)
	if !v.ok() || !tieneAviso(v, "se conserva") {
		t.Errorf("reutilizar lo existente vale, con aviso: %+v", v)
	}
}

func TestValidarYaInstalado(t *testing.T) {
	t.Setenv("INSTALADOR_SIM_YA_INSTALADO", "1")
	sis := nuevoSimulado()
	op := Opciones{Modo: "av", Uso: "caja", Programa: `D:\Programas\Compoint Punto`}
	v := validar(&op, sis, metaPrueba())
	if !v.ok() || !tieneAviso(v, "dos copias") {
		t.Errorf("instalar en otra carpeta avisa de dos copias: %+v", v)
	}
	op = Opciones{Modo: "pred", Uso: "caja", Programa: sis.YaInstalado()}
	v = validar(&op, sis, metaPrueba())
	if !v.ok() || len(v.Avisos) != 0 {
		t.Errorf("actualizar en el mismo lugar vale sin avisos: %+v", v)
	}
}

func TestUsoCajaLimpiaCarpetasDeServidor(t *testing.T) {
	sis := nuevoSimulado()
	op := Opciones{Modo: "av", Uso: "caja", Programa: sis.Defaults().Programa, Datos: `X`, Respaldos: `Y`, CopiaExtraOn: true, CopiaExtra: `Z`}
	v := validar(&op, sis, metaPrueba())
	if !v.ok() || v.Opciones.Datos != "" || v.Opciones.CopiaExtraOn {
		t.Errorf("una caja no usa carpetas de servidor: %+v", v)
	}
}

func TestSugerirCopiaExtra(t *testing.T) {
	sis := nuevoSimulado()
	if r := sugerirCopiaExtra(sis.Unidades(), `C:\CompointPunto\datos`, `C:\CompointPunto\Respaldos`); r != `E:\Respaldos Compoint` {
		t.Errorf("con USB debe sugerir la USB: %q", r)
	}
	t.Setenv("INSTALADOR_SIM_SIN_USB", "1")
	if r := sugerirCopiaExtra(sis.Unidades(), `C:\CompointPunto\datos`, `C:\CompointPunto\Respaldos`); r != `D:\Respaldos Compoint` {
		t.Errorf("sin USB debe sugerir el segundo disco: %q", r)
	}
	if r := sugerirCopiaExtra(sis.Unidades(), `D:\x`, `C:\y`); r != "" {
		t.Errorf("si los datos y respaldos usan los dos discos no hay dónde: %q", r)
	}
}
