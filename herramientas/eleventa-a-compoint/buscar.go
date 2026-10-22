package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// buscarFDB intenta encontrar el PDVDATA.FDB de Eleventa en los lugares donde suele estar,
// para que la ventana de "elegir archivo" ya lo traiga seleccionado. Si no lo encuentra, "".
func buscarFDB() string {
	var raices []string
	agregar := func(p string) {
		if p != "" {
			raices = append(raices, p)
		}
	}
	agregar(os.Getenv("ProgramData"))
	agregar(`C:\Eleventa`)
	agregar(os.Getenv("ProgramFiles"))
	agregar(os.Getenv("ProgramFiles(x86)"))
	agregar(os.Getenv("PUBLIC"))
	if h, err := os.UserHomeDir(); err == nil {
		for _, s := range []string{"Documents", "Documentos", "Desktop", "Escritorio", "Downloads", "Descargas"} {
			agregar(filepath.Join(h, s))
		}
	}
	limite := time.Now().Add(4 * time.Second)
	for _, r := range raices {
		if p := buscarEn(r, 4, limite); p != "" {
			return p
		}
	}
	return ""
}

func buscarEn(raiz string, prof int, limite time.Time) string {
	if st, err := os.Stat(raiz); err != nil || !st.IsDir() {
		return ""
	}
	encontrado := ""
	nivelRaiz := strings.Count(filepath.Clean(raiz), string(os.PathSeparator))
	_ = filepath.WalkDir(raiz, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if time.Now().After(limite) {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if strings.Count(filepath.Clean(p), string(os.PathSeparator))-nivelRaiz >= prof {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(d.Name(), "PDVDATA.FDB") {
			encontrado = p
			return filepath.SkipAll
		}
		return nil
	})
	return encontrado
}
