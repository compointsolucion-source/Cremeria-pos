//go:build !windows

package main

import (
	"os"
	"os/exec"
)

// En Linux/Mac solo sirve para probar: no abre ventana y el selector de carpetas usa una variable.
func abrirVentana(url string) (*exec.Cmd, error) { return nil, nil }

func instanciaUnica() bool { return true }

// ACTIVADOR_CARPETA_SIM = carpeta que "elige" el usuario (vacía = cancela).
func elegirCarpeta(titulo string) (string, error) { return os.Getenv("ACTIVADOR_CARPETA_SIM"), nil }
