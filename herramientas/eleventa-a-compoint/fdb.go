package main

// Lector de archivos de Firebird 2.5 (formato ODS 11) escrito desde cero, sin Firebird.
//
// Solo LEE (el archivo se abre en modo lectura y nunca se modifica). Entiende:
//   - páginas de encabezado, de punteros, de datos y de blobs;
//   - registros partidos en fragmentos, comprimidos (RLE) y con versiones viejas;
//   - versiones de registros que quedaron sin terminar (programa cerrado de golpe):
//     se ignoran y se toma la última versión que sí se guardó completa;
//   - tablas con columnas agregadas o quitadas después (cada registro lleva su "formato").
//
// Está probado contra el motor real de Firebird 2.5 con bases de 4, 8 y 16 KB de página.

import (
	"encoding/binary"
	"fmt"
	"os"
	"sort"
)

var le = binary.LittleEndian

// errLectura es un problema "esperado" con un mensaje que se le puede mostrar a la persona.
type errLectura struct{ msg string }

func (e *errLectura) Error() string { return e.msg }

func fallo(formato string, a ...any) { panic(&errLectura{fmt.Sprintf(formato, a...)}) }

// capturar corre f y convierte cualquier pánico (incluidos los de índices fuera de rango
// por un archivo dañado) en un error normal.
func capturar(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(*errLectura); ok {
				err = e
				return
			}
			err = &errLectura{fmt.Sprintf("la estructura del archivo no es la esperada (%v)", r)}
		}
	}()
	f()
	return nil
}

// ---------------------------------------------------------------- bytes

// descomprimir deshace la compresión RLE de Firebird: un número positivo n significa
// "copia los siguientes n bytes", uno negativo -n significa "repite n veces el siguiente byte".
func descomprimir(b []byte) []byte {
	out := make([]byte, 0, len(b)*2)
	i := 0
	for i < len(b) {
		c := int8(b[i])
		i++
		if c > 0 {
			n := int(c)
			if i+n > len(b) {
				n = len(b) - i
			}
			out = append(out, b[i:i+n]...)
			i += n
		} else if c < 0 {
			if i >= len(b) {
				break
			}
			for k := 0; k < -int(c); k++ {
				out = append(out, b[i])
			}
			i++
		}
	}
	return out
}

// aplicarDiferencias arma una versión vieja de un registro a partir de la nueva más una
// "cinta" de diferencias: n>0 = n bytes nuevos que vienen en la cinta, n<0 = conservar -n bytes.
func aplicarDiferencias(base, cinta []byte) []byte {
	total := 0
	for i := 0; i < len(cinta); {
		c := int8(cinta[i])
		i++
		if c > 0 {
			total += int(c)
			i += int(c)
		} else {
			total += -int(c)
		}
	}
	out := make([]byte, total)
	copy(out, base)
	p := 0
	for i := 0; i < len(cinta); {
		c := int8(cinta[i])
		i++
		if c > 0 {
			n := int(c)
			if i+n > len(cinta) {
				n = len(cinta) - i
			}
			copy(out[p:], cinta[i:i+n])
			p += int(c)
			i += int(c)
		} else {
			p += -int(c)
		}
	}
	return out
}

// ---------------------------------------------------------------- base de datos

type registro struct {
	pagina  uint32
	linea   int
	tx      uint32
	bpagina uint32 // versión anterior
	blinea  uint16
	flags   uint16
	formato uint8
	fpagina uint32 // siguiente fragmento
	flinea  uint16
	datos   []byte // sin el encabezado
	crudo   []byte // con encabezado
}

const (
	flagBorrado    = 1
	flagVersion    = 2 // versión vieja encadenada
	flagFragmento  = 4 // fragmento de un registro
	flagIncompleto = 8 // el registro sigue en otro fragmento
	flagBlob       = 16
	flagDelta      = 32 // la versión vieja viene como diferencias
)

type pagRDB struct {
	pagina uint32
	rel    int
	seq    int32
	tipo   int
}

// BD es un archivo .FDB abierto en modo lectura.
type BD struct {
	f          *os.File
	tam        int
	paginasMax int64
	cache      map[uint32][]byte
	cacheMax   int
	maxRec     int
	hdrPages   uint32
	verMenor   int
	ptrDe      map[int][]uint32 // relación -> páginas de punteros (en orden)
	tip        []uint32         // páginas de estado de transacciones
	tpp        uint32           // transacciones por página
}

// abrirBD abre el archivo y prepara lo mínimo para leerlo. Los errores traen mensaje para la persona.
func abrirBD(ruta string) (bd *BD, err error) {
	f, e := os.Open(ruta)
	if e != nil {
		return nil, e
	}
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	err = capturar(func() {
		cab := make([]byte, 128)
		n, _ := f.ReadAt(cab, 0)
		if n < 64 {
			fallo("El archivo es demasiado chico para ser una base de datos de Firebird.")
		}
		tam := int(le.Uint16(cab[16:]))
		ods := le.Uint16(cab[18:])
		validoTam := tam == 1024 || tam == 2048 || tam == 4096 || tam == 8192 || tam == 16384 || tam == 32768
		if cab[0] != 1 || !validoTam {
			fallo("Este archivo no es una base de datos de Firebird (¿será un respaldo .fbk u otro tipo de archivo?).")
		}
		mayor := int(ods & 0x7fff)
		if ods&0x8000 == 0 && mayor < 12 {
			fallo("Este archivo parece de InterBase, no de Firebird. Eleventa usa Firebird 2.5.")
		}
		if mayor != 11 {
			if mayor > 11 {
				fallo("Esta base se creó con una versión de Firebird más nueva que la 2.5 (ODS %d). Este convertidor lee la de Eleventa con Firebird 2.5 (ODS 11).", mayor)
			}
			fallo("Esta base es de una versión de Firebird demasiado vieja (ODS %d). Este convertidor lee la de Firebird 2.5 (ODS 11).", mayor)
		}
		st, e := f.Stat()
		if e != nil {
			fallo("No pude leer el tamaño del archivo: %v", e)
		}
		bd = &BD{f: f, tam: tam, paginasMax: st.Size() / int64(tam), cache: map[uint32][]byte{}}
		bd.cacheMax = (96 << 20) / tam
		bd.maxRec = (tam - 24) / 17
		bd.hdrPages = le.Uint32(cab[20:])
		bd.cargarPaginasRDB()
	})
	if err != nil {
		return nil, err
	}
	return bd, nil
}

func (bd *BD) Cerrar() { bd.f.Close() }

func (bd *BD) pagina(n uint32) []byte {
	if p, ok := bd.cache[n]; ok {
		return p
	}
	if int64(n) >= bd.paginasMax {
		fallo("El archivo está incompleto o dañado (falta la página %d). Si Eleventa estaba abierto, ciérralo y copia el archivo otra vez.", n)
	}
	if len(bd.cache) >= bd.cacheMax {
		bd.cache = map[uint32][]byte{}
	}
	p := make([]byte, bd.tam)
	if _, err := bd.f.ReadAt(p, int64(n)*int64(bd.tam)); err != nil {
		fallo("No pude leer la página %d del archivo: %v", n, err)
	}
	bd.cache[n] = p
	return p
}

type ranura struct {
	global int
	pagina uint32
}

// ranuras recorre una cadena de páginas de punteros y devuelve (número de ranura, página de datos).
func (bd *BD) ranuras(ptr uint32) []ranura {
	var out []ranura
	base := 0
	vistas := map[uint32]bool{}
	for ptr != 0 {
		if vistas[ptr] {
			fallo("Cadena de páginas de punteros en círculo (archivo dañado).")
		}
		vistas[ptr] = true
		p := bd.pagina(ptr)
		if p[0] != 4 {
			fallo("La página %d debía ser de punteros y no lo es (archivo dañado).", ptr)
		}
		sig := le.Uint32(p[20:])
		cnt := int(le.Uint16(p[24:]))
		if 32+4*cnt > len(p) {
			fallo("Página de punteros %d con conteo imposible (archivo dañado).", ptr)
		}
		for i := 0; i < cnt; i++ {
			out = append(out, ranura{base + i, le.Uint32(p[32+4*i:])})
		}
		base += cnt
		ptr = sig
	}
	return out
}

// cargarPaginasRDB lee RDB$PAGES (el "índice" de páginas) para saber dónde está cada tabla.
func (bd *BD) cargarPaginasRDB() {
	var pags []pagRDB
	for _, r := range bd.ranuras(bd.hdrPages) {
		if r.pagina == 0 {
			continue
		}
		for _, rg := range bd.registrosCrudos(r.pagina) {
			if rg.flags&(flagVersion|flagFragmento|flagIncompleto|flagBlob) != 0 {
				continue
			}
			d := rellenar(descomprimir(rg.datos), 24)
			pags = append(pags, pagRDB{
				pagina: le.Uint32(d[4:]),
				rel:    int(int16(le.Uint16(d[8:]))),
				seq:    int32(le.Uint32(d[12:])),
				tipo:   int(int16(le.Uint16(d[16:]))),
			})
		}
	}
	sort.SliceStable(pags, func(i, j int) bool { return pags[i].seq < pags[j].seq })
	bd.ptrDe = map[int][]uint32{}
	bd.tip = nil
	for _, p := range pags {
		switch p.tipo {
		case 4:
			bd.ptrDe[p.rel] = append(bd.ptrDe[p.rel], p.pagina)
		case 3:
			bd.tip = append(bd.tip, p.pagina)
		}
	}
	bd.tpp = uint32((bd.tam - 20) * 4)
	if len(bd.tip) == 0 {
		fallo("No encontré el control de transacciones de la base (archivo dañado).")
	}
}

func rellenar(d []byte, n int) []byte {
	if len(d) >= n {
		return d
	}
	return append(d[:len(d):len(d)], make([]byte, n-len(d))...)
}

func (bd *BD) registrosCrudos(pn uint32) []registro {
	p := bd.pagina(pn)
	if p[0] != 5 {
		fallo("El archivo parece dañado o incompleto (la página %d debía ser de datos). Si Eleventa estaba abierto, ciérralo y copia el archivo otra vez.", pn)
	}
	cnt := int(le.Uint16(p[22:]))
	if 24+4*cnt > len(p) {
		fallo("Página de datos %d con conteo imposible (archivo dañado).", pn)
	}
	out := make([]registro, 0, cnt)
	for i := 0; i < cnt; i++ {
		off := int(le.Uint16(p[24+4*i:]))
		ln := int(le.Uint16(p[26+4*i:]))
		if off == 0 || ln == 0 {
			continue
		}
		out = append(out, bd.leerRegistro(p, pn, i, off, ln))
	}
	return out
}

func (bd *BD) leerRegistro(p []byte, pn uint32, linea, off, ln int) registro {
	if off+ln > len(p) || ln < 13 {
		fallo("Registro con tamaño imposible en la página %d (archivo dañado).", pn)
	}
	r := registro{
		pagina:  pn,
		linea:   linea,
		tx:      le.Uint32(p[off:]),
		bpagina: le.Uint32(p[off+4:]),
		blinea:  le.Uint16(p[off+8:]),
		flags:   le.Uint16(p[off+10:]),
		formato: p[off+12],
	}
	hs := 13
	if r.flags&flagIncompleto != 0 {
		if ln < 22 {
			fallo("Fragmento con tamaño imposible en la página %d (archivo dañado).", pn)
		}
		r.fpagina = le.Uint32(p[off+16:])
		r.flinea = le.Uint16(p[off+20:])
		hs = 22
	}
	r.datos = p[off+hs : off+ln]
	r.crudo = p[off : off+ln]
	return r
}

func (bd *BD) registroEn(pn uint32, linea int) registro {
	p := bd.pagina(pn)
	if p[0] != 5 {
		fallo("La página %d debía ser de datos y no lo es (archivo dañado).", pn)
	}
	cnt := int(le.Uint16(p[22:]))
	if linea >= cnt {
		fallo("Registro fuera de rango en la página %d (archivo dañado).", pn)
	}
	off := int(le.Uint16(p[24+4*linea:]))
	ln := int(le.Uint16(p[26+4*linea:]))
	if off == 0 || ln == 0 {
		fallo("Registro vacío en la página %d (archivo dañado).", pn)
	}
	return bd.leerRegistro(p, pn, linea, off, ln)
}

// estadoTx devuelve 0 = activa, 1 = en duda, 2 = cancelada, 3 = confirmada.
func (bd *BD) estadoTx(tx uint32) int {
	if tx == 0 {
		return 3
	}
	i := int(tx / bd.tpp)
	if i >= len(bd.tip) {
		return 0
	}
	p := bd.pagina(bd.tip[i])
	n := tx % bd.tpp
	return int(p[20+n/4]>>(2*(n%4))) & 3
}

// datosCompletos junta los fragmentos de un registro.
func (bd *BD) datosCompletos(r registro) []byte {
	if r.flags&flagIncompleto == 0 {
		return r.datos
	}
	partes := append([]byte(nil), r.datos...)
	cur := r
	for n := 0; cur.flags&flagIncompleto != 0; n++ {
		if n > 4000 {
			fallo("Cadena de fragmentos demasiado larga (archivo dañado).")
		}
		cur = bd.registroEn(cur.fpagina, int(cur.flinea))
		partes = append(partes, cur.datos...)
	}
	return partes
}

// versionVigente devuelve los datos (ya descomprimidos) de la última versión CONFIRMADA de un
// registro y su formato. ok=false si el registro está borrado o nunca llegó a confirmarse.
func (bd *BD) versionVigente(cabeza registro) (datos []byte, formato uint8, ok bool) {
	r := cabeza
	var datosR []byte
	tengoR := false
	for guarda := 0; ; guarda++ {
		if guarda > 100000 {
			fallo("Cadena de versiones demasiado larga (archivo dañado).")
		}
		borrado := r.flags&flagBorrado != 0
		if bd.estadoTx(r.tx) == 3 {
			if borrado {
				return nil, 0, false
			}
			if !tengoR {
				datosR = descomprimir(bd.datosCompletos(r))
			}
			return datosR, r.formato, true
		}
		// versión sin confirmar (activa, cancelada o en duda): se baja a la anterior
		if r.bpagina == 0 {
			return nil, 0, false
		}
		b := bd.registroEn(r.bpagina, int(r.blinea))
		var datosB []byte
		tengoB := false
		if r.flags&flagDelta != 0 {
			if borrado {
				fallo("Registro con diferencias sobre uno borrado (archivo dañado).")
			}
			if !tengoR {
				datosR = descomprimir(bd.datosCompletos(r))
			}
			cinta := descomprimir(bd.datosCompletos(b))
			datosB = aplicarDiferencias(datosR, cinta)
			tengoB = true
		} else if b.flags&flagBorrado == 0 {
			datosB = descomprimir(bd.datosCompletos(b))
			tengoB = true
		}
		r, datosR, tengoR = b, datosB, tengoB
	}
}

// cabezas recorre los registros "cabeza" de una tabla (uno por fila, sea o no vigente).
func (bd *BD) cabezas(rel int, f func(registro)) {
	ptrs := bd.ptrDe[rel]
	if len(ptrs) == 0 {
		return
	}
	vistas := map[uint32]bool{}
	for _, r := range bd.ranuras(ptrs[0]) {
		if r.pagina == 0 || vistas[r.pagina] {
			continue
		}
		vistas[r.pagina] = true
		for _, rg := range bd.registrosCrudos(r.pagina) {
			if rg.flags&(flagVersion|flagFragmento|flagBlob) != 0 {
				continue
			}
			f(rg)
		}
	}
}

// filas llama a f por cada fila vigente de la tabla con sus bytes y su formato.
func (bd *BD) filas(rel int, f func(datos []byte, formato uint8)) {
	bd.cabezas(rel, func(h registro) {
		if d, fm, ok := bd.versionVigente(h); ok {
			f(d, fm)
		}
	})
}

// ---------------------------------------------------------------- blobs

// bytesBlob lee un blob guardado (nivel 0 = dentro del registro, nivel 1 = en páginas de blob).
func (bd *BD) bytesBlob(alto, bajo uint32) []byte {
	rel := int(alto & 0xffff)
	numReg := int64(bajo) + int64(alto>>16)<<32
	ranura := int(numReg / int64(bd.maxRec))
	linea := int(numReg % int64(bd.maxRec))
	ptrs := bd.ptrDe[rel]
	if len(ptrs) == 0 {
		fallo("No encontré un dato largo (blob) que la base necesita.")
	}
	var dp uint32
	for _, r := range bd.ranuras(ptrs[0]) {
		if r.global == ranura {
			dp = r.pagina
			break
		}
	}
	if dp == 0 {
		fallo("No encontré un dato largo (blob) que la base necesita.")
	}
	rr := bd.registroEn(dp, linea)
	if rr.flags&flagBlob == 0 {
		fallo("Un dato largo (blob) no tiene el formato esperado (archivo dañado).")
	}
	raw := rr.crudo
	if len(raw) < 28 {
		fallo("Dato largo (blob) incompleto (archivo dañado).")
	}
	nivel := raw[12]
	largo := int(le.Uint32(raw[20:]))
	var flujo []byte
	switch nivel {
	case 0:
		flujo = raw[28:]
	case 1:
		for pos := 28; pos+4 <= len(raw); pos += 4 {
			pn := le.Uint32(raw[pos:])
			if pn == 0 {
				break
			}
			p := bd.pagina(pn)
			if p[0] != 8 {
				fallo("Una página de dato largo (blob) no es del tipo esperado (archivo dañado).")
			}
			n := int(le.Uint16(p[24:]))
			if 28+n > len(p) {
				fallo("Página de dato largo (blob) con tamaño imposible (archivo dañado).")
			}
			flujo = append(flujo, p[28:28+n]...)
		}
	default:
		fallo("Un dato largo (blob) de nivel %d no está soportado.", nivel)
	}
	// el flujo son segmentos: 2 bytes de largo + datos
	out := make([]byte, 0, largo)
	for pos := 0; pos+2 <= len(flujo) && len(out) < largo; {
		sl := int(le.Uint16(flujo[pos:]))
		fin := pos + 2 + sl
		if fin > len(flujo) {
			fin = len(flujo)
		}
		out = append(out, flujo[pos+2:fin]...)
		pos = pos + 2 + sl
	}
	if len(out) > largo {
		out = out[:largo]
	}
	return out
}
