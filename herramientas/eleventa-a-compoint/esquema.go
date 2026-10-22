package main

// Capa de esquema: con lo que hay en las tablas internas de Firebird (RDB$RELATIONS,
// RDB$RELATION_FIELDS y RDB$FORMATS) se sabe qué columnas tiene cada tabla y en qué byte
// de cada registro vive cada valor.

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Códigos de tipo que usa Firebird dentro de los formatos de registro.
const (
	tCHAR      = 1
	tVARCHAR   = 3
	tSMALLINT  = 8
	tINTEGER   = 9
	tFLOAT     = 11
	tDOUBLE    = 12
	tDFLOAT    = 13
	tDATE      = 14
	tTIME      = 15
	tTIMESTAMP = 16
	tBLOB      = 17
	tBIGINT    = 19
)

// Tablas internas de Firebird que se leen con posiciones fijas (son iguales en toda base ODS 11).
const (
	relCampos    = 5 // RDB$RELATION_FIELDS
	relRelations = 6 // RDB$RELATIONS
	relFormatos  = 8 // RDB$FORMATS
)

type desc struct {
	tipo   uint8
	escala int8
	largo  uint16
	sub    int16
	flags  uint16
	off    uint32
}

// ---------------------------------------------------------------- valores

// texto es un valor de texto tal como está guardado (bytes) más el juego de caracteres de la columna.
type texto struct {
	crudo string
	cs    int
}

// dec es un número con decimales guardado como entero: valor = v × 10^esc (esc ≤ 0).
type dec struct {
	v   int64
	esc int
}

func (d dec) Float() float64 {
	if d.esc == 0 {
		return float64(d.v)
	}
	return float64(d.v) / math.Pow10(-d.esc)
}

func (d dec) String() string {
	if d.esc >= 0 {
		return strconv.FormatInt(d.v, 10) + strings.Repeat("0", d.esc)
	}
	neg := d.v < 0
	u := uint64(d.v)
	if neg {
		u = uint64(-d.v)
	}
	s := strconv.FormatUint(u, 10)
	n := -d.esc
	if len(s) <= n {
		s = strings.Repeat("0", n-len(s)+1) + s
	}
	s = s[:len(s)-n] + "." + s[len(s)-n:]
	if neg {
		s = "-" + s
	}
	return s
}

// String decodifica el texto: UTF-8 si la columna se declaró así; en cualquier otro caso
// Windows-1252 (que es como Eleventa guarda acentos y eñes aunque no lo declare).
func (t texto) String() string {
	if t.cs == 3 || t.cs == 4 { // UNICODE_FSS, UTF8
		if utf8.ValidString(t.crudo) {
			return t.crudo
		}
	}
	return decodificarCP1252(t.crudo)
}

type refBlob struct{ alto, bajo uint32 }

// fecha es un valor DATE (sin hora).
type fecha struct{ t time.Time }

// ---------------------------------------------------------------- esquema

type infoRel struct {
	id      int
	formato int
}

type Esquema struct {
	bd       *BD
	rels     map[string]infoRel
	campos   map[string]map[string]int // tabla -> columna -> id de campo
	blobIDs  map[[2]int][2]uint32
	fmtCache map[[2]int][]desc
}

func cadena(d []byte, desde, hasta int) string {
	return strings.TrimRight(string(d[desde:hasta]), " \x00")
}

func nuevoEsquema(bd *BD) *Esquema {
	e := &Esquema{
		bd:       bd,
		rels:     map[string]infoRel{},
		campos:   map[string]map[string]int{},
		blobIDs:  map[[2]int][2]uint32{},
		fmtCache: map[[2]int][]desc{},
	}
	bd.filas(relRelations, func(d []byte, _ uint8) {
		d = rellenar(d, 80)
		e.rels[cadena(d, 42, 73)] = infoRel{
			id:      int(int16(le.Uint16(d[32:]))),
			formato: int(int16(le.Uint16(d[38:]))),
		}
	})
	if _, ok := e.rels["RDB$RELATIONS"]; !ok {
		fallo("No pude leer el catálogo interno de la base (¿es una base de Firebird 2.5?).")
	}
	bd.filas(relCampos, func(d []byte, _ uint8) {
		d = rellenar(d, 310)
		col := cadena(d, 4, 35)
		tabla := cadena(d, 35, 66)
		fid := int(int16(le.Uint16(d[306:])))
		if e.campos[tabla] == nil {
			e.campos[tabla] = map[string]int{}
		}
		e.campos[tabla][col] = fid
	})
	bd.filas(relFormatos, func(d []byte, _ uint8) {
		d = rellenar(d, 16)
		rid := int(int16(le.Uint16(d[4:])))
		f := int(int16(le.Uint16(d[6:])))
		e.blobIDs[[2]int{rid, f}] = [2]uint32{le.Uint32(d[8:]), le.Uint32(d[12:])}
	})
	return e
}

// Tablas devuelve los nombres de las tablas que no son del sistema.
func (e *Esquema) Tablas() []string {
	var out []string
	for n := range e.rels {
		if !strings.HasPrefix(n, "RDB$") && !strings.HasPrefix(n, "MON$") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func (e *Esquema) Existe(tabla string) bool {
	_, ok := e.rels[tabla]
	return ok
}

// Columnas devuelve los nombres de las columnas de la tabla en el orden de creación.
func (e *Esquema) Columnas(tabla string) []string {
	m := e.campos[tabla]
	out := make([]string, 0, len(m))
	for n := range m {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return m[out[i]] < m[out[j]] })
	return out
}

func (e *Esquema) formato(rel, fmtID int) []desc {
	k := [2]int{rel, fmtID}
	if ds, ok := e.fmtCache[k]; ok {
		return ds
	}
	ref, ok := e.blobIDs[k]
	if !ok {
		fallo("La base no trae el formato %d de una tabla (archivo dañado).", fmtID)
	}
	b := e.bd.bytesBlob(ref[0], ref[1])
	if len(b)%12 != 0 {
		fallo("Descriptor de formato con tamaño raro (archivo dañado).")
	}
	ds := make([]desc, 0, len(b)/12)
	for i := 0; i < len(b); i += 12 {
		ds = append(ds, desc{
			tipo:   b[i],
			escala: int8(b[i+1]),
			largo:  le.Uint16(b[i+2:]),
			sub:    int16(le.Uint16(b[i+4:])),
			flags:  le.Uint16(b[i+6:]),
			off:    le.Uint32(b[i+8:]),
		})
	}
	e.fmtCache[k] = ds
	return ds
}

// Filas llama a f con una lista de valores (en el orden de 'cols') por cada fila vigente.
// Si falta la tabla o alguna columna, avisa con un error claro.
func (e *Esquema) Filas(tabla string, cols []string, f func(fila []any)) error {
	return capturar(func() {
		info, ok := e.rels[tabla]
		if !ok {
			fallo("No encontré la tabla %s en la base.", tabla)
		}
		ids := make([]int, len(cols))
		for i, c := range cols {
			fid, ok := e.campos[tabla][c]
			if !ok {
				fallo("A la tabla %s le falta la columna %s (¿es de otra versión de Eleventa?).", tabla, c)
			}
			ids[i] = fid
		}
		e.bd.filas(info.id, func(datos []byte, fm uint8) {
			ds := e.formato(info.id, int(fm))
			fila := make([]any, len(ids))
			for i, fid := range ids {
				fila[i] = valorDe(datos, ds, fid)
			}
			f(fila)
		})
	})
}

func valorDe(data []byte, ds []desc, fid int) any {
	if fid >= len(ds) {
		return nil // columna agregada después de que se guardó este registro
	}
	d := ds[fid]
	if d.tipo == 0 {
		return nil
	}
	if fid/8 < len(data) && (data[fid/8]>>(uint(fid)%8))&1 == 1 {
		return nil
	}
	off, ln := int(d.off), int(d.largo)
	if off+ln > len(data) {
		// el registro viene recortado por la compresión de ceros al final: se rellena con 0
		data = rellenar(data, off+ln)
	}
	switch d.tipo {
	case tCHAR:
		return texto{strings.TrimRight(string(data[off:off+ln]), " "), int(d.sub) & 0xff}
	case tVARCHAR:
		n := int(le.Uint16(data[off:]))
		if n > ln-2 {
			n = ln - 2
		}
		return texto{string(data[off+2 : off+2+n]), int(d.sub) & 0xff}
	case tSMALLINT:
		return escalar(int64(int16(le.Uint16(data[off:]))), d.escala)
	case tINTEGER:
		return escalar(int64(int32(le.Uint32(data[off:]))), d.escala)
	case tBIGINT:
		return escalar(int64(le.Uint64(data[off:])), d.escala)
	case tDOUBLE, tDFLOAT:
		return math.Float64frombits(le.Uint64(data[off:]))
	case tFLOAT:
		return float64(math.Float32frombits(le.Uint32(data[off:])))
	case tDATE:
		return fecha{fechaFirebird(int(int32(le.Uint32(data[off:]))), 0)}
	case tTIME:
		return time.Duration(le.Uint32(data[off:])) * 100 * time.Microsecond
	case tTIMESTAMP:
		return fechaFirebird(int(int32(le.Uint32(data[off:]))), le.Uint32(data[off+4:]))
	case tBLOB:
		return refBlob{le.Uint32(data[off:]), le.Uint32(data[off+4:])}
	}
	return append([]byte(nil), data[off:off+ln]...)
}

func escalar(v int64, escala int8) any {
	if escala == 0 {
		return v
	}
	return dec{v, int(escala)}
}

func fechaFirebird(dias int, ticks uint32) time.Time {
	t := time.Date(1858, 11, 17, 0, 0, 0, 0, time.UTC).AddDate(0, 0, dias)
	return t.Add(time.Duration(ticks) * 100 * time.Microsecond)
}

func formatoValor(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case texto:
		return x.String()
	case dec:
		return x.String()
	case fecha:
		return x.t.Format("2006-01-02")
	case time.Time:
		return formatoHora(x.Format("2006-01-02 15:04:05"), x.Nanosecond()/1000)
	case time.Duration:
		s := time.Time{}.Add(x)
		return formatoHora(s.Format("15:04:05"), s.Nanosecond()/1000)
	default:
		return fmt.Sprint(x)
	}
}

// formatoHora agrega los microsegundos (6 dígitos) solo cuando no son cero.
func formatoHora(base string, micro int) string {
	if micro == 0 {
		return base
	}
	return fmt.Sprintf("%s.%06d", base, micro)
}
