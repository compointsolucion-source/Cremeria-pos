package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

func itoa(n int) string { return strconv.Itoa(n) }

var (
	logMu   sync.Mutex
	logRuta string
)

// rutaLog es el archivo para soporte: %TEMP%\CompointInstalador\instalador-log.txt
func rutaLog() string {
	if logRuta != "" {
		return logRuta
	}
	return filepath.Join(os.TempDir(), "CompointInstalador", "instalador-log.txt")
}

func registrar(texto string) {
	logMu.Lock()
	defer logMu.Unlock()
	ruta := rutaLog()
	_ = os.MkdirAll(filepath.Dir(ruta), 0o755)
	if st, err := os.Stat(ruta); err == nil && st.Size() > 512*1024 {
		_ = os.Rename(ruta, ruta+".viejo")
	}
	f, err := os.OpenFile(ruta, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), texto)
}

func copiaPasos(p []Paso) []Paso { return append([]Paso(nil), p...) }
