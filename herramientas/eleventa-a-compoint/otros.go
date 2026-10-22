//go:build !windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
)

// En Linux y Mac funciona por consola (sirve para probar y para quien prefiera la terminal).
type interfazConsola struct{}

func nuevaInterfaz() interfaz { return interfazConsola{} }

func (interfazConsola) confirmar(texto string) bool {
	fmt.Println(texto)
	fmt.Print("\n¿Seguir? (s/n): ")
	r, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(r)), "s")
}

func (interfazConsola) elegirArchivo(sugerido string) (string, error) {
	return "", errors.New("pasa la ruta del archivo .FDB como argumento")
}

func (interfazConsola) mostrar(texto string, esError bool) {
	if esError {
		fmt.Fprintln(os.Stderr, texto)
		return
	}
	fmt.Println(texto)
}

func (interfazConsola) carpetaSalida() string { return "salida-eleventa" }

func (interfazConsola) abrirCarpeta(ruta string) {}

func (interfazConsola) errorDeUso(err error) bool { return false }
