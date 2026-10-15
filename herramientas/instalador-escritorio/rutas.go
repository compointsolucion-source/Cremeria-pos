package main

import (
	"errors"
	"fmt"
	"strings"
)

// Ayudas para rutas de Windows (D:\Carpeta\Sub). Se escriben a mano, sin depender del sistema operativo,
// para poder probarlas en cualquier computadora.

var nombresReservados = func() map[string]bool {
	m := map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}
	for i := 1; i <= 9; i++ {
		m[fmt.Sprintf("COM%d", i)] = true
		m[fmt.Sprintf("LPT%d", i)] = true
	}
	return m
}()

// norm limpia una ruta: barras al estilo Windows, sin repetidas, sin barra final, letra de unidad en mayúscula.
func norm(r string) string {
	r = strings.TrimSpace(r)
	if r == "" {
		return ""
	}
	r = strings.ReplaceAll(r, "/", `\`)
	unc := strings.HasPrefix(r, `\\`)
	for strings.Contains(r, `\\`) {
		r = strings.ReplaceAll(r, `\\`, `\`)
	}
	if unc {
		r = `\` + r
	}
	if len(r) == 2 && r[1] == ':' {
		r += `\`
	}
	if len(r) > 3 {
		r = strings.TrimRight(r, `\`)
	}
	if len(r) >= 2 && r[1] == ':' && ((r[0] >= 'a' && r[0] <= 'z') || (r[0] >= 'A' && r[0] <= 'Z')) {
		r = strings.ToUpper(r[:1]) + r[1:]
	}
	return r
}

func esUNC(r string) bool { return strings.HasPrefix(r, `\\`) }

// letraDe devuelve "D:" para una ruta que empieza con unidad, o "".
func letraDe(r string) string {
	r = norm(r)
	if len(r) >= 2 && r[1] == ':' && r[0] >= 'A' && r[0] <= 'Z' {
		return r[:2]
	}
	return ""
}

// esRaiz: "D:\" (la unidad completa) o "\\servidor\recurso".
func esRaiz(r string) bool {
	r = norm(r)
	if len(r) == 3 && r[1] == ':' && r[2] == '\\' {
		return true
	}
	if esUNC(r) {
		return len(strings.Split(strings.TrimPrefix(r, `\\`), `\`)) <= 2
	}
	return false
}

// padreDe sube un nivel. "" significa "la lista de unidades".
func padreDe(r string) string {
	r = norm(r)
	if r == "" || esRaiz(r) {
		return ""
	}
	i := strings.LastIndex(r, `\`)
	if i < 0 {
		return ""
	}
	p := r[:i]
	if len(p) == 2 && p[1] == ':' {
		p += `\`
	}
	if esUNC(r) && len(strings.Split(strings.TrimPrefix(p, `\\`), `\`)) < 2 {
		return ""
	}
	return p
}

func nombreBase(r string) string {
	r = norm(r)
	i := strings.LastIndex(r, `\`)
	if i < 0 {
		return r
	}
	return r[i+1:]
}

func unir(base, sub string) string {
	base = norm(base)
	if strings.HasSuffix(base, `\`) {
		return base + sub
	}
	return base + `\` + sub
}

func clave(r string) string { return strings.ToLower(norm(r)) }

func mismaRuta(a, b string) bool { return clave(a) == clave(b) }

// dentroDe: ¿"hija" es la misma carpeta que "madre" o está adentro de ella?
func dentroDe(hija, madre string) bool {
	h, m := clave(hija), strings.TrimRight(clave(madre), `\`)
	if h == "" || m == "" {
		return false
	}
	return h == m || h == m+`\` || strings.HasPrefix(h, m+`\`)
}

func segmentoValido(s string) error {
	if s == "" || s == "." || s == ".." {
		return errors.New("La ruta tiene partes vacías o con puntos.")
	}
	if strings.ContainsAny(s, "<>:\"|?*") {
		return errors.New("Los nombres de carpeta no pueden llevar estos signos:  < > : \" | ? *")
	}
	for _, c := range s {
		if c < 32 {
			return errors.New("La ruta tiene caracteres no permitidos.")
		}
	}
	if strings.HasSuffix(s, " ") || strings.HasSuffix(s, ".") {
		return errors.New("Un nombre de carpeta no puede terminar en espacio ni en punto.")
	}
	base := strings.ToUpper(s)
	if i := strings.Index(base, "."); i >= 0 {
		base = base[:i]
	}
	if nombresReservados[strings.TrimSpace(base)] {
		return fmt.Errorf("«%s» es un nombre reservado de Windows. Usa otro.", s)
	}
	return nil
}

// validarRuta revisa la forma de la ruta y la devuelve limpia.
func validarRuta(texto string, permitirUNC bool) (string, error) {
	r := norm(texto)
	if r == "" {
		return "", errors.New("Elige o escribe una carpeta.")
	}
	if len(r) > 200 {
		return "", errors.New("La ruta es demasiado larga. Elige una carpeta más cercana a la unidad.")
	}
	var resto string
	switch {
	case esUNC(r):
		if !permitirUNC {
			return "", errors.New("Aquí hay que elegir una carpeta de un disco de esta computadora.")
		}
		partes := strings.Split(strings.TrimPrefix(r, `\\`), `\`)
		if len(partes) < 2 || partes[0] == "" || partes[1] == "" {
			return "", errors.New(`La carpeta de red debe verse así:  \\servidor\recurso\carpeta`)
		}
		resto = strings.Join(partes[2:], `\`)
	case letraDe(r) != "":
		if len(r) < 3 || r[2] != '\\' {
			return "", errors.New("Escribe la ruta completa, por ejemplo  D:\\Compoint Punto")
		}
		resto = r[3:]
	default:
		return "", errors.New("Escribe la ruta completa empezando por la unidad, por ejemplo  D:\\Compoint Punto")
	}
	if resto != "" {
		for _, seg := range strings.Split(resto, `\`) {
			if err := segmentoValido(seg); err != nil {
				return "", err
			}
		}
	}
	return r, nil
}
