package main

// Herramienta de pruebas (no la usa la persona): vuelca el contenido de las tablas como JSON,
// una fila por línea, para compararlo contra lo que dice el motor real de Firebird.
//   eleventa-a-compoint archivo.fdb --volcar TABLA     (o --volcar '*' para todas las tablas)

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"time"
)

func valorJSON(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case int64:
		return x
	case dec:
		return map[string]any{"d": x.String()}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil
		}
		return json.Number(strconv.FormatFloat(x, 'g', -1, 64))
	case texto:
		rs := make([]rune, len(x.crudo))
		for i := 0; i < len(x.crudo); i++ {
			rs[i] = rune(x.crudo[i])
		}
		return map[string]any{"t": string(rs)} // un byte = un carácter (latin-1)
	case fecha:
		return map[string]any{"date": formatoValor(x)}
	case time.Time:
		return map[string]any{"ts": formatoValor(x)}
	case time.Duration:
		return map[string]any{"tm": formatoValor(x)}
	case refBlob:
		return map[string]any{"blob": true}
	case []byte:
		return map[string]any{"hex": fmt.Sprintf("%x", x)}
	}
	return fmt.Sprint(v)
}

func volcarJSON(ui interfaz, ruta, tabla string) int {
	bd, err := abrirBD(ruta)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		return 1
	}
	defer bd.Cerrar()
	var e *Esquema
	if err := capturar(func() { e = nuevoEsquema(bd) }); err != nil {
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		return 1
	}
	tablas := []string{tabla}
	if tabla == "*" {
		tablas = e.Tablas()
	}
	w := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer w.Flush()
	enc := json.NewEncoder(w)
	for _, t := range tablas {
		cols := e.Columnas(t)
		err := e.Filas(t, cols, func(f []any) {
			fila := make(map[string]any, len(cols))
			for i, c := range cols {
				fila[c] = valorJSON(f[i])
			}
			_ = enc.Encode(map[string]any{"T": t, "f": fila})
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "ERROR en", t+":", err)
			return 1
		}
	}
	return 0
}
