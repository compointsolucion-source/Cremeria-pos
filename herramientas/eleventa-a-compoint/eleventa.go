package main

// Reglas para sacar de la base de Eleventa lo que le sirve a Compoint Punto:
//   Productos: código, nombre, costo, precio, mayoreo, existencia, mínimo, máximo, departamento y tipo de venta.
//   Clientes: nombre, teléfono, límite de crédito y lo que deben.
// NO se toca el "catálogo base" de Eleventa (PRODUCTOS_BASE y PROVEEDORES_BASE): es de Eleventa.
// Son las mismas reglas que usa convertir_fdb.py (la versión que pide Firebird instalado).

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
)

const sinDepartamento = "- Sin Departamento -"

type Producto struct {
	Codigo, Nombre string
	Costo, Precio  float64
	Mayoreo        *float64
	Existencia     float64
	Minimo         float64
	Maximo         *float64
	Depto, Tipo    string
}

type Cliente struct {
	Nombre, Telefono string
	Limite, Saldo    float64
}

type Avisos struct {
	SinNombre, ConImpuestos, Kits, SinInventario, Negativos int
}

type Datos struct {
	Productos      []Producto
	Clientes       []Cliente
	Avisos         Avisos
	SinTablaClient bool // la base no trae la tabla de clientes (versión muy vieja de Eleventa)
}

// ---------------------------------------------------------------- utilidades

// numero imita round(float(valor), decimales) de Python.
func numero(v any, decimales int) float64 {
	var x float64
	switch t := v.(type) {
	case int64:
		x = float64(t)
	case dec:
		x = t.Float()
	case float64:
		x = t
	case texto:
		x, _ = strconv.ParseFloat(strings.TrimSpace(t.String()), 64)
	}
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	r, err := strconv.ParseFloat(strconv.FormatFloat(x, 'f', decimales, 64), 64)
	if err != nil {
		return x
	}
	if r == 0 {
		return 0 // evita "-0"
	}
	return r
}

func txt(v any) string {
	t, ok := v.(texto)
	if !ok {
		return ""
	}
	return strings.TrimSpace(t.String())
}

func crudo(v any) string {
	if t, ok := v.(texto); ok {
		return t.crudo
	}
	return ""
}

// esVerdadero: en Eleventa las banderas son 'T'/'F' o 1/0.
func esVerdadero(v any) bool {
	switch t := v.(type) {
	case int64:
		return t == 1
	case texto:
		s := strings.ToLower(t.String())
		return s == "t" || s == "1" || s == "true"
	}
	return false
}

func esEntero(v any, n int64) bool {
	i, ok := v.(int64)
	return ok && i == n
}

func clave(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case dec:
		if t.esc == 0 {
			return t.v, true
		}
	}
	return 0, false
}

// columnasDisponibles devuelve las columnas pedidas que sí existen y su posición.
func columnasDisponibles(e *Esquema, tabla string, obligatorias, opcionales []string) ([]string, map[string]int, error) {
	var cols []string
	pos := map[string]int{}
	for _, c := range obligatorias {
		if _, ok := e.campos[tabla][c]; !ok {
			return nil, nil, errors.New("A la tabla " + tabla + " le falta la columna " + c + " (¿es de otra versión de Eleventa?).")
		}
		pos[c] = len(cols)
		cols = append(cols, c)
	}
	for _, c := range opcionales {
		if _, ok := e.campos[tabla][c]; ok {
			pos[c] = len(cols)
			cols = append(cols, c)
		}
	}
	return cols, pos, nil
}

func campo(fila []any, pos map[string]int, nombre string) any {
	if i, ok := pos[nombre]; ok {
		return fila[i]
	}
	return nil
}

// ---------------------------------------------------------------- lectura

func leerEleventa(bd *BD) (datos Datos, err error) {
	var e *Esquema
	if err = capturar(func() { e = nuevoEsquema(bd) }); err != nil {
		return
	}
	if !e.Existe("PRODUCTOS") {
		return datos, errors.New("No encontré la tabla de productos de Eleventa en este archivo. ¿Seguro que es el PDVDATA.FDB de Eleventa?")
	}
	if err = leerProductos(e, &datos); err != nil {
		return
	}
	err = leerClientes(e, &datos)
	return
}

func leerProductos(e *Esquema, datos *Datos) error {
	// departamentos: id -> nombre
	deptos := map[int64]string{}
	if e.Existe("DEPARTAMENTOS") {
		cols, pos, err := columnasDisponibles(e, "DEPARTAMENTOS", []string{"ID", "NOMBRE"}, nil)
		if err != nil {
			return err
		}
		if err := e.Filas("DEPARTAMENTOS", cols, func(f []any) {
			if id, ok := clave(campo(f, pos, "ID")); ok {
				deptos[id] = txt(campo(f, pos, "NOMBRE"))
			}
		}); err != nil {
			return err
		}
	}
	cols, pos, err := columnasDisponibles(e, "PRODUCTOS",
		[]string{"DESCRIPCION", "PVENTA"},
		[]string{"CODIGO", "TVENTA", "PCOSTO", "PFINAL", "MAYOREO", "PMAYOREOFINAL", "DINVENTARIO", "DINVMINIMO",
			"DINVMAXIMO", "USA_INVENTARIO", "ES_KIT", "DEPT", "ELIMINADO_EN"})
	if err != nil {
		return err
	}
	type fila struct {
		orden string
		p     Producto
	}
	var lista []fila
	av := &datos.Avisos
	err = e.Filas("PRODUCTOS", cols, func(f []any) {
		g := func(n string) any { return campo(f, pos, n) }
		if g("ELIMINADO_EN") != nil {
			return
		}
		nombre := txt(g("DESCRIPCION"))
		if nombre == "" {
			av.SinNombre++
			return
		}
		pventa, pfinal := numero(g("PVENTA"), 2), numero(g("PFINAL"), 2)
		precio := pfinal
		if precio == 0 {
			precio = pventa
		}
		if pfinal != 0 && math.Abs(pfinal-pventa) > 0.004 {
			av.ConImpuestos++
		}
		mayoreo := numero(g("PMAYOREOFINAL"), 2)
		if mayoreo == 0 {
			mayoreo = numero(g("MAYOREO"), 2)
		}
		usaInv := esVerdadero(g("USA_INVENTARIO"))
		if esVerdadero(g("ES_KIT")) {
			av.Kits++
		}
		if !usaInv {
			av.SinInventario++
		}
		existencia := 0.0
		if usaInv {
			existencia = numero(g("DINVENTARIO"), 3)
		}
		if existencia < 0 {
			av.Negativos++
		}
		depto := ""
		if id, ok := clave(g("DEPT")); ok {
			depto = deptos[id]
		}
		if depto == sinDepartamento {
			depto = ""
		}
		tipo := "Por Pieza"
		// En Eleventa 'D' (decimal) es producto a granel; 'U' es por unidad.
		if strings.ToUpper(txt(g("TVENTA"))) == "D" {
			tipo = "A Granel"
		}
		p := Producto{
			Codigo: txt(g("CODIGO")), Nombre: nombre, Costo: numero(g("PCOSTO"), 2), Precio: precio,
			Existencia: existencia, Minimo: numero(g("DINVMINIMO"), 3), Depto: depto, Tipo: tipo,
		}
		if mayoreo != 0 {
			m := mayoreo
			p.Mayoreo = &m
		}
		if mx := numero(g("DINVMAXIMO"), 3); mx != 0 {
			p.Maximo = &mx
		}
		lista = append(lista, fila{crudo(g("DESCRIPCION")), p})
	})
	if err != nil {
		return err
	}
	sort.SliceStable(lista, func(i, j int) bool { return lista[i].orden < lista[j].orden })
	for _, x := range lista {
		datos.Productos = append(datos.Productos, x.p)
	}
	return nil
}

func leerClientes(e *Esquema, datos *Datos) error {
	if !e.Existe("CLIENTESV2") {
		datos.SinTablaClient = true
		return nil
	}
	// crédito: se toma una fila por cliente (la que no esté eliminada)
	type credito struct{ tiene, limite, saldo any }
	creditos := map[int64]credito{}
	if e.Existe("CLIENTESV2_CREDITO") {
		cols, pos, err := columnasDisponibles(e, "CLIENTESV2_CREDITO", []string{"CLIENTESV2_ID"},
			[]string{"TIENE_CREDITO", "LIMITE_CREDITO", "SALDO_ACTUAL", "ELIMINADO_EN"})
		if err != nil {
			return err
		}
		if err := e.Filas("CLIENTESV2_CREDITO", cols, func(f []any) {
			if campo(f, pos, "ELIMINADO_EN") != nil {
				return
			}
			id, ok := clave(campo(f, pos, "CLIENTESV2_ID"))
			if !ok {
				return
			}
			if _, ya := creditos[id]; ya {
				return
			}
			creditos[id] = credito{campo(f, pos, "TIENE_CREDITO"), campo(f, pos, "LIMITE_CREDITO"), campo(f, pos, "SALDO_ACTUAL")}
		}); err != nil {
			return err
		}
	}
	cols, pos, err := columnasDisponibles(e, "CLIENTESV2", []string{"ID", "NOMBRES"},
		[]string{"APELLIDOS", "TELEFONO", "ACTIVO", "DE_SISTEMA"})
	if err != nil {
		return err
	}
	type fila struct {
		o1, o2 string
		c      Cliente
	}
	var lista []fila
	err = e.Filas("CLIENTESV2", cols, func(f []any) {
		g := func(n string) any { return campo(f, pos, n) }
		// "de sistema" = Público en General y Venta al extranjero; no se pasan.
		// Un valor vacío (NULL) cuenta como "no es de sistema" y como "activo": solo se
		// descartan los que Eleventa marcó de forma explícita.
		if v := g("DE_SISTEMA"); v != nil && !esEntero(v, 0) {
			return
		}
		if v := g("ACTIVO"); v != nil && !esEntero(v, 1) {
			return
		}
		nombre := strings.TrimSpace(txt(g("NOMBRES")) + " " + txt(g("APELLIDOS")))
		if nombre == "" {
			return
		}
		c := Cliente{Nombre: nombre, Telefono: txt(g("TELEFONO"))}
		if id, ok := clave(g("ID")); ok {
			if cr, ok := creditos[id]; ok && esVerdadero1(cr.tiene) {
				c.Limite = numero(cr.limite, 2)
				c.Saldo = math.Max(numero(cr.saldo, 2), 0)
			}
		}
		lista = append(lista, fila{crudo(g("NOMBRES")), crudo(g("APELLIDOS")), c})
	})
	if err != nil {
		return err
	}
	sort.SliceStable(lista, func(i, j int) bool {
		if lista[i].o1 != lista[j].o1 {
			return lista[i].o1 < lista[j].o1
		}
		return lista[i].o2 < lista[j].o2
	})
	for _, x := range lista {
		datos.Clientes = append(datos.Clientes, x.c)
	}
	return nil
}

// esVerdadero1 es bool(valor) de Python para la bandera TIENE_CREDITO (cualquier número distinto de cero).
func esVerdadero1(v any) bool {
	switch t := v.(type) {
	case int64:
		return t != 0
	case dec:
		return t.v != 0
	case texto:
		return esVerdadero(t)
	}
	return false
}

// ---------------------------------------------------------------- Excel

func encabezadosProductos() []string {
	return []string{"Código", "Producto", "P. Costo", "P. Venta", "P. Mayoreo", "Existencia",
		"Inv. Mínimo", "Inv. Máximo", "Departamento", "Tipo de venta"}
}

func tablaProductos(ps []Producto) tablaExcel {
	t := tablaExcel{
		Hoja:        "Productos",
		Encabezados: encabezadosProductos(),
		Anchos:      []float64{18, 44, 12, 12, 12, 12, 12, 12, 22, 14},
		Estilos:     []int{estiloTexto, 0, estiloDinero, estiloDinero, estiloDinero, 0, 0, 0, 0, 0},
	}
	for _, p := range ps {
		var may, max any
		if p.Mayoreo != nil {
			may = *p.Mayoreo
		}
		if p.Maximo != nil {
			max = *p.Maximo
		}
		t.Filas = append(t.Filas, []any{p.Codigo, p.Nombre, p.Costo, p.Precio, may, p.Existencia, p.Minimo, max, p.Depto, p.Tipo})
	}
	return t
}

func tablaClientes(cs []Cliente) tablaExcel {
	t := tablaExcel{
		Hoja:        "Clientes",
		Encabezados: []string{"Nombre", "Teléfono", "Límite de crédito", "Saldo"},
		Anchos:      []float64{38, 18, 18, 14},
		Estilos:     []int{0, estiloTexto, estiloDinero, estiloDinero},
	}
	for _, c := range cs {
		t.Filas = append(t.Filas, []any{c.Nombre, c.Telefono, c.Limite, c.Saldo})
	}
	return t
}
