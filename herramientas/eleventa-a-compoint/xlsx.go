package main

// Escritor de archivos Excel (.xlsx) sin librerías: un .xlsx es un ZIP con unos cuantos XML.
// Escribe una sola hoja con encabezado verde, primera fila fija y anchos de columna.

import (
	"archive/zip"
	"bytes"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// Estilos de celda (posiciones dentro de <cellXfs> de styles.xml).
const (
	estiloNormal = 0
	estiloEncab  = 1
	estiloDinero = 2
	estiloTexto  = 3
)

type tablaExcel struct {
	Hoja        string
	Encabezados []string
	Anchos      []float64
	Estilos     []int // estilo de cada columna para los datos (0 = normal)
	Filas       [][]any
}

func letrasColumna(i int) string { // 0 -> A, 25 -> Z, 26 -> AA
	s := ""
	for i++; i > 0; i = (i - 1) / 26 {
		s = string(rune('A'+(i-1)%26)) + s
	}
	return s
}

// limpiarXML quita los caracteres que el XML no admite y escapa los especiales.
func limpiarXML(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t' || r == '\n' || r == '\r':
			b.WriteRune(r)
		case r < 0x20 || r == 0xFFFE || r == 0xFFFF || (r >= 0xD800 && r <= 0xDFFF):
			// se omite
		case r == '&':
			b.WriteString("&amp;")
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r == '"':
			b.WriteString("&quot;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (t tablaExcel) xmlHoja() []byte {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	ultima := letrasColumna(len(t.Encabezados)-1) + strconv.Itoa(len(t.Filas)+1)
	fmt.Fprintf(&b, `<dimension ref="A1:%s"/>`, ultima)
	b.WriteString(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`)
	b.WriteString(`<sheetFormatPr defaultRowHeight="15"/>`)
	b.WriteString(`<cols>`)
	for i, a := range t.Anchos {
		fmt.Fprintf(&b, `<col min="%d" max="%d" width="%s" customWidth="1"/>`, i+1, i+1, strconv.FormatFloat(a, 'f', -1, 64))
	}
	b.WriteString(`</cols><sheetData>`)
	// encabezado
	b.WriteString(`<row r="1">`)
	for i, h := range t.Encabezados {
		fmt.Fprintf(&b, `<c r="%s1" s="%d" t="inlineStr"><is><t>%s</t></is></c>`, letrasColumna(i), estiloEncab, limpiarXML(h))
	}
	b.WriteString(`</row>`)
	for n, fila := range t.Filas {
		r := n + 2
		fmt.Fprintf(&b, `<row r="%d">`, r)
		for i, v := range fila {
			ref := letrasColumna(i) + strconv.Itoa(r)
			est := 0
			if i < len(t.Estilos) {
				est = t.Estilos[i]
			}
			switch x := v.(type) {
			case nil:
				// celda vacía: no se escribe
			case string:
				fmt.Fprintf(&b, `<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, est, limpiarXML(x))
			case float64:
				if math.IsNaN(x) || math.IsInf(x, 0) {
					continue
				}
				fmt.Fprintf(&b, `<c r="%s" s="%d"><v>%s</v></c>`, ref, est, strconv.FormatFloat(x, 'f', -1, 64))
			case int:
				fmt.Fprintf(&b, `<c r="%s" s="%d"><v>%d</v></c>`, ref, est, x)
			default:
				fmt.Fprintf(&b, `<c r="%s" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, est, limpiarXML(fmt.Sprint(x)))
			}
		}
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData></worksheet>`)
	return b.Bytes()
}

const xmlEstilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2D6B34"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

// escribirXLSX arma el archivo en memoria y lo guarda de una sola vez.
func escribirXLSX(ruta string, t tablaExcel) error {
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	ahora := time.Now()
	agregar := func(nombre, contenido string) error {
		w, err := z.CreateHeader(&zip.FileHeader{Name: nombre, Method: zip.Deflate, Modified: ahora})
		if err != nil {
			return err
		}
		_, err = w.Write([]byte(contenido))
		return err
	}
	hoja := limpiarXML(t.Hoja)
	archivos := []struct{ n, c string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="` + hoja + `" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
		{"xl/styles.xml", xmlEstilos},
		{"xl/worksheets/sheet1.xml", string(t.xmlHoja())},
	}
	for _, a := range archivos {
		if err := agregar(a.n, a.c); err != nil {
			return err
		}
	}
	if err := z.Close(); err != nil {
		return err
	}
	return os.WriteFile(ruta, buf.Bytes(), 0o644)
}
