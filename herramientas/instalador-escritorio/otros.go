//go:build !windows

package main

import "os/exec"

// En Linux/Mac solo sirve para probar la pantalla: todo es simulado.
func nuevoSistemaReal() Sistema { return nuevoSimulado() }

func unaInstancia() bool { return true }

func abrirVentana(url string) (*exec.Cmd, error) { return nil, nil }
