// Eleventa a Compoint — pasa los productos y clientes de la base de Eleventa (PDVDATA.FDB) a
// dos archivos de Excel listos para importar en Compoint Punto.
//
// Es un solo .exe: no necesita instalar Firebird ni nada más. Lee el archivo .FDB por su cuenta
// (solo lectura: NUNCA modifica la base de Eleventa).
//
// Uso en Windows: doble clic (pide el archivo) o arrastrar el PDVDATA.FDB encima del .exe.
// Uso en consola:  eleventa-a-compoint PDVDATA.FDB [-o carpeta]
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	version = "1.0.0"
	titulo  = "Eleventa a Compoint"
)

// interfaz es lo que depende del sistema operativo (ventanas de Windows o consola).
type interfaz interface {
	// confirmar muestra un aviso con Aceptar/Cancelar; false si cancela.
	confirmar(texto string) bool
	elegirArchivo(sugerido string) (string, error) // "" si cancela
	mostrar(texto string, esError bool)
	carpetaSalida() string
	abrirCarpeta(ruta string)
	// errorDeUso dice si el error es porque otro programa (Eleventa/Firebird) tiene el archivo en uso.
	errorDeUso(err error) bool
}

type resultado struct {
	Productos, Clientes int
	Carpeta             string
	Archivos            []string
	Avisos              Avisos
	SinTablaClientes    bool
}

func main() {
	os.Exit(ejecutar(nuevaInterfaz(), os.Args[1:]))
}

func ejecutar(ui interfaz, args []string) int {
	var ruta, salida, volcar string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-o" || a == "--salida":
			if i+1 < len(args) {
				i++
				salida = args[i]
			}
		case a == "--volcar":
			if i+1 < len(args) {
				i++
				volcar = args[i]
			}
		case a == "-h" || a == "--ayuda" || a == "/?":
			ui.mostrar(ayuda(), false)
			return 0
		case a == "--version":
			ui.mostrar(titulo+" "+version, false)
			return 0
		case strings.HasPrefix(a, "-"):
			ui.mostrar("No conozco la opción "+a+".\n\n"+ayuda(), true)
			return 2
		default:
			ruta = a
		}
	}
	if ruta == "" {
		if volcar != "" {
			ui.mostrar("Falta el archivo .FDB.", true)
			return 2
		}
		if !ui.confirmar("Este programa pasa tus PRODUCTOS y CLIENTES de Eleventa a dos archivos de Excel para Compoint Punto.\n\n" +
			"• No modifica Eleventa: solo lee una copia de tus datos.\n" +
			"• Lo mejor es CERRAR Eleventa antes de seguir.\n\n" +
			"A continuación te voy a pedir el archivo PDVDATA.FDB de Eleventa.") {
			return 0
		}
		sugerido := buscarFDB()
		var err error
		ruta, err = ui.elegirArchivo(sugerido)
		if err != nil {
			ui.mostrar("No pude abrir la ventana para elegir el archivo: "+err.Error()+
				"\n\nPuedes arrastrar el archivo PDVDATA.FDB y soltarlo sobre este programa.", true)
			return 1
		}
		if ruta == "" {
			return 0
		}
	}
	if volcar != "" {
		return volcarJSON(ui, ruta, volcar)
	}
	if salida == "" {
		salida = ui.carpetaSalida()
	}
	res, err := convertir(ruta, salida)
	if err != nil {
		ui.mostrar(mensajeDeError(ui, ruta, err), true)
		return 1
	}
	ui.mostrar(mensajeFinal(res), false)
	ui.abrirCarpeta(res.Carpeta)
	return 0
}

func ayuda() string {
	return titulo + " " + version + "\n\n" +
		"Pasa productos y clientes de Eleventa (PDVDATA.FDB) a Excel para Compoint Punto.\n\n" +
		"  Doble clic ............ te pide el archivo\n" +
		"  Arrastrar el .FDB ..... sobre el programa\n" +
		"  Consola ............... eleventa-a-compoint PDVDATA.FDB [-o carpeta]\n"
}

func mensajeDeError(ui interfaz, ruta string, err error) string {
	var le *errLectura
	switch {
	case ui.errorDeUso(err):
		return "No pude abrir el archivo porque Eleventa (o su servicio Firebird) lo está usando.\n\n" +
			"Qué hacer:\n" +
			"1) Cierra Eleventa por completo.\n" +
			"2) Si sigue igual, copia el archivo PDVDATA.FDB a otra carpeta (por ejemplo el Escritorio) " +
			"y elige la copia.\n\n" + ruta
	case errors.Is(err, os.ErrNotExist):
		return "No encontré el archivo:\n" + ruta
	case errors.As(err, &le):
		return le.Error()
	case errors.Is(err, os.ErrPermission):
		return "Windows no me deja abrir el archivo (permisos). Copia el PDVDATA.FDB al Escritorio y elige la copia.\n\n" + ruta
	}
	return "No pude terminar: " + err.Error()
}

func mensajeFinal(r resultado) string {
	var b strings.Builder
	b.WriteString("¡Listo! Ya saqué tus datos de Eleventa.\n\n")
	fmt.Fprintf(&b, "Productos: %d\n", r.Productos)
	if r.SinTablaClientes {
		b.WriteString("Clientes: esta base no trae la lista de clientes\n")
	} else {
		fmt.Fprintf(&b, "Clientes: %d", r.Clientes)
		if r.Clientes == 0 {
			b.WriteString(" (\"Público en General\" no cuenta)")
		}
		b.WriteString("\n")
	}
	if len(r.Archivos) > 0 {
		b.WriteString("\nLos guardé en esta carpeta (se abre sola):\n" + r.Carpeta + "\n")
		b.WriteString("\nSiguiente paso, dentro de Compoint Punto:\n")
		for _, a := range r.Archivos {
			switch {
			case strings.HasPrefix(a, "Productos"):
				b.WriteString("• Catálogo > Reporte Inventario > botón Importar Excel > elegir " + a + "\n")
			case strings.HasPrefix(a, "Clientes"):
				b.WriteString("• Clientes > Clientes/Créditos > botón Importar Excel > elegir " + a + "\n")
			}
		}
	} else {
		b.WriteString("\nNo había nada que pasar: la base no tiene productos ni clientes propios.\n")
	}
	av := r.Avisos
	var notas []string
	if av.ConImpuestos > 0 {
		notas = append(notas, plural(av.ConImpuestos, "1 producto lleva impuesto", "%d productos llevan impuesto")+
			": se usó el precio final. Revisa que sea el que cobras.")
	}
	if av.SinInventario > 0 {
		notas = append(notas, plural(av.SinInventario,
			"1 producto no llevaba inventario en Eleventa: queda con existencia 0.",
			"%d productos no llevaban inventario en Eleventa: quedan con existencia 0."))
	}
	if av.Negativos > 0 {
		notas = append(notas, plural(av.Negativos, "1 producto tenía existencia negativa.", "%d productos tenían existencia negativa."))
	}
	if av.Kits > 0 {
		notas = append(notas, plural(av.Kits, "1 kit se pasa como producto normal.", "%d kits se pasan como producto normal."))
	}
	if av.SinNombre > 0 {
		notas = append(notas, plural(av.SinNombre, "1 producto sin nombre no se pasó.", "%d productos sin nombre no se pasaron."))
	}
	if len(notas) > 0 {
		b.WriteString("\nPara revisar:\n")
		for _, n := range notas {
			b.WriteString("• " + n + "\n")
		}
	}
	b.WriteString("\nTu base de Eleventa no se modificó.")
	return b.String()
}

// plural devuelve la frase 'uno' si n es 1 y, si no, la frase 'varios' con el número.
func plural(n int, uno, varios string) string {
	if n == 1 {
		return uno
	}
	return fmt.Sprintf(varios, n)
}

// convertir lee la base y escribe los Excel en la carpeta de salida.
func convertir(rutaFDB, carpeta string) (res resultado, err error) {
	bd, err := abrirBD(rutaFDB)
	if err != nil {
		return res, err
	}
	defer bd.Cerrar()
	datos, err := leerEleventa(bd)
	if err != nil {
		return res, err
	}
	if err = os.MkdirAll(carpeta, 0o755); err != nil {
		return res, fmt.Errorf("no pude crear la carpeta %s: %w", carpeta, err)
	}
	res = resultado{Productos: len(datos.Productos), Clientes: len(datos.Clientes), Carpeta: carpeta,
		Avisos: datos.Avisos, SinTablaClientes: datos.SinTablaClient}
	if len(datos.Productos) > 0 {
		nombre, e := guardarExcel(carpeta, "Productos-Eleventa", tablaProductos(datos.Productos))
		if e != nil {
			return res, e
		}
		res.Archivos = append(res.Archivos, nombre)
	}
	if len(datos.Clientes) > 0 {
		nombre, e := guardarExcel(carpeta, "Clientes-Eleventa", tablaClientes(datos.Clientes))
		if e != nil {
			return res, e
		}
		res.Archivos = append(res.Archivos, nombre)
	}
	return res, nil
}

// guardarExcel escribe <base>.xlsx; si ese nombre no se puede (por ejemplo está abierto en Excel)
// prueba con <base> (2).xlsx, (3)...
func guardarExcel(carpeta, base string, t tablaExcel) (string, error) {
	var ultimo error
	for n := 1; n <= 20; n++ {
		nombre := base + ".xlsx"
		if n > 1 {
			nombre = fmt.Sprintf("%s (%d).xlsx", base, n)
		}
		if ultimo = escribirXLSX(filepath.Join(carpeta, nombre), t); ultimo == nil {
			return nombre, nil
		}
	}
	return "", fmt.Errorf("no pude guardar el Excel en %s: %w", carpeta, ultimo)
}
