package main

import (
	"errors"
	"strconv"
	"strings"
)

func itoa(n int) string { return strconv.Itoa(n) }

func errPaso(p Paso) error {
	msg := p.Detalle
	if msg == "" {
		msg = "No se pudo completar este paso."
	}
	return errors.New(p.Titulo + ": " + msg)
}

func nombrePerfiles(perfiles []string) string {
	if len(perfiles) >= 3 {
		return "todas las redes"
	}
	var n []string
	for _, p := range perfiles {
		switch p {
		case "private":
			n = append(n, "Privada")
		case "domain":
			n = append(n, "Dominio")
		case "public":
			n = append(n, "Pública")
		}
	}
	return strings.Join(n, " y ")
}

// perfilesPS convierte la lista a lo que entiende New-NetFirewallRule.
func perfilesPS(perfiles []string) string {
	tiene := map[string]bool{}
	for _, p := range perfiles {
		tiene[p] = true
	}
	if tiene["private"] && tiene["domain"] && tiene["public"] {
		return "Any"
	}
	var n []string
	if tiene["private"] {
		n = append(n, "Private")
	}
	if tiene["domain"] {
		n = append(n, "Domain")
	}
	if tiene["public"] {
		n = append(n, "Public")
	}
	return strings.Join(n, ",")
}
