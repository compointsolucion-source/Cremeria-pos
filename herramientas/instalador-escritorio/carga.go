package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// El instalador de Compoint es un .exe que lleva pegado al final el instalador del programa
// (el "paquete"). Así queda un solo archivo para entregar al cliente.
//
//	[ este programa ][ paquete (bytes) ][ meta (JSON) ][ pie de 64 bytes ]
//
// Pie (64 bytes):  0-7 "CPTINST1" · 8-15 largo del paquete (uint64) · 16-23 largo del meta (uint64)
//
//	24-55 sha256 del paquete · 56-63 "CPTFIN01"
//
// (el mismo formato lo arma escritorio/scripts/empaquetar-instalador.js)
const (
	magiaIni = "CPTINST1"
	magiaFin = "CPTFIN01"
	tamPie   = 64
)

var errSinCarga = errors.New("este programa no trae el paquete de instalación")

// Carga es el paquete que viene dentro del .exe.
type Carga struct {
	ruta   string
	inicio int64
	largo  int64
	sha    [32]byte
	Meta   Meta
}

func abrirCarga(ruta string) (*Carga, error) {
	f, err := os.Open(ruta)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	tam := st.Size()
	if tam < tamPie {
		return nil, errSinCarga
	}
	pie := make([]byte, tamPie)
	if _, err := f.ReadAt(pie, tam-tamPie); err != nil {
		return nil, err
	}
	if string(pie[0:8]) != magiaIni || string(pie[56:64]) != magiaFin {
		return nil, errSinCarga
	}
	largo := binary.LittleEndian.Uint64(pie[8:16])
	largoMeta := binary.LittleEndian.Uint64(pie[16:24])
	if largo == 0 || largoMeta == 0 || largoMeta > 64*1024 || largo > uint64(tam) || largo+largoMeta+tamPie > uint64(tam) {
		return nil, errors.New("el paquete está dañado")
	}
	inicio := tam - tamPie - int64(largoMeta) - int64(largo)
	bm := make([]byte, largoMeta)
	if _, err := f.ReadAt(bm, inicio+int64(largo)); err != nil {
		return nil, err
	}
	var meta Meta
	if err := json.Unmarshal(bm, &meta); err != nil {
		return nil, fmt.Errorf("los datos del paquete están dañados: %v", err)
	}
	c := &Carga{ruta: ruta, inicio: inicio, largo: int64(largo), Meta: meta}
	copy(c.sha[:], pie[24:56])
	c.Meta.TamanoPaquete = int64(largo)
	return c, nil
}

// Extraer copia el paquete a `destino`, avisando el avance, y comprueba que llegó completo.
func (c *Carga) Extraer(destino string, progreso func(hecho, total int64)) error {
	f, err := os.Open(c.ruta)
	if err != nil {
		return err
	}
	defer f.Close()
	sal, err := os.OpenFile(destino, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	lector := io.NewSectionReader(f, c.inicio, c.largo)
	buf := make([]byte, 1<<20)
	var hecho int64
	for {
		n, err := lector.Read(buf)
		if n > 0 {
			if _, e2 := sal.Write(buf[:n]); e2 != nil {
				sal.Close()
				os.Remove(destino)
				return e2
			}
			h.Write(buf[:n])
			hecho += int64(n)
			if progreso != nil {
				progreso(hecho, c.largo)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			sal.Close()
			os.Remove(destino)
			return err
		}
	}
	if err := sal.Close(); err != nil {
		os.Remove(destino)
		return err
	}
	var suma [32]byte
	copy(suma[:], h.Sum(nil))
	if suma != c.sha || hecho != c.largo {
		os.Remove(destino)
		return errors.New("El instalador está incompleto o dañado (la descarga pudo cortarse). Descárgalo otra vez.")
	}
	return nil
}

// escribirCarga arma un .exe con paquete: copia `base`, le pega `paquete`, el meta y el pie.
// (Lo usan las pruebas; en producción lo hace escritorio/scripts/empaquetar-instalador.js.)
func escribirCarga(destino, base string, paquete []byte, meta Meta) error {
	b, err := os.ReadFile(base)
	if err != nil {
		return err
	}
	bm, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	pie := make([]byte, tamPie)
	copy(pie[0:8], magiaIni)
	binary.LittleEndian.PutUint64(pie[8:16], uint64(len(paquete)))
	binary.LittleEndian.PutUint64(pie[16:24], uint64(len(bm)))
	suma := sha256.Sum256(paquete)
	copy(pie[24:56], suma[:])
	copy(pie[56:64], magiaFin)
	salida := make([]byte, 0, len(b)+len(paquete)+len(bm)+tamPie)
	salida = append(salida, b...)
	salida = append(salida, paquete...)
	salida = append(salida, bm...)
	salida = append(salida, pie...)
	return os.WriteFile(destino, salida, 0o755)
}
