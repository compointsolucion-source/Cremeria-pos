//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

// Ventanas de Windows (aviso, elegir archivo) usando directamente la API del sistema:
// no depende de PowerShell ni de nada instalado.
var (
	user32   = syscall.NewLazyDLL("user32.dll")
	comdlg32 = syscall.NewLazyDLL("comdlg32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")

	procMessageBox    = user32.NewProc("MessageBoxW")
	procGetOpenFile   = comdlg32.NewProc("GetOpenFileNameW")
	procDialogError   = comdlg32.NewProc("CommDlgExtendedError")
	procKnownFolder   = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree = ole32.NewProc("CoTaskMemFree")
)

const (
	mbOK            = 0x00000000
	mbOKCancel      = 0x00000001
	mbIconError     = 0x00000010
	mbIconInfo      = 0x00000040
	mbSetForeground = 0x00010000
	idCancel        = 2

	ofnHideReadOnly  = 0x00000004
	ofnNoChangeDir   = 0x00000008
	ofnPathMustExist = 0x00000800
	ofnFileMustExist = 0x00001000
	ofnExplorer      = 0x00080000
)

// OPENFILENAMEW (64 bits). Se verifica el tamaño al compilar: debe medir 152 bytes.
type openFileName struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

const _ = uint(152 - unsafe.Sizeof(openFileName{})) // falla al compilar si es más chico
const _ = uint(unsafe.Sizeof(openFileName{}) - 152) // ...o más grande

type interfazWindows struct{}

func nuevaInterfaz() interfaz { return interfazWindows{} }

func cuadro(texto string, flags uintptr) uintptr {
	t, _ := syscall.UTF16PtrFromString(strings.ReplaceAll(strings.ReplaceAll(texto, "\x00", ""), "\n", "\r\n"))
	ti, _ := syscall.UTF16PtrFromString(titulo)
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(ti)), flags|mbSetForeground)
	return r
}

func (interfazWindows) confirmar(texto string) bool {
	return cuadro(texto, mbOKCancel|mbIconInfo) != idCancel
}

func (interfazWindows) mostrar(texto string, esError bool) {
	icono := uintptr(mbIconInfo)
	if esError {
		icono = mbIconError
	}
	cuadro(texto, mbOK|icono)
}

func (interfazWindows) elegirArchivo(sugerido string) (string, error) {
	ruta, err := elegirNativo(sugerido)
	if err != nil {
		// si la ventana normal falla, se intenta con la de PowerShell
		if r2, err2 := elegirConPowerShell(sugerido); err2 == nil {
			return r2, nil
		}
	}
	return ruta, err
}

func elegirNativo(sugerido string) (string, error) {
	buf := make([]uint16, 32768)
	var dirIni *uint16
	if sugerido != "" && len(sugerido) < 1000 {
		copy(buf, utf16.Encode([]rune(sugerido)))
		dirIni, _ = syscall.UTF16PtrFromString(filepath.Dir(sugerido))
	}
	filtro := utf16.Encode([]rune("Base de Eleventa (*.fdb)\x00*.fdb\x00Todos los archivos (*.*)\x00*.*\x00\x00"))
	tit, _ := syscall.UTF16PtrFromString("Elige el archivo PDVDATA.FDB de Eleventa")
	o := openFileName{
		hwndOwner:       0,
		lpstrFilter:     &filtro[0],
		nFilterIndex:    1,
		lpstrFile:       &buf[0],
		nMaxFile:        uint32(len(buf)),
		lpstrInitialDir: dirIni,
		lpstrTitle:      tit,
		flags:           ofnFileMustExist | ofnPathMustExist | ofnHideReadOnly | ofnExplorer | ofnNoChangeDir,
	}
	o.lStructSize = uint32(unsafe.Sizeof(o))
	r, _, _ := procGetOpenFile.Call(uintptr(unsafe.Pointer(&o)))
	if r == 0 {
		codigo, _, _ := procDialogError.Call()
		if codigo == 0 {
			return "", nil // la persona canceló
		}
		return "", fmt.Errorf("error %d de Windows", codigo)
	}
	return syscall.UTF16ToString(buf), nil
}

// ---------------------------------------------------------------- respaldo con PowerShell

func rutaPowerShell() string {
	raiz := os.Getenv("SystemRoot")
	if raiz == "" {
		raiz = `C:\Windows`
	}
	return filepath.Join(raiz, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func elegirConPowerShell(sugerido string) (string, error) {
	dir := ""
	if sugerido != "" {
		dir = filepath.Dir(sugerido)
	}
	script := `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Elige el archivo PDVDATA.FDB de Eleventa'
$d.Filter = 'Base de Eleventa (*.fdb)|*.fdb|Todos los archivos (*.*)|*.*'
$d.InitialDirectory = '` + strings.ReplaceAll(dir, "'", "''") + `'
if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Write-Output $d.FileName }`
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	ctx, cancelar := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelar()
	cmd := exec.CommandContext(ctx, rutaPowerShell(), "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	salida, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(salida)), nil
}

// ---------------------------------------------------------------- carpetas

// carpetaConocida pregunta a Windows por una carpeta especial (la del Escritorio puede estar en OneDrive).
func carpetaConocida(id *syscall.GUID) string {
	var p *uint16
	r, _, _ := procKnownFolder.Call(uintptr(unsafe.Pointer(id)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if r != 0 || p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	var out []uint16
	for i := 0; i < 32768; i++ {
		c := *(*uint16)(unsafe.Add(unsafe.Pointer(p), i*2))
		if c == 0 {
			break
		}
		out = append(out, c)
	}
	return string(utf16.Decode(out))
}

func (interfazWindows) carpetaSalida() string {
	nombre := "Eleventa para Compoint"
	desktop := syscall.GUID{Data1: 0xB4BFCC3A, Data2: 0xDB2C, Data3: 0x424C,
		Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}}
	var bases []string
	if d := carpetaConocida(&desktop); d != "" {
		bases = append(bases, d)
	}
	if h, err := os.UserHomeDir(); err == nil {
		bases = append(bases, filepath.Join(h, "Desktop"), filepath.Join(h, "Escritorio"), h)
	}
	if exe, err := os.Executable(); err == nil {
		bases = append(bases, filepath.Dir(exe))
	}
	bases = append(bases, os.TempDir())
	for _, b := range bases {
		if st, err := os.Stat(b); err == nil && st.IsDir() {
			ruta := filepath.Join(b, nombre)
			if os.MkdirAll(ruta, 0o755) == nil {
				return ruta
			}
		}
	}
	return filepath.Join(os.TempDir(), nombre)
}

func (interfazWindows) abrirCarpeta(ruta string) {
	_ = exec.Command("explorer.exe", ruta).Start()
}

// errorDeUso: otro programa (Eleventa/Firebird) tiene el archivo abierto y no lo comparte.
func (interfazWindows) errorDeUso(err error) bool {
	var n syscall.Errno
	if errors.As(err, &n) {
		return n == 32 || n == 33 // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
	}
	return false
}
