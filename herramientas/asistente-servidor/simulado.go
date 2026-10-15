package main

import (
	"os"
	"sync"
	"time"
)

// sistemaSimulado no toca Windows: sirve para probar la pantalla y el flujo completo.
// Variables para probar casos: ASISTENTE_SIM_ERROR=<clave del paso>, ASISTENTE_SIM_UAC=no,
// ASISTENTE_SIM_SINRED=1, ASISTENTE_SIM_ESPERA=<milisegundos por paso>.
type sistemaSimulado struct {
	mu          sync.Mutex
	regla       bool
	puerto      int
	publica     bool
	ipFija      bool
	ip          string
	prefijo     int
	puertaGw    string
	pasosHechos []string
}

func nuevoSimulado() *sistemaSimulado {
	return &sistemaSimulado{publica: true, ip: "192.168.1.50", prefijo: 24, puertaGw: "192.168.1.1"}
}

func (s *sistemaSimulado) Estado() (Estado, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := Estado{Equipo: "CAJA-PRINCIPAL", ReglaFirewall: s.regla, PuertoRegla: s.puerto, RedPublica: s.publica, Simulado: true}
	if os.Getenv("ASISTENTE_SIM_SINRED") == "1" {
		return e, nil
	}
	e.Adaptadores = []Adaptador{
		{Indice: 12, Nombre: "Ethernet", IP: s.ip, Prefijo: s.prefijo, Puerta: s.puertaGw, DNS: listaTxt{"192.168.1.1"}, Dhcp: !s.ipFija},
		{Indice: 21, Nombre: "vEthernet (WSL)", IP: "172.20.64.1", Prefijo: 20, Dhcp: false},
	}
	return e, nil
}

func (s *sistemaSimulado) Ejecutar(op Opciones, avance func(fase string, pasos []Paso)) error {
	espera := 600 * time.Millisecond
	if v := os.Getenv("ASISTENTE_SIM_ESPERA"); v != "" {
		if d, err := time.ParseDuration(v + "ms"); err == nil {
			espera = d
		}
	}
	avance("esperando-permiso", nil)
	time.Sleep(espera)
	if os.Getenv("ASISTENTE_SIM_UAC") == "no" {
		return errPermisoDenegado
	}
	pasos := pasosDe(op)
	avance("trabajando", pasos)
	for i := range pasos {
		pasos[i].Estado = "haciendo"
		avance("", append([]Paso(nil), pasos...))
		time.Sleep(espera)
		if os.Getenv("ASISTENTE_SIM_ERROR") == pasos[i].Clave {
			pasos[i].Estado = "error"
			pasos[i].Detalle = "Windows no dejó hacer este cambio (simulado)"
			avance("", append([]Paso(nil), pasos...))
			return errPaso(pasos[i])
		}
		s.mu.Lock()
		switch pasos[i].Clave {
		case "firewall":
			s.regla, s.puerto = true, op.Puerto
			pasos[i].Detalle = "Puerto " + itoa(op.Puerto) + " · " + nombrePerfiles(op.Perfiles)
		case "ping":
			pasos[i].Detalle = "Respuesta a ping activada"
		case "privada":
			if s.publica {
				pasos[i].Detalle = "Ethernet pasó de Pública a Privada"
			} else {
				pasos[i].Detalle = "Ya estaba en Privada"
			}
			s.publica = false
		case "ip":
			s.ipFija, s.ip, s.prefijo, s.puertaGw = true, op.IP, op.Prefijo, op.Puerta
			pasos[i].Detalle = "IP fija " + op.IP + " / " + itoa(op.Prefijo)
		case "quitarfw":
			if s.regla {
				pasos[i].Detalle = "Regla eliminada"
			} else {
				pasos[i].Detalle = "No había regla que quitar"
			}
			s.regla = false
		case "ipauto":
			s.ipFija = false
			pasos[i].Detalle = "La IP la reparte el router otra vez"
		case "verificar":
			pasos[i].Detalle = "Todo en orden"
		}
		s.mu.Unlock()
		pasos[i].Estado = "ok"
		avance("", append([]Paso(nil), pasos...))
	}
	return nil
}
