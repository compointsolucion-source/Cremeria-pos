package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
)

// Adaptador es una tarjeta de red activa de esta computadora.
type Adaptador struct {
	Indice    int      `json:"indice"`
	Nombre    string   `json:"nombre"`
	IP        string   `json:"ip"`
	Prefijo   int      `json:"prefijo"`
	Puerta    string   `json:"puerta"`
	DNS       listaTxt `json:"dns"`
	Dhcp      bool     `json:"dhcp"`
	Principal bool     `json:"principal"`
	Virtual   bool     `json:"virtual"`
}

// Estado es lo que el asistente detecta de esta computadora (solo lectura).
type Estado struct {
	Equipo        string      `json:"equipo"`
	Adaptadores   []Adaptador `json:"adaptadores"`
	ReglaFirewall bool        `json:"reglaFirewall"`
	PuertoRegla   int         `json:"puertoRegla"`
	RedPublica    bool        `json:"redPublica"`
	Simulado      bool        `json:"simulado"`
	Aviso         string      `json:"aviso,omitempty"`
}

// Opciones es lo que la persona eligió (Predeterminado o Avanzado).
type Opciones struct {
	// Configurar
	Firewall   bool     `json:"firewall"`
	Puerto     int      `json:"puerto"`
	Perfiles   []string `json:"perfiles"` // private, domain, public
	Ping       bool     `json:"ping"`
	RedPrivada bool     `json:"redPrivada"`
	IPFija     bool     `json:"ipFija"`
	Adaptador  int      `json:"adaptador"`
	IP         string   `json:"ip"`
	Prefijo    int      `json:"prefijo"`
	Puerta     string   `json:"puerta"`
	DNS        []string `json:"dns"`
	// Deshacer
	QuitarFirewall bool `json:"quitarFirewall"`
	IPAutomatica   bool `json:"ipAutomatica"`
}

// Paso es una línea de la lista de avance.
type Paso struct {
	Clave   string `json:"clave"`
	Titulo  string `json:"titulo"`
	Detalle string `json:"detalle"`
	Estado  string `json:"estado"` // pendiente, haciendo, ok, aviso, error
}

// listaTxt acepta "texto" o ["a","b"] (PowerShell colapsa listas de un solo elemento).
type listaTxt []string

func (l *listaTxt) UnmarshalJSON(b []byte) error {
	var uno string
	if err := json.Unmarshal(b, &uno); err == nil {
		if uno != "" {
			*l = []string{uno}
		}
		return nil
	}
	var varios []string
	if err := json.Unmarshal(b, &varios); err != nil {
		return err
	}
	*l = varios
	return nil
}

var errPermisoDenegado = errors.New("No diste el permiso de administrador. Sin ese permiso Windows no deja hacer los cambios. Vuelve a intentarlo y elige «Sí».")

func ipv4(s string) net.IP {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return nil
	}
	return ip.To4()
}

// validar revisa todo lo que llega de la pantalla (y otra vez en el proceso con permisos).
func validar(op *Opciones) error {
	if !op.Firewall && !op.Ping && !op.RedPrivada && !op.IPFija && !op.QuitarFirewall && !op.IPAutomatica {
		return errors.New("Elige al menos una opción.")
	}
	if op.Firewall {
		if op.Puerto < 1 || op.Puerto > 65535 {
			return errors.New("El puerto debe ser un número entre 1 y 65535.")
		}
		if len(op.Perfiles) == 0 {
			return errors.New("Elige al menos un tipo de red para el Firewall (Privada, Dominio o Pública).")
		}
		for _, p := range op.Perfiles {
			if p != "private" && p != "domain" && p != "public" {
				return errors.New("Tipo de red no válido.")
			}
		}
	}
	if op.IPFija {
		if op.Adaptador < 1 {
			return errors.New("No encontré una tarjeta de red activa para fijar la IP.")
		}
		ip := ipv4(op.IP)
		if ip == nil {
			return errors.New("La IP no es válida. Ejemplo: 192.168.1.50")
		}
		if op.Prefijo < 8 || op.Prefijo > 30 {
			return errors.New("La máscara debe estar entre 8 y 30 (lo normal es 24).")
		}
		gw := ipv4(op.Puerta)
		if gw == nil {
			return errors.New("La puerta de enlace no es válida. Ejemplo: 192.168.1.1")
		}
		red := &net.IPNet{IP: ip.Mask(net.CIDRMask(op.Prefijo, 32)), Mask: net.CIDRMask(op.Prefijo, 32)}
		if !red.Contains(gw) {
			return errors.New("La IP y la puerta de enlace no están en la misma red. Revísalas.")
		}
		if ip.Equal(gw) {
			return errors.New("La IP de esta computadora no puede ser igual a la de la puerta de enlace.")
		}
		if ip.IsLoopback() || ip.IsMulticast() || ip.IsUnspecified() || ip[0] == 169 {
			return errors.New("Esa IP no se puede usar.")
		}
		for _, d := range op.DNS {
			if ipv4(d) == nil {
				return fmt.Errorf("El DNS «%s» no es válido.", d)
			}
		}
	}
	if op.IPAutomatica && op.Adaptador < 1 {
		return errors.New("No encontré una tarjeta de red activa para volver a IP automática.")
	}
	return nil
}

// pasosDe arma la lista de avance, en el orden en que se ejecuta.
func pasosDe(op Opciones) []Paso {
	var p []Paso
	if op.Firewall {
		p = append(p, Paso{Clave: "firewall", Titulo: "Permiso en el Firewall", Detalle: fmt.Sprintf("Puerto %d", op.Puerto)})
	}
	if op.Ping {
		p = append(p, Paso{Clave: "ping", Titulo: "Permitir ping (diagnóstico)"})
	}
	if op.RedPrivada {
		p = append(p, Paso{Clave: "privada", Titulo: "Red en modo Privada"})
	}
	if op.IPFija {
		p = append(p, Paso{Clave: "ip", Titulo: "Fijar la IP " + op.IP})
	}
	if op.QuitarFirewall {
		p = append(p, Paso{Clave: "quitarfw", Titulo: "Quitar el permiso del Firewall"})
	}
	if op.IPAutomatica {
		p = append(p, Paso{Clave: "ipauto", Titulo: "Volver a IP automática"})
	}
	p = append(p, Paso{Clave: "verificar", Titulo: "Comprobando que todo quedó bien"})
	for i := range p {
		p[i].Estado = "pendiente"
	}
	return p
}

// elegirPrincipal marca la tarjeta que se usa por defecto: con puerta de enlace y no virtual.
func elegirPrincipal(ads []Adaptador) {
	nombresVirtuales := []string{"vethernet", "virtualbox", "vmware", "loopback", "bluetooth", "hyper-v", "wsl", "tailscale", "zerotier", "vpn"}
	for i := range ads {
		ads[i].Principal = false
		n := strings.ToLower(ads[i].Nombre)
		ads[i].Virtual = false
		for _, v := range nombresVirtuales {
			if strings.Contains(n, v) {
				ads[i].Virtual = true
			}
		}
	}
	for pasada := 0; pasada < 2; pasada++ {
		for i := range ads {
			if ads[i].Puerta == "" || ads[i].IP == "" {
				continue
			}
			if pasada == 0 && ads[i].Virtual {
				continue
			}
			ads[i].Principal = true
			return
		}
	}
}
