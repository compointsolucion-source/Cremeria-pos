#!/usr/bin/env python3
"""Genera rsrc_windows_amd64.syso (icono de Compoint + manifiesto + datos de versión).

Uso:  python3 recursos/generar_syso.py
El compilador de Go incluye el .syso solo cuando se compila para Windows/amd64.
"""
import os, struct, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
SALIDA = os.path.join(AQUI, '..', 'rsrc_windows_amd64.syso')
VERSION = (1, 0, 0, 0)

RT_ICON, RT_GROUP_ICON, RT_VERSION, RT_MANIFEST = 3, 14, 16, 24
LANG = 0x0409

# ---------------------------------------------------------------- datos de recursos
def leer_ico(ruta):
    d = open(ruta, 'rb').read()
    _, tipo, n = struct.unpack('<HHH', d[:6])
    assert tipo == 1
    imgs = []
    for i in range(n):
        w, h, cc, res, pl, bc, tam, off = struct.unpack('<BBBBHHII', d[6 + 16 * i:22 + 16 * i])
        imgs.append((w, h, cc, pl, bc, d[off:off + tam]))
    return imgs

def grupo_icono(imgs):
    b = struct.pack('<HHH', 0, 1, len(imgs))
    for i, (w, h, cc, pl, bc, datos) in enumerate(imgs, 1):
        b += struct.pack('<BBBBHHIH', w, h, cc, 0, pl or 1, bc or 32, len(datos), i)
    return b

def utf16(t):
    return t.encode('utf-16-le')

def alinear(b, n=4):
    return b + b'\0' * ((-len(b)) % n)

def nodo_version(clave, valor_bytes, tipo, hijos=b'', len_valor=None):
    cab = struct.pack('<HHH', 0, len_valor if len_valor is not None else len(valor_bytes), tipo)
    cuerpo = alinear(cab + utf16(clave) + b'\0\0', 4)
    cuerpo += valor_bytes
    cuerpo = alinear(cuerpo, 4) + hijos
    return struct.pack('<H', len(cuerpo)) + cuerpo[2:]

def info_version():
    v = VERSION
    fijo = struct.pack('<IIIIIIIIIIIII', 0xFEEF04BD, 0x00010000,
                       (v[0] << 16) | v[1], (v[2] << 16) | v[3], (v[0] << 16) | v[1], (v[2] << 16) | v[3],
                       0x3F, 0, 0x00040004, 1, 0, 0, 0)
    textos = {
        'CompanyName': 'Compoint, punto de soluciones',
        'FileDescription': 'Activador Compoint',
        'FileVersion': '%d.%d.%d.%d' % v,
        'InternalName': 'activador-compoint',
        'LegalCopyright': 'Compoint, punto de soluciones',
        'OriginalFilename': 'Activador-Compoint.exe',
        'ProductName': 'Activador Compoint',
        'ProductVersion': '%d.%d.%d.%d' % v,
    }
    cadenas = b''
    for k, t in textos.items():
        val = utf16(t) + b'\0\0'
        cadenas += alinear(nodo_version(k, val, 1, len_valor=len(t) + 1), 4)
    tabla = nodo_version('040a04b0', b'', 1, hijos=cadenas, len_valor=0)  # 0x040A = español (tradicional)
    sfi = nodo_version('StringFileInfo', b'', 1, hijos=alinear(tabla, 4), len_valor=0)
    var = nodo_version('Translation', struct.pack('<HH', 0x040A, 0x04B0), 0, len_valor=4)
    vfi = nodo_version('VarFileInfo', b'', 1, hijos=alinear(var, 4), len_valor=0)
    return nodo_version('VS_VERSION_INFO', fijo, 0, hijos=alinear(sfi, 4) + alinear(vfi, 4), len_valor=52)

# ---------------------------------------------------------------- armado del COFF
def construir():
    imgs = leer_ico(os.path.join(AQUI, 'icono.ico'))
    manifiesto = open(os.path.join(AQUI, 'manifiesto.xml'), 'rb').read()
    recursos = {}  # tipo -> [(id, datos)]
    recursos[RT_ICON] = [(i, im[5]) for i, im in enumerate(imgs, 1)]
    recursos[RT_GROUP_ICON] = [(1, grupo_icono(imgs))]
    recursos[RT_VERSION] = [(1, info_version())]
    recursos[RT_MANIFEST] = [(1, manifiesto)]
    tipos = sorted(recursos)

    # tamaños de directorios
    tam_raiz = 16 + 8 * len(tipos)
    pos = tam_raiz
    dir_tipo = {}
    for t in tipos:
        dir_tipo[t] = pos
        pos += 16 + 8 * len(recursos[t])
    dir_nombre = {}
    for t in tipos:
        for (rid, _) in recursos[t]:
            dir_nombre[(t, rid)] = pos
            pos += 16 + 8
    entradas = {}
    for t in tipos:
        for (rid, _) in recursos[t]:
            entradas[(t, rid)] = pos
            pos += 16
    blobs = {}
    for t in tipos:
        for (rid, datos) in recursos[t]:
            pos = (pos + 7) & ~7
            blobs[(t, rid)] = pos
            pos += len(datos)
    total = (pos + 3) & ~3

    sec = bytearray(total)
    def dirhdr(off, nombrados, ids):
        struct.pack_into('<IIHHHH', sec, off, 0, 0, 0, 0, nombrados, ids)
    dirhdr(0, 0, len(tipos))
    for i, t in enumerate(tipos):
        struct.pack_into('<II', sec, 16 + 8 * i, t, 0x80000000 | dir_tipo[t])
        dirhdr(dir_tipo[t], 0, len(recursos[t]))
        for j, (rid, _) in enumerate(recursos[t]):
            struct.pack_into('<II', sec, dir_tipo[t] + 16 + 8 * j, rid, 0x80000000 | dir_nombre[(t, rid)])
            dirhdr(dir_nombre[(t, rid)], 0, 1)
            struct.pack_into('<II', sec, dir_nombre[(t, rid)] + 16, LANG, entradas[(t, rid)])
    relocs = []
    for t in tipos:
        for (rid, datos) in recursos[t]:
            e = entradas[(t, rid)]
            struct.pack_into('<IIII', sec, e, blobs[(t, rid)], len(datos), 0, 0)  # OffsetToData = desplazamiento (se suma la base con la reubicación)
            sec[blobs[(t, rid)]:blobs[(t, rid)] + len(datos)] = datos
            relocs.append(e)

    n_rel = len(relocs)
    ptr_datos = 20 + 40
    ptr_rel = ptr_datos + total
    ptr_sim = ptr_rel + 10 * n_rel
    coff = struct.pack('<HHIIIHH', 0x8664, 1, 0, ptr_sim, 1, 0, 0)
    seccion = struct.pack('<8sIIIIIIHHI', b'.rsrc', 0, 0, total, ptr_datos, ptr_rel, 0, n_rel, 0, 0xC0000040)
    rel = b''.join(struct.pack('<IIH', off, 0, 3) for off in relocs)  # IMAGE_REL_AMD64_ADDR32NB contra el símbolo 0
    simbolo = struct.pack('<8sIhHBB', b'.rsrc', 0, 1, 0, 3, 0)
    cadenas = struct.pack('<I', 4)
    return coff + seccion + bytes(sec) + rel + simbolo + cadenas

if __name__ == '__main__':
    datos = construir()
    open(SALIDA, 'wb').write(datos)
    print('Escrito', os.path.normpath(SALIDA), len(datos), 'bytes')
