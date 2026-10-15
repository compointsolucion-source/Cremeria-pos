//go:build windows

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const crearSinVentana = 0x08000000 // CREATE_NO_WINDOW

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives      = kernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW         = kernel32.NewProc("GetDriveTypeW")
	procGetDiskFreeSpaceExW   = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetVolumeInformationW = kernel32.NewProc("GetVolumeInformationW")
	procSetErrorMode          = kernel32.NewProc("SetErrorMode")
	procCreateMutexW          = kernel32.NewProc("CreateMutexW")
	shell32                   = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteEx        = shell32.NewProc("ShellExecuteExW")
	procSHGetKnownFolderPath  = shell32.NewProc("SHGetKnownFolderPath")
	ole32                     = syscall.NewLazyDLL("ole32.dll")
	procCoTaskMemFree         = ole32.NewProc("CoTaskMemFree")
	advapi32                  = syscall.NewLazyDLL("advapi32.dll")
	procGetTokenInformation   = advapi32.NewProc("GetTokenInformation")
)

type sistemaWindows struct {
	mu          sync.Mutex
	cacheUnid   []Unidad
	cacheCuando time.Time
}

func nuevoSistemaReal() Sistema {
	procSetErrorMode.Call(0x0001 | 0x8000) // sin ventanas de «no hay disco» ni de error crítico
	return &sistemaWindows{}
}

// ---------------------------------------------------------------- Una sola ventana a la vez

func unaInstancia() bool {
	nombre, _ := syscall.UTF16PtrFromString(`Local\CompointInstaladorPunto`)
	h, _, e := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(nombre)))
	if h == 0 {
		return true
	}
	if errno, ok := e.(syscall.Errno); ok && errno == 183 { // ERROR_ALREADY_EXISTS
		return false
	}
	return true // el candado queda tomado mientras viva el programa
}

// ---------------------------------------------------------------- Datos del equipo

func (s *sistemaWindows) Defaults() Predeterminados {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	unidad := os.Getenv("SystemDrive")
	if unidad == "" {
		unidad = "C:"
	}
	return Predeterminados{
		Programa: norm(filepath.Join(local, "Programs", subcarpetaProg)),
		Base:     norm(unidad + `\CompointPunto`),
	}
}

func (s *sistemaWindows) Equipo() string {
	n, _ := os.Hostname()
	return n
}

func (s *sistemaWindows) TempUnidad() string { return letraDe(os.TempDir()) }

func (s *sistemaWindows) EsAdmin() bool {
	p, err := syscall.GetCurrentProcess()
	if err != nil {
		return false
	}
	var tok syscall.Token
	if err := syscall.OpenProcessToken(p, syscall.TOKEN_QUERY, &tok); err != nil {
		return false
	}
	defer tok.Close()
	var elevado, n uint32
	const tokenElevation = 20
	r, _, _ := procGetTokenInformation.Call(uintptr(tok), tokenElevation, uintptr(unsafe.Pointer(&elevado)), 4, uintptr(unsafe.Pointer(&n)))
	return r != 0 && elevado != 0
}

// ---------------------------------------------------------------- Discos

func leerUnidad(letra string) *Unidad {
	raiz, _ := syscall.UTF16PtrFromString(letra + `\`)
	t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(raiz)))
	var tipo string
	switch t {
	case 2: // removible: USB, tarjetas (se salta A: y B: por si hay disquetera)
		if letra == "A:" || letra == "B:" {
			return nil
		}
		tipo = "usb"
	case 3:
		tipo = "fijo"
	case 4:
		tipo = "red"
	default:
		return nil // lector de CD, disco en RAM, sin dato
	}
	var libreUsuario, total, libreTotal uint64
	r, _, _ := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(raiz)),
		uintptr(unsafe.Pointer(&libreUsuario)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&libreTotal)))
	if r == 0 {
		return nil // sin disco dentro o sin acceso
	}
	etiqueta := make([]uint16, 261)
	procGetVolumeInformationW.Call(uintptr(unsafe.Pointer(raiz)), uintptr(unsafe.Pointer(&etiqueta[0])), uintptr(len(etiqueta)), 0, 0, 0, 0, 0)
	return &Unidad{Letra: letra, Etiqueta: syscall.UTF16ToString(etiqueta), Tipo: tipo, Libre: int64(libreUsuario), Total: int64(total)}
}

func (s *sistemaWindows) Unidades() []Unidad {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cacheUnid != nil && time.Since(s.cacheCuando) < 2*time.Second {
		return append([]Unidad(nil), s.cacheUnid...)
	}
	mascara, _, _ := procGetLogicalDrives.Call()
	type resp struct{ u *Unidad }
	var canales []chan resp
	for i := 0; i < 26; i++ {
		if mascara&(1<<uint(i)) == 0 {
			continue
		}
		letra := string(rune('A'+i)) + ":"
		c := make(chan resp, 1)
		canales = append(canales, c)
		go func() { c <- resp{leerUnidad(letra)} }()
	}
	limite := time.After(4 * time.Second) // un disco de red que no responde no debe trabar todo
	var lista []Unidad
	for _, c := range canales {
		select {
		case r := <-c:
			if r.u != nil {
				lista = append(lista, *r.u)
			}
		case <-limite:
		}
	}
	sort.Slice(lista, func(i, j int) bool { return lista[i].Letra < lista[j].Letra })
	s.cacheUnid, s.cacheCuando = lista, time.Now()
	return append([]Unidad(nil), lista...)
}

// ---------------------------------------------------------------- Carpetas

func nombresVacios(nombres []string) bool {
	for _, n := range nombres {
		switch strings.ToLower(n) {
		case "desktop.ini", "thumbs.db", ".ds_store":
		default:
			return false
		}
	}
	return true
}

func existeArchivo(r string) bool {
	st, err := os.Stat(r)
	return err == nil && !st.IsDir()
}

// probarEscritura: ¿se puede guardar ahí? Una carpeta que no existe se prueba en la más cercana que sí.
func probarEscritura(ruta string) bool {
	r := ruta
	for {
		st, err := os.Stat(r)
		if err == nil {
			if st.IsDir() {
				break
			}
			return false
		}
		p := padreDe(r)
		if p == "" || p == r {
			return false
		}
		r = p
	}
	if mismaRuta(r, ruta) {
		if f, err := os.CreateTemp(r, ".compoint-prueba-*"); err == nil {
			f.Close()
			os.Remove(f.Name())
			return true
		}
	}
	if d, err := os.MkdirTemp(r, ".compoint-prueba-*"); err == nil {
		os.Remove(d)
		return true
	}
	return false
}

func (s *sistemaWindows) InfoRuta(ruta string) InfoRuta {
	var i InfoRuta
	st, err := os.Stat(ruta)
	if err == nil {
		i.Existe, i.EsCarpeta = true, st.IsDir()
		if i.EsCarpeta {
			if f, err := os.Open(ruta); err == nil {
				nombres, _ := f.Readdirnames(60)
				f.Close()
				i.Vacia = nombresVacios(nombres)
			}
			i.TieneBD = existeArchivo(filepath.Join(ruta, "PG_VERSION"))
			i.TienePrograma = existeArchivo(filepath.Join(ruta, nombreProgramaExe)) || existeArchivo(filepath.Join(ruta, "Uninstall "+nombreProgramaExe))
		}
	}
	i.Escribible = probarEscritura(ruta)
	return i
}

func esOculto(info fs.FileInfo) bool {
	if a, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return a.FileAttributes&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
	}
	return false
}

func (s *sistemaWindows) Listar(ruta string) (Listado, error) {
	l := Listado{Unidades: s.Unidades(), Carpetas: []Entrada{}}
	r := norm(ruta)
	if r == "" {
		return l, nil
	}
	// Si la carpeta no existe se muestra la más cercana que sí.
	for {
		st, err := os.Stat(r)
		if err == nil && st.IsDir() {
			break
		}
		p := padreDe(r)
		if p == "" {
			return l, nil
		}
		r = p
	}
	ents, err := os.ReadDir(r)
	if err != nil {
		return l, errors.New("No se puede abrir esa carpeta: " + err.Error())
	}
	l.Ruta, l.Padre = r, padreDe(r)
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil && esOculto(info) {
			continue
		}
		if len(l.Carpetas) >= 500 {
			l.Cortado = true
			break
		}
		l.Carpetas = append(l.Carpetas, Entrada{Nombre: e.Name(), Ruta: unir(r, e.Name())})
	}
	sort.Slice(l.Carpetas, func(i, j int) bool {
		return strings.ToLower(l.Carpetas[i].Nombre) < strings.ToLower(l.Carpetas[j].Nombre)
	})
	l.Info = s.InfoRuta(r)
	return l, nil
}

func (s *sistemaWindows) CrearCarpeta(ruta string) error {
	if err := os.Mkdir(ruta, 0o755); err != nil {
		switch {
		case errors.Is(err, fs.ErrExist):
			return errors.New("Ya existe una carpeta con ese nombre.")
		case errors.Is(err, fs.ErrPermission):
			return errors.New("No tienes permiso para crear carpetas ahí.")
		}
		return errors.New("No se pudo crear la carpeta: " + err.Error())
	}
	return nil
}

// ---------------------------------------------------------------- Lo que ya hay en el equipo

func (s *sistemaWindows) DatosExistentes() string {
	var candidatos []string
	if b, err := os.ReadFile(filepath.Join(os.Getenv("APPDATA"), "Compoint Punto", "config.json")); err == nil {
		var c struct {
			CarpetaDatos string `json:"carpetaDatos"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(string(b), "\uFEFF")), &c) == nil && c.CarpetaDatos != "" {
			candidatos = append(candidatos, norm(c.CarpetaDatos))
		}
	}
	candidatos = append(candidatos, unir(s.Defaults().Base, "datos"))
	for _, c := range candidatos {
		if existeArchivo(filepath.Join(c, "PG_VERSION")) {
			return c
		}
	}
	return ""
}

func (s *sistemaWindows) YaInstalado() string {
	var bases []string
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		bases = append(bases, filepath.Join(v, "Programs"))
	}
	for _, e := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		if v := os.Getenv(e); v != "" {
			bases = append(bases, v)
		}
	}
	for _, b := range bases {
		d := filepath.Join(b, subcarpetaProg)
		if existeArchivo(filepath.Join(d, nombreProgramaExe)) {
			return norm(d)
		}
	}
	return ""
}

func (s *sistemaWindows) AppAbierta() bool {
	ctx, cancelar := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancelar()
	cmd := exec.CommandContext(ctx, "tasklist", "/FI", "IMAGENAME eq "+nombreProgramaExe, "/NH", "/FO", "CSV")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: crearSinVentana}
	salida, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(salida)), strings.ToLower(nombreProgramaExe))
}

// ---------------------------------------------------------------- Ejecutar el instalador del programa

type shellExecuteInfo struct {
	cbSize         uint32
	fMask          uint32
	hwnd           uintptr
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       uintptr
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      uintptr
	dwHotKey       uint32
	hIconOrMonitor uintptr
	hProcess       uintptr
}

// lanzar ejecuta un programa y devuelve su identificador para esperarlo. Con elevado=true Windows
// pregunta «¿Permitir?» (permiso de administrador).
func lanzar(archivo, parametros, carpeta string, elevado bool) (syscall.Handle, error) {
	verbo := "open"
	if elevado {
		verbo = "runas"
	}
	v, _ := syscall.UTF16PtrFromString(verbo)
	f, _ := syscall.UTF16PtrFromString(archivo)
	p, _ := syscall.UTF16PtrFromString(parametros)
	d, _ := syscall.UTF16PtrFromString(carpeta)
	var info shellExecuteInfo
	info.cbSize = uint32(unsafe.Sizeof(info))
	info.fMask = 0x00000040 | 0x00000100 // SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
	info.lpVerb, info.lpFile, info.lpParameters, info.lpDirectory = v, f, p, d
	info.nShow = 0 // SW_HIDE: el instalador del programa trabaja en silencio
	r, _, e := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		if errno, ok := e.(syscall.Errno); ok && errno == 1223 { // ERROR_CANCELLED
			return 0, errPermisoDenegado
		}
		return 0, fmt.Errorf("No se pudo iniciar el instalador del programa: %v", e)
	}
	if info.hProcess == 0 {
		return 0, errors.New("Windows no devolvió el proceso del instalador.")
	}
	return syscall.Handle(info.hProcess), nil
}

func tamanoCarpeta(raiz string, limite time.Duration) int64 {
	fin := time.Now().Add(limite)
	var total int64
	_ = filepath.WalkDir(raiz, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if time.Now().After(fin) {
			return fs.SkipAll
		}
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

func encontrarExe(programa string) (exe, carpeta string) {
	for _, c := range []string{programa, filepath.Join(programa, subcarpetaProg)} {
		e := filepath.Join(c, nombreProgramaExe)
		if existeArchivo(e) {
			return e, norm(c)
		}
	}
	return "", ""
}

// ---------------------------------------------------------------- Accesos directos

type guid struct {
	D1 uint32
	D2 uint16
	D3 uint16
	D4 [8]byte
}

func parseGUID(t string) guid {
	t = strings.ReplaceAll(t, "-", "")
	b, _ := hex.DecodeString(t)
	var g guid
	if len(b) != 16 {
		return g
	}
	g.D1 = uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	g.D2 = uint16(b[4])<<8 | uint16(b[5])
	g.D3 = uint16(b[6])<<8 | uint16(b[7])
	copy(g.D4[:], b[8:])
	return g
}

func ptrATexto(p *uint16) string {
	if p == nil {
		return ""
	}
	var u []uint16
	for i := uintptr(0); ; i += 2 {
		c := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p)) + i))
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

func carpetaConocida(id string) string {
	g := parseGUID(id)
	var p *uint16
	hr, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&g)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if hr != 0 || p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return ptrATexto(p)
}

const (
	idEscritorio       = "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"
	idEscritorioPubl   = "C4AA340D-F20F-4863-AFEF-F87EF2E6BA25"
	idProgramas        = "A77F5D77-2E2B-44C3-A6A2-ABA601054A51"
	idProgramasComunes = "0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8"
)

// quitarAcceso borra «Compoint Punto.lnk» de las carpetas indicadas. Devuelve lo que no se pudo borrar.
func quitarAcceso(ids ...string) (quitados int, pendientes []string) {
	for _, id := range ids {
		c := carpetaConocida(id)
		if c == "" {
			continue
		}
		lnk := filepath.Join(c, nombreAcceso)
		if _, err := os.Stat(lnk); err != nil {
			continue
		}
		if err := os.Remove(lnk); err != nil {
			registrar("No se pudo quitar " + lnk + ": " + err.Error())
			pendientes = append(pendientes, lnk)
		} else {
			quitados++
		}
	}
	return
}

// ---------------------------------------------------------------- Instalar

func esProgramFiles(r string) bool {
	for _, v := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		if p := os.Getenv(v); p != "" && dentroDe(r, p) {
			return true
		}
	}
	return false
}

func (s *sistemaWindows) Instalar(op Opciones, meta Meta, carga *Carga, avance func(fase string, pasos []Paso, pct int)) (Resumen, error) {
	res := Resumen{Uso: op.Uso, Modo: op.Modo, Programa: op.Programa}
	pasos := pasosDe(op)
	pct := 0
	emitir := func(fase string) { avance(fase, copiaPasos(pasos), pct) }
	marcar := func(i int, estado, detalle string) {
		pasos[i].Estado = estado
		if detalle != "" {
			pasos[i].Detalle = detalle
		}
		emitir("")
	}
	fallo := func(i int, err error) (Resumen, error) {
		pasos[i].Estado, pasos[i].Detalle = "error", err.Error()
		emitir("")
		registrar(fmt.Sprintf("Paso %s falló: %v", pasos[i].Clave, err))
		return res, err
	}
	if carga == nil {
		return res, errors.New("Este instalador está incompleto (no trae el programa). Descárgalo otra vez.")
	}
	if s.AppAbierta() {
		return res, errors.New("Compoint Punto está abierto. Ciérralo (junto al reloj: clic derecho en su icono → Salir por completo) y vuelve a intentarlo.")
	}
	necesitaAdmin := !s.EsAdmin() && !probarEscritura(op.Programa)
	porEquipo := necesitaAdmin || esProgramFiles(op.Programa)
	res.Elevado = porEquipo
	emitir("trabajando")

	// ---- 1 · carpetas
	marcar(0, "haciendo", "")
	hacer := func(ruta string) error {
		if err := os.MkdirAll(ruta, 0o755); err != nil {
			return fmt.Errorf("No se pudo crear la carpeta %s (%v).", ruta, err)
		}
		return nil
	}
	if !necesitaAdmin {
		if err := hacer(op.Programa); err != nil {
			return fallo(0, err)
		}
	}
	if op.Uso == "servidor" {
		for _, c := range []string{op.Datos, op.Respaldos} {
			if err := hacer(c); err != nil {
				return fallo(0, err)
			}
		}
		if op.CopiaExtraOn && op.CopiaExtra != "" {
			if err := hacer(op.CopiaExtra); err != nil {
				return fallo(0, fmt.Errorf("No se pudo preparar la copia extra: %v Revisa que la USB o la carpeta de red estén conectadas.", err))
			}
		}
	}
	pct = 4
	marcar(0, "ok", "Carpetas listas")

	// ---- 2 · copiar (sacar el instalador del programa y correrlo)
	marcar(1, "haciendo", "Preparando el instalador…")
	temp := filepath.Join(os.TempDir(), "CompointInstalador")
	_ = os.MkdirAll(temp, 0o755)
	trabajo, err := os.MkdirTemp(temp, "p-*")
	if err != nil {
		return fallo(1, fmt.Errorf("No se pudo preparar una carpeta temporal: %v", err))
	}
	defer os.RemoveAll(trabajo)
	nombre := filepath.Base(meta.Archivo)
	if nombre == "" || nombre == "." || !strings.HasSuffix(strings.ToLower(nombre), ".exe") {
		nombre = "Instalador-CompointPunto.exe"
	}
	paquete := filepath.Join(trabajo, nombre)
	if err := carga.Extraer(paquete, func(hecho, total int64) {
		p := 4 + int(float64(hecho)/float64(total)*36)
		if p > pct {
			pct = p
			avance("", nil, pct)
		}
	}); err != nil {
		return fallo(1, err)
	}
	pct = 40
	marcar(1, "haciendo", "Copiando los archivos del programa…")

	params := "/S"
	if porEquipo {
		params += " /allusers"
	} else {
		params += " /currentuser"
	}
	params += " /D=" + op.Programa // /D= siempre al final y sin comillas
	registrar("Ejecutando instalador del programa: " + nombre + " " + params)
	if necesitaAdmin {
		emitir("esperando-permiso")
	}
	h, err := lanzar(paquete, params, trabajo, necesitaAdmin)
	if err != nil {
		return fallo(1, err)
	}
	defer syscall.CloseHandle(h)
	if necesitaAdmin {
		emitir("trabajando")
	}
	esperado := meta.TamanoInstalado
	if esperado <= 0 {
		esperado = 450 * mb
	}
	inicio := time.Now()
	for {
		ev, _ := syscall.WaitForSingleObject(h, 1000)
		if ev == syscall.WAIT_OBJECT_0 {
			break
		}
		if time.Since(inicio) > 25*time.Minute {
			return fallo(1, errors.New("El instalador del programa tardó demasiado. Revisa que tu antivirus no lo esté bloqueando y vuelve a intentarlo."))
		}
		// avance real: cuánto ya se copió a la carpeta del programa
		hecho := tamanoCarpeta(op.Programa, 700*time.Millisecond)
		p := 40 + int(float64(minInt64(hecho, esperado))/float64(esperado)*48)
		if p > pct {
			pct = p
			avance("", nil, pct)
		}
	}
	var codigo uint32
	if err := syscall.GetExitCodeProcess(h, &codigo); err != nil {
		return fallo(1, fmt.Errorf("No se pudo saber cómo terminó el instalador del programa: %v", err))
	}
	if codigo != 0 {
		return fallo(1, fmt.Errorf("El instalador del programa terminó con un error (código %d). Cierra Compoint Punto si está abierto y vuelve a intentarlo.", codigo))
	}
	exe, carpetaReal := encontrarExe(op.Programa)
	if exe == "" {
		return fallo(1, fmt.Errorf("El programa se copió pero no encuentro «%s» en %s. Avisa a Compoint.", nombreProgramaExe, op.Programa))
	}
	res.Exe, res.Programa = exe, carpetaReal
	pct = 90
	marcar(1, "ok", tamanoLegible(tamanoCarpeta(carpetaReal, 5*time.Second))+" copiados")

	// ---- 3 · accesos directos y arranque con Windows
	marcar(2, "haciendo", "")
	var pendientes []string
	if !op.Escritorio {
		_, p := quitarAcceso(idEscritorio, idEscritorioPubl)
		pendientes = append(pendientes, p...)
	}
	if !op.Inicio {
		_, p := quitarAcceso(idProgramas, idProgramasComunes)
		pendientes = append(pendientes, p...)
	}
	var queda []string
	if op.Escritorio {
		queda = append(queda, "escritorio")
	}
	if op.Inicio {
		queda = append(queda, "menú Inicio")
	}
	if op.AbrirConWindows {
		queda = append(queda, "arranque con Windows")
	}
	detalle := "Sin accesos directos"
	if len(queda) > 0 {
		detalle = strings.Join(queda, " · ")
	}
	pct = 94
	if len(pendientes) > 0 {
		res.Avisos = append(res.Avisos, "No se pudo quitar un acceso directo (Windows pide permiso de administrador para borrarlo). Puedes borrarlo a mano: "+strings.Join(pendientes, ", "))
		marcar(2, "aviso", detalle+" — un acceso no se pudo quitar")
	} else {
		marcar(2, "ok", detalle)
	}

	// ---- 4 · configuración que lee la aplicación al abrir
	marcar(3, "haciendo", "")
	datos, err := construirInstalacion(op, s.Defaults().Base)
	if err != nil {
		return fallo(3, err)
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return fallo(3, errors.New("Windows no indicó la carpeta de configuración del usuario."))
	}
	dirCfg := filepath.Join(local, "CompointPunto")
	if err := os.MkdirAll(dirCfg, 0o755); err != nil {
		return fallo(3, err)
	}
	destino := filepath.Join(dirCfg, "instalacion.json")
	tmp := destino + ".tmp"
	if err := os.WriteFile(tmp, datos, 0o644); err != nil {
		return fallo(3, err)
	}
	if err := os.Rename(tmp, destino); err != nil {
		return fallo(3, err)
	}
	if op.Uso == "servidor" {
		res.Datos, res.Respaldos = op.Datos, op.Respaldos
		if op.CopiaExtraOn {
			res.CopiaExtra = op.CopiaExtra
		}
	}
	pct = 100
	marcar(3, "ok", "Lista para abrir")
	return res, nil
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// ---------------------------------------------------------------- Abrir

func (s *sistemaWindows) Abrir(que string, r Resumen) error {
	switch que {
	case "app":
		if r.Exe == "" {
			return errors.New("No encuentro el programa instalado.")
		}
		cmd := exec.Command(r.Exe)
		cmd.Dir = filepath.Dir(r.Exe)
		return cmd.Start()
	}
	var ruta string
	switch que {
	case "programa":
		ruta = r.Programa
	case "datos":
		ruta = r.Datos
	case "respaldos":
		ruta = r.Respaldos
	case "copia":
		ruta = r.CopiaExtra
	}
	if ruta == "" {
		return errors.New("Esa carpeta no se usó.")
	}
	return exec.Command("explorer.exe", ruta).Start()
}

// ---------------------------------------------------------------- Ventana

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
	perfil := filepath.Join(os.TempDir(), "CompointInstalador", "perfil")
	for _, exe := range candidatos {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+url, "--window-size=960,760", "--user-data-dir="+perfil,
			"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-mode")
		if err := cmd.Start(); err == nil {
			return cmd, nil
		}
	}
	// Último recurso: el navegador predeterminado (el latido cierra el programa al terminar).
	err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	return nil, err
}
