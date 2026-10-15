//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
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

const crearSinVentana = 0x08000000 // CREATE_NO_WINDOW

type sistemaWindows struct{}

func nuevoSistemaReal() Sistema { return &sistemaWindows{} }

// ---------------------------------------------------------------- PowerShell

func rutaPowerShell() string {
	raiz := os.Getenv("SystemRoot")
	if raiz == "" {
		raiz = `C:\Windows`
	}
	return filepath.Join(raiz, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

// ejecutarPS corre un bloque de PowerShell sin mostrar ventana. Cualquier error del bloque
// termina en "ERROR: mensaje" y se devuelve como error de Go.
func ejecutarPS(cuerpo string) (string, error) {
	script := "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
		"try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}; " +
		"try { " + cuerpo + "\n } catch { Write-Output ('ERROR: ' + $_.Exception.Message); exit 1 }"
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	ctx, cancelar := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancelar()
	cmd := exec.CommandContext(ctx, rutaPowerShell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-OutputFormat", "Text", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: crearSinVentana}
	salida, err := cmd.CombinedOutput()
	texto := strings.TrimSpace(string(salida))
	if i := strings.LastIndex(texto, "ERROR: "); i >= 0 {
		return texto, errors.New(strings.TrimSpace(texto[i+len("ERROR: "):]))
	}
	if err != nil {
		if ctx.Err() != nil {
			return texto, errors.New("Windows tardó demasiado en responder.")
		}
		if texto == "" {
			texto = err.Error()
		}
		return texto, errors.New(texto)
	}
	return texto, nil
}

// ---------------------------------------------------------------- Detectar

const scriptEstado = `
$ErrorActionPreference='SilentlyContinue'
$lista = @()
foreach ($c in @(Get-NetIPConfiguration)) {
  if (-not $c.IPv4Address) { continue }
  if ($c.NetAdapter.Status -ne 'Up') { continue }
  $ifc = Get-NetIPInterface -InterfaceIndex $c.InterfaceIndex -AddressFamily IPv4
  $gw = ''
  if ($c.IPv4DefaultGateway) { $gw = [string]@($c.IPv4DefaultGateway)[0].NextHop }
  $dns = @($c.DnsServer.ServerAddresses | Where-Object { $_ -notmatch ':' })
  $a = @($c.IPv4Address)[0]
  $lista += [pscustomobject]@{ indice=[int]$c.InterfaceIndex; nombre=[string]$c.InterfaceAlias; ip=[string]$a.IPAddress; prefijo=[int]$a.PrefixLength; puerta=$gw; dns=$dns; dhcp=($ifc.Dhcp -eq 'Enabled') }
}
$pub = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' })
$regla = @(Get-NetFirewallRule -DisplayName 'Compoint Punto (web *)')
$puerto = 0
if ($regla.Count -gt 0) { $pf = $regla[0] | Get-NetFirewallPortFilter; $p1 = [string]@($pf.LocalPort)[0]; if ($p1 -match '^\d+$') { $puerto = [int]$p1 } }
$o = [pscustomobject]@{ equipo=$env:COMPUTERNAME; adaptadores=$lista; redPublica=($pub.Count -gt 0); reglaFirewall=($regla.Count -gt 0); puertoRegla=$puerto }
$o | ConvertTo-Json -Depth 5 -Compress
`

type estadoJSON struct {
	Equipo        string          `json:"equipo"`
	Adaptadores   json.RawMessage `json:"adaptadores"`
	RedPublica    bool            `json:"redPublica"`
	ReglaFirewall bool            `json:"reglaFirewall"`
	PuertoRegla   int             `json:"puertoRegla"`
}

func leerEstado() (Estado, error) {
	var e Estado
	salida, err := ejecutarPS(scriptEstado)
	if err != nil {
		return e, err
	}
	i, j := strings.Index(salida, "{"), strings.LastIndex(salida, "}")
	if i < 0 || j < i {
		return e, errors.New("Respuesta inesperada de Windows")
	}
	var crudo estadoJSON
	if err := json.Unmarshal([]byte(salida[i:j+1]), &crudo); err != nil {
		return e, err
	}
	e.Equipo, e.RedPublica, e.ReglaFirewall, e.PuertoRegla = crudo.Equipo, crudo.RedPublica, crudo.ReglaFirewall, crudo.PuertoRegla
	raw := strings.TrimSpace(string(crudo.Adaptadores))
	switch {
	case strings.HasPrefix(raw, "["):
		_ = json.Unmarshal([]byte(raw), &e.Adaptadores)
	case strings.HasPrefix(raw, "{"):
		var uno Adaptador
		if json.Unmarshal([]byte(raw), &uno) == nil {
			e.Adaptadores = []Adaptador{uno}
		}
	}
	return e, nil
}

func (s *sistemaWindows) Estado() (Estado, error) { return leerEstado() }

// ---------------------------------------------------------------- Permisos de administrador

var (
	shell32                 = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteEx      = shell32.NewProc("ShellExecuteExW")
	advapi32                = syscall.NewLazyDLL("advapi32.dll")
	procGetTokenInformation = advapi32.NewProc("GetTokenInformation")
)

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

func esAdministrador() bool {
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

// lanzarElevado abre este mismo programa con permisos de administrador (Windows pregunta "¿Permitir?").
func lanzarElevado(parametros string) (syscall.Handle, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	verbo, _ := syscall.UTF16PtrFromString("runas")
	archivo, _ := syscall.UTF16PtrFromString(exe)
	par, _ := syscall.UTF16PtrFromString(parametros)
	var info shellExecuteInfo
	info.cbSize = uint32(unsafe.Sizeof(info))
	info.fMask = 0x00000040 | 0x00000100 // SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
	info.lpVerb, info.lpFile, info.lpParameters = verbo, archivo, par
	info.nShow = 0 // SW_HIDE
	r, _, e := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		if errno, ok := e.(syscall.Errno); ok && errno == 1223 { // ERROR_CANCELLED
			return 0, errPermisoDenegado
		}
		return 0, fmt.Errorf("No se pudo pedir el permiso de administrador: %v", e)
	}
	return syscall.Handle(info.hProcess), nil
}

// ---------------------------------------------------------------- Ejecutar (con permisos)

func aplicarLinea(pasos []Paso, clave, estado, detalle string) {
	for i := range pasos {
		if pasos[i].Clave == clave {
			pasos[i].Estado = estado
			if detalle != "" {
				pasos[i].Detalle = detalle
			}
			return
		}
	}
}

func (s *sistemaWindows) Ejecutar(op Opciones, avance func(fase string, pasos []Paso)) error {
	pasos := pasosDe(op)

	// Ya somos administrador: se hace aquí mismo.
	if esAdministrador() {
		avance("trabajando", append([]Paso(nil), pasos...))
		return correrPasos(op, func(clave, estado, detalle string) {
			aplicarLinea(pasos, clave, estado, detalle)
			avance("", append([]Paso(nil), pasos...))
		})
	}

	datos, _ := json.Marshal(op)
	dir, err := os.MkdirTemp("", "compoint-asistente-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	ruta := filepath.Join(dir, "avance.txt")
	if err := os.WriteFile(ruta, nil, 0o644); err != nil {
		return err
	}
	parametros := "--elevado --op " + base64.StdEncoding.EncodeToString(datos) + ` --salida "` + ruta + `"`
	h, err := lanzarElevado(parametros)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	avance("trabajando", append([]Paso(nil), pasos...))

	terminado := make(chan struct{})
	go func() {
		_, _ = syscall.WaitForSingleObject(h, syscall.INFINITE)
		close(terminado)
	}()

	fin, errFin := "", ""
	leidas := 0
	leer := func() {
		b, err := os.ReadFile(ruta)
		if err != nil {
			return
		}
		lineas := strings.Split(strings.ReplaceAll(string(b), "\r", ""), "\n")
		for i, l := range lineas {
			if l == "" || i < leidas {
				continue
			}
			p := strings.SplitN(l, "|", 3)
			if len(p) < 3 {
				continue
			}
			if p[0] == "fin" {
				fin, errFin = p[1], p[2]
			} else {
				aplicarLinea(pasos, p[0], p[1], p[2])
			}
			leidas = i + 1
		}
		avance("", append([]Paso(nil), pasos...))
	}
	tic := time.NewTicker(300 * time.Millisecond)
	defer tic.Stop()
espera:
	for {
		select {
		case <-terminado:
			break espera
		case <-tic.C:
			leer()
		}
	}
	leer()
	switch fin {
	case "ok":
		return nil
	case "error":
		return errors.New(errFin)
	}
	registrar("El proceso con permisos terminó sin avisar el resultado")
	return errors.New("El asistente con permisos se cerró antes de terminar. Intenta de nuevo; si sigue igual, avisa a Compoint.")
}

// ejecutarElevado es el proceso que corre con permisos de administrador.
func ejecutarElevado(args []string) int {
	fl := flag.NewFlagSet("elevado", flag.ContinueOnError)
	b64 := fl.String("op", "", "")
	salida := fl.String("salida", "", "")
	if err := fl.Parse(args); err != nil {
		return 2
	}
	var f *os.File
	if *salida != "" && filepath.Base(*salida) == "avance.txt" {
		f, _ = os.OpenFile(*salida, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	}
	if f != nil {
		defer f.Close()
	}
	escribir := func(clave, estado, detalle string) {
		if f == nil {
			return
		}
		detalle = strings.NewReplacer("|", "/", "\r", " ", "\n", " ").Replace(detalle)
		fmt.Fprintf(f, "%s|%s|%s\n", clave, estado, detalle)
	}
	datos, err := base64.StdEncoding.DecodeString(*b64)
	var op Opciones
	if err != nil || json.Unmarshal(datos, &op) != nil {
		escribir("fin", "error", "No entendí lo que se pidió.")
		return 2
	}
	if err := validar(&op); err != nil {
		escribir("fin", "error", err.Error())
		return 2
	}
	if err := correrPasos(op, escribir); err != nil {
		escribir("fin", "error", err.Error())
		return 1
	}
	escribir("fin", "ok", "")
	return 0
}

// ---------------------------------------------------------------- Los pasos

func correrPasos(op Opciones, rep func(clave, estado, detalle string)) error {
	type paso struct {
		clave   string
		titulo  string
		critico bool
		activo  bool
		hacer   func() (string, error)
	}
	lista := []paso{
		{"firewall", "Permiso en el Firewall", true, op.Firewall, func() (string, error) { return pasoFirewall(op) }},
		{"ping", "Permitir ping", false, op.Ping, pasoPing},
		{"privada", "Red en modo Privada", false, op.RedPrivada, pasoPrivada},
		{"ip", "Fijar la IP", true, op.IPFija, func() (string, error) { return pasoIPFija(op) }},
		{"quitarfw", "Quitar el permiso del Firewall", true, op.QuitarFirewall, pasoQuitarFirewall},
		{"ipauto", "Volver a IP automática", true, op.IPAutomatica, func() (string, error) { return pasoIPAutomatica(op) }},
		{"verificar", "Comprobando", true, true, func() (string, error) { return pasoVerificar(op) }},
	}
	for _, p := range lista {
		if !p.activo {
			continue
		}
		rep(p.clave, "haciendo", "")
		detalle, err := p.hacer()
		if err != nil {
			registrar(p.clave + ": " + err.Error())
			if p.critico {
				rep(p.clave, "error", err.Error())
				return fmt.Errorf("%s: %s", p.titulo, err.Error())
			}
			rep(p.clave, "aviso", "No se pudo, pero no es grave: "+err.Error())
			continue
		}
		rep(p.clave, "ok", detalle)
	}
	return nil
}

func pasoFirewall(op Opciones) (string, error) {
	nombre := fmt.Sprintf("Compoint Punto (web %d)", op.Puerto)
	_, err := ejecutarPS(fmt.Sprintf(`
Get-NetFirewallRule -DisplayName 'Compoint Punto (*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName '%s' -Direction Inbound -Action Allow -Protocol TCP -LocalPort %d -Profile %s | Out-Null
Write-Output 'OK'`, nombre, op.Puerto, perfilesPS(op.Perfiles)))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Puerto %d · %s", op.Puerto, nombrePerfiles(op.Perfiles)), nil
}

func pasoPing() (string, error) {
	salida, err := ejecutarPS(`
$r = @(Get-NetFirewallRule -Name 'FPS-ICMP4-ERQ-In*' -ErrorAction SilentlyContinue)
if ($r.Count -eq 0) { Write-Output 'NO'; exit 0 }
$r | Enable-NetFirewallRule
Write-Output 'OK'`)
	if err != nil {
		return "", err
	}
	if strings.Contains(salida, "NO") {
		return "", errors.New("esta versión de Windows no trae esa regla")
	}
	return "Esta computadora ya responde a ping", nil
}

func pasoPrivada() (string, error) {
	salida, err := ejecutarPS(`
$cambiadas = @()
foreach ($p in @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' -and $_.IPv4Connectivity -ne 'Disconnected' -and $_.InterfaceAlias -notmatch 'Loopback' })) {
  Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
  $cambiadas += $p.InterfaceAlias
}
if ($cambiadas.Count -eq 0) { Write-Output 'YA' } else { Write-Output ('CAMBIADAS: ' + ($cambiadas -join ', ')) }`)
	if err != nil {
		return "", err
	}
	if i := strings.Index(salida, "CAMBIADAS: "); i >= 0 {
		return strings.TrimSpace(salida[i+len("CAMBIADAS: "):]) + " pasó de Pública a Privada", nil
	}
	return "Ya estaba en Privada", nil
}

func pasoIPFija(op Opciones) (string, error) {
	dns := op.DNS
	if len(dns) == 0 {
		dns = []string{op.Puerta}
	}
	salida, err := ejecutarPS(fmt.Sprintf(`
$idx = %d
$ip = '%s'
$pre = %d
$gw = '%s'
$dns = @('%s')
$ifc = Get-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4
$actual = Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $ip -and $_.PrefixOrigin -eq 'Manual' }
$ruta = Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq $gw }
if ($ifc.Dhcp -eq 'Disabled' -and $actual -and $ruta) { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $dns; Write-Output 'YA'; exit 0 }
try {
  Set-NetIPInterface -InterfaceIndex $idx -Dhcp Disabled
  Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
  New-NetIPAddress -InterfaceIndex $idx -IPAddress $ip -PrefixLength $pre -DefaultGateway $gw | Out-Null
  Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $dns
  Write-Output 'OK'
} catch {
  $msg = $_.Exception.Message
  try { Set-NetIPInterface -InterfaceIndex $idx -Dhcp Enabled; Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses } catch {}
  throw ('No se pudo fijar la IP; la dejé en automática como estaba. ' + $msg)
}`, op.Adaptador, ipv4(op.IP).String(), op.Prefijo, ipv4(op.Puerta).String(), strings.Join(dnsLimpios(dns), "','")))
	if err != nil {
		return "", err
	}
	if strings.Contains(salida, "YA") {
		return fmt.Sprintf("La IP %s ya era fija", op.IP), nil
	}
	return fmt.Sprintf("IP fija %s / %d · puerta %s", op.IP, op.Prefijo, op.Puerta), nil
}

func dnsLimpios(l []string) []string {
	var r []string
	for _, d := range l {
		if ip := ipv4(d); ip != nil {
			r = append(r, ip.String())
		}
	}
	return r
}

func pasoQuitarFirewall() (string, error) {
	salida, err := ejecutarPS(`
$r = @(Get-NetFirewallRule -DisplayName 'Compoint Punto (*' -ErrorAction SilentlyContinue)
if ($r.Count -gt 0) { $r | Remove-NetFirewallRule }
Write-Output ('N=' + $r.Count)`)
	if err != nil {
		return "", err
	}
	if strings.Contains(salida, "N=0") {
		return "No había ningún permiso que quitar", nil
	}
	return "Las otras computadoras ya no podrán entrar a esta", nil
}

func pasoIPAutomatica(op Opciones) (string, error) {
	_, err := ejecutarPS(fmt.Sprintf(`
$idx = %d
Set-NetIPInterface -InterfaceIndex $idx -Dhcp Enabled
Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -eq 'Manual' } | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses
Write-Output 'OK'`, op.Adaptador))
	if err != nil {
		return "", err
	}
	return "El router volverá a repartir la IP (puede tardar unos segundos)", nil
}

func pasoVerificar(op Opciones) (string, error) {
	var problemas []string
	for intento := 0; intento < 6; intento++ {
		problemas = nil
		e, err := leerEstado()
		if err != nil {
			problemas = append(problemas, "No pude revisar el estado: "+err.Error())
		} else {
			if op.Firewall && !(e.ReglaFirewall && e.PuertoRegla == op.Puerto) {
				problemas = append(problemas, fmt.Sprintf("El Firewall no muestra la regla del puerto %d.", op.Puerto))
			}
			if op.QuitarFirewall && e.ReglaFirewall {
				problemas = append(problemas, "La regla sigue en el Firewall.")
			}
			var ad *Adaptador
			for i := range e.Adaptadores {
				if e.Adaptadores[i].Indice == op.Adaptador {
					ad = &e.Adaptadores[i]
				}
			}
			if op.IPFija && (ad == nil || ad.IP != op.IP || ad.Dhcp) {
				problemas = append(problemas, "La IP no quedó como fija.")
			}
			if op.IPAutomatica && ad != nil && !ad.Dhcp {
				problemas = append(problemas, "La IP todavía figura como fija.")
			}
		}
		if len(problemas) == 0 {
			return "Todo en orden", nil
		}
		time.Sleep(2 * time.Second)
	}
	return "", errors.New(strings.Join(problemas, " "))
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
	perfil := filepath.Join(os.TempDir(), "CompointAsistente", "perfil")
	for _, exe := range candidatos {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+url, "--window-size=920,700", "--user-data-dir="+perfil,
			"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-mode")
		if err := cmd.Start(); err == nil {
			return cmd, nil
		}
	}
	// Último recurso: el navegador predeterminado (el latido cierra el programa al terminar).
	err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	return nil, err
}
