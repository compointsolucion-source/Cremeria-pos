//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const crearSinVentana = 0x08000000 // CREATE_NO_WINDOW

func rutaPowerShell() string {
	raiz := os.Getenv("SystemRoot")
	if raiz == "" {
		raiz = `C:\Windows`
	}
	return filepath.Join(raiz, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

// elegirCarpeta muestra el selector de carpetas de Windows. Devuelve "" si el usuario cancela.
func elegirCarpeta(titulo string) (string, error) {
	titulo = strings.ReplaceAll(titulo, "'", "''")
	script := "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " +
		"Add-Type -AssemblyName System.Windows.Forms; " +
		"$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.Opacity = 0; $f.StartPosition='CenterScreen'; $f.Show(); " +
		"$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '" + titulo + "'; $d.ShowNewFolderButton = $true; " +
		"if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }; $f.Close()"
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelar()
	cmd := exec.CommandContext(ctx, rutaPowerShell(), "-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: crearSinVentana}
	salida, err := cmd.Output()
	if err != nil {
		return "", errors.New("Windows no pudo abrir el selector.")
	}
	return strings.TrimSpace(string(salida)), nil
}

// instanciaUnica evita abrir dos Activadores a la vez (los dos escribirían la misma lista).
func instanciaUnica() bool {
	k32 := syscall.NewLazyDLL("kernel32.dll")
	crear := k32.NewProc("CreateMutexW")
	nombre, _ := syscall.UTF16PtrFromString("Local\\CompointActivador")
	h, _, err := crear.Call(0, 0, uintptr(unsafe.Pointer(nombre)))
	if h == 0 {
		return true // si no se pudo crear, no estorbar
	}
	return err != syscall.ERROR_ALREADY_EXISTS
}

func abrirVentana(url string) (*exec.Cmd, error) {
	var candidatos []string
	for _, v := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		base := os.Getenv(v)
		if base == "" {
			continue
		}
		candidatos = append(candidatos,
			filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
	}
	perfil := filepath.Join(os.TempDir(), "CompointActivador", "perfil")
	for _, exe := range candidatos {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+url, "--window-size=1180,800", "--user-data-dir="+perfil,
			"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-mode")
		if err := cmd.Start(); err == nil {
			return cmd, nil
		}
	}
	// Último recurso: el navegador predeterminado (el latido cierra el programa al terminar).
	err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	return nil, err
}
