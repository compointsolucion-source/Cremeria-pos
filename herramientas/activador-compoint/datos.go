package main

// Lista de clientes, códigos emitidos y respaldos. Se guarda en datos.json (junto a la llave).
// Cada guardado es atómico (se escribe a un archivo temporal y se renombra) y deja la copia
// anterior como datos.json.bak, para que un corte de luz no deje el archivo a medias.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Cliente struct {
	ID           int               `json:"id"`
	Negocio      string            `json:"negocio"`
	Contacto     string            `json:"contacto"`
	WhatsApp     string            `json:"whatsapp"`
	Email        string            `json:"email"`
	IDEquipo     string            `json:"idEquipo"`
	Plan         string            `json:"plan"`
	Sucursales   int               `json:"sucursales"`
	Tipo         string            `json:"tipo"`
	Vence        string            `json:"vence"` // vacío = no vence
	Emitida      string            `json:"emitida"`
	UltimaSerie  uint32            `json:"ultimaSerie"`
	Creado       string            `json:"creado"`
	Actualizado  string            `json:"actualizado"`
	DatosNegocio map[string]string `json:"datosNegocio,omitempty"` // lo que mandó en su solicitud (giro, ciudad, factura…)
}

type Emitido struct {
	Serie      uint32 `json:"serie"`
	Fecha      string `json:"fecha"`
	ClienteID  int    `json:"clienteId"`
	Negocio    string `json:"negocio"`
	Tipo       string `json:"tipo"`
	Plan       string `json:"plan"`
	Sucursales int    `json:"sucursales"`
	Emitida    string `json:"emitida"`
	Vence      string `json:"vence"`
	IDEquipo   string `json:"idEquipo"`
	Codigo     string `json:"codigo"`
}

type Respaldo struct {
	Ruta  string `json:"ruta"`
	Fecha string `json:"fecha"`
	Serie uint32 `json:"serie"` // último código emitido cuando se hizo
}

type Datos struct {
	Version        int        `json:"version"`
	SiguienteSerie uint32     `json:"siguienteSerie"`
	SiguienteID    int        `json:"siguienteId"`
	Clientes       []Cliente  `json:"clientes"`
	Emitidos       []Emitido  `json:"emitidos"`
	Respaldos      []Respaldo `json:"respaldos"`
}

func datosNuevos() *Datos {
	return &Datos{Version: 1, SiguienteSerie: 1, SiguienteID: 1, Clientes: []Cliente{}, Emitidos: []Emitido{}, Respaldos: []Respaldo{}}
}

func (d *Datos) normalizar() {
	if d.Version == 0 {
		d.Version = 1
	}
	if d.SiguienteSerie == 0 {
		d.SiguienteSerie = 1
	}
	if d.SiguienteID == 0 {
		d.SiguienteID = 1
		for _, c := range d.Clientes {
			if c.ID >= d.SiguienteID {
				d.SiguienteID = c.ID + 1
			}
		}
	}
	if d.Clientes == nil {
		d.Clientes = []Cliente{}
	}
	if d.Emitidos == nil {
		d.Emitidos = []Emitido{}
	}
	if d.Respaldos == nil {
		d.Respaldos = []Respaldo{}
	}
}

func (d *Datos) clientePorID(id int) *Cliente {
	for i := range d.Clientes {
		if d.Clientes[i].ID == id {
			return &d.Clientes[i]
		}
	}
	return nil
}

// clientePorEquipo busca por el ID del equipo, sin importar cómo se escribió.
func (d *Datos) clientePorEquipo(id uint64) *Cliente {
	for i := range d.Clientes {
		if v, ok := leerIDEquipo(d.Clientes[i].IDEquipo); ok && v == id {
			return &d.Clientes[i]
		}
	}
	return nil
}

func leerDatos(ruta string) (*Datos, error) {
	b, err := os.ReadFile(ruta)
	if errors.Is(err, os.ErrNotExist) {
		return datosNuevos(), nil
	}
	if err != nil {
		return nil, err
	}
	var d Datos
	if err := json.Unmarshal(b, &d); err != nil {
		// intenta con la copia anterior
		if bak, e2 := os.ReadFile(ruta + ".bak"); e2 == nil && json.Unmarshal(bak, &d) == nil {
			d.normalizar()
			return &d, nil
		}
		return nil, errors.New("No pude leer la lista de clientes (datos.json). Hay una copia en datos.json.bak")
	}
	d.normalizar()
	return &d, nil
}

// escribirAtomico guarda el archivo sin dejarlo nunca a medias.
func escribirAtomico(ruta string, contenido []byte, conservarBak bool) error {
	if err := os.MkdirAll(filepath.Dir(ruta), 0o700); err != nil {
		return err
	}
	tmp := ruta + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(contenido); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if conservarBak {
		if previo, err := os.ReadFile(ruta); err == nil {
			_ = os.WriteFile(ruta+".bak", previo, 0o600)
		}
	}
	return os.Rename(tmp, ruta)
}

func guardarDatos(ruta string, d *Datos) error {
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return escribirAtomico(ruta, b, true)
}

// ---- limpieza de lo que escribe una persona

func limpiarTexto(t string, max int) string {
	t = strings.Join(strings.Fields(t), " ")
	if r := []rune(t); len(r) > max {
		t = string(r[:max])
	}
	return t
}
