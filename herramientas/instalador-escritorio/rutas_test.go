package main

import "testing"

func TestNorm(t *testing.T) {
	casos := map[string]string{
		`d:/Compoint//Punto/`:   `D:\Compoint\Punto`,
		`  c:\ `:                `C:\`,
		`E:`:                    `E:\`,
		`\\servidor\recurso\x\`: `\\servidor\recurso\x`,
		``:                      ``,
	}
	for entrada, esperado := range casos {
		if r := norm(entrada); r != esperado {
			t.Errorf("norm(%q) = %q, esperaba %q", entrada, r, esperado)
		}
	}
}

func TestPadreYRaiz(t *testing.T) {
	if padreDe(`D:\a\b`) != `D:\a` || padreDe(`D:\a`) != `D:\` || padreDe(`D:\`) != "" {
		t.Error("padreDe falla")
	}
	if !esRaiz(`C:\`) || esRaiz(`C:\x`) || !esRaiz(`\\srv\comp`) || esRaiz(`\\srv\comp\x`) {
		t.Error("esRaiz falla")
	}
	if padreDe(`\\srv\comp\x`) != `\\srv\comp` || padreDe(`\\srv\comp`) != "" {
		t.Error("padreDe UNC falla")
	}
}

func TestDentroDe(t *testing.T) {
	if !dentroDe(`C:\Programas\Compoint\datos`, `c:\programas\compoint`) {
		t.Error("debería estar dentro")
	}
	if dentroDe(`C:\Programas\CompointOtro`, `C:\Programas\Compoint`) {
		t.Error("un nombre parecido no es 'dentro'")
	}
	if !dentroDe(`C:\x`, `C:\x`) {
		t.Error("la misma carpeta cuenta como dentro")
	}
	if !dentroDe(`C:\x`, `C:\`) {
		t.Error("todo está dentro de la raíz")
	}
}

func TestValidarRuta(t *testing.T) {
	malas := []string{``, `Compoint`, `C:Compoint`, `C:\a\CON`, `C:\a\b:c`, `C:\a\b.`, `C:\a\..\b`, `\\srv`, `C:\a<b`}
	for _, m := range malas {
		if _, err := validarRuta(m, false); err == nil {
			t.Errorf("%q debería ser inválida", m)
		}
	}
	if _, err := validarRuta(`\\srv\comp\Resp`, false); err == nil {
		t.Error("la ruta de red no debería valer cuando no se permite")
	}
	if r, err := validarRuta(`\\srv\comp\Resp`, true); err != nil || r != `\\srv\comp\Resp` {
		t.Errorf("la ruta de red debería valer: %v %q", err, r)
	}
	if r, err := validarRuta(`d:/Mi Negocio/Datos`, false); err != nil || r != `D:\Mi Negocio\Datos` {
		t.Errorf("ruta buena: %v %q", err, r)
	}
}
