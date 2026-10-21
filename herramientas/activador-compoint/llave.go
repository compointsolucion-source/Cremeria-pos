package main

// La llave privada de Compoint nunca se guarda en claro: se cifra con la contraseña del dueño
// (AES-256-GCM, clave derivada con PBKDF2-HMAC-SHA256). Sin la contraseña el archivo no sirve.
// Solo usa la biblioteca estándar de Go (sin paquetes de internet).

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
)

const (
	formatoLlave    = "cptkey1" // llave.cptkey (solo la llave)
	formatoRespaldo = "cptbak1" // respaldo (llave + lista de clientes + códigos emitidos)
	iteracionesKDF  = 600000
	iterMin         = 100000
	iterMax         = 5000000
)

// sobre es el archivo cifrado (JSON legible: lo único secreto va en "cifrado").
type sobre struct {
	Formato string `json:"formato"`
	KDF     string `json:"kdf"`
	Iter    int    `json:"iter"`
	Sal     string `json:"sal"`
	Nonce   string `json:"nonce"`
	Cifrado string `json:"cifrado"`
	Publica string `json:"publica"` // llave pública en hexadecimal (no es secreta)
	Creado  string `json:"creado"`
}

var errClave = errors.New("La contraseña no es correcta (o el archivo está dañado).")

// pbkdf2SHA256 es PBKDF2 (RFC 8018) con HMAC-SHA256.
func pbkdf2SHA256(clave, sal []byte, iteraciones, largo int) []byte {
	h := hmac.New(sha256.New, clave)
	bloques := (largo + h.Size() - 1) / h.Size()
	salida := make([]byte, 0, bloques*h.Size())
	var indice [4]byte
	for b := 1; b <= bloques; b++ {
		binary.BigEndian.PutUint32(indice[:], uint32(b))
		h.Reset()
		h.Write(sal)
		h.Write(indice[:])
		u := h.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iteraciones; i++ {
			h.Reset()
			h.Write(u)
			u = h.Sum(u[:0])
			for k := range t {
				t[k] ^= u[k]
			}
		}
		salida = append(salida, t...)
	}
	return salida[:largo]
}

func aad(formato, publica string) []byte { return []byte(formato + "|" + publica) }

func sellar(formato string, plano []byte, clave, publica, creado string) (*sobre, error) {
	sal := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := rand.Read(sal); err != nil {
		return nil, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	k := pbkdf2SHA256([]byte(clave), sal, iteracionesKDF, 32)
	bloque, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, err
	}
	cif := gcm.Seal(nil, nonce, plano, aad(formato, publica))
	return &sobre{Formato: formato, KDF: "pbkdf2-sha256", Iter: iteracionesKDF,
		Sal: base64.StdEncoding.EncodeToString(sal), Nonce: base64.StdEncoding.EncodeToString(nonce),
		Cifrado: base64.StdEncoding.EncodeToString(cif), Publica: publica, Creado: creado}, nil
}

func abrirSobre(s *sobre, formato, clave string) ([]byte, error) {
	if s == nil || s.Formato != formato || s.KDF != "pbkdf2-sha256" {
		return nil, errors.New("Este archivo no es de un respaldo del Activador Compoint.")
	}
	if s.Iter < iterMin || s.Iter > iterMax {
		return nil, errors.New("El archivo está dañado.")
	}
	sal, e1 := base64.StdEncoding.DecodeString(s.Sal)
	nonce, e2 := base64.StdEncoding.DecodeString(s.Nonce)
	cif, e3 := base64.StdEncoding.DecodeString(s.Cifrado)
	if e1 != nil || e2 != nil || e3 != nil || len(nonce) != 12 || len(sal) < 8 {
		return nil, errors.New("El archivo está dañado.")
	}
	k := pbkdf2SHA256([]byte(clave), sal, s.Iter, 32)
	bloque, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, err
	}
	plano, err := gcm.Open(nil, nonce, cif, aad(formato, s.Publica))
	if err != nil {
		return nil, errClave
	}
	return plano, nil
}

func leerSobre(datos []byte) (*sobre, error) {
	var s sobre
	if err := json.Unmarshal(datos, &s); err != nil {
		return nil, errors.New("Este archivo no es de un respaldo del Activador Compoint.")
	}
	return &s, nil
}

// llaveDeSemilla arma la llave privada y comprueba que corresponde a la pública anotada.
func llaveDeSemilla(semilla []byte, publicaEsperada string) (ed25519.PrivateKey, error) {
	if len(semilla) != ed25519.SeedSize {
		return nil, errors.New("El archivo está dañado.")
	}
	priv := ed25519.NewKeyFromSeed(semilla)
	if publicaHex(priv.Public().(ed25519.PublicKey)) != publicaEsperada {
		return nil, errors.New("El archivo está dañado.")
	}
	return priv, nil
}
