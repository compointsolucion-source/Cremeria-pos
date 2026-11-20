#!/usr/bin/env python3
"""Arma la demo en línea de Compoint Punto (www.compoint.com.mx/demos/punto/) desde el frontend actual.

Uso (desde la raíz del repositorio):
    python3 herramientas/demo-sitio/armar-demo.py <carpeta_salida>

Qué hace:
  1. Copia frontend/ (sin sw.js, manifest.json, login.html ni los .exe de descargas/).
  2. Pone encima lo propio de la demo: herramientas/demo-sitio/base/
     (login de demo, LEEME-DEMO.txt, .htaccess y el «servidor» falso js/demo-mock*.js).
  3. En cada .html mete los scripts de la demo después de <meta charset> y quita el manifest.
  4. Cambia direcciones absolutas (/login.html, location.origin + '/x.html', '/api/tienda/...')
     para que funcione dentro de /demos/punto/.
  5. Pone la versión de backend/package.json en el menú, la entrada y el LEEME.
  6. Hace el ZIP <carpeta_salida>.zip para subirlo con FileZilla y descomprimirlo en demos/punto/.

Después: sírvela con  python3 -m http.server  bajo /demos/punto/, entra con demo/demo y revisa
que window.__demoSinRuta (llamadas que la demo no contesta) quede vacío.
Si una pantalla nueva llama a una ruta que la demo no conoce, agrégala en base/js/demo-mock*.js.
"""
import datetime, json, os, re, shutil, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(AQUI, '..', '..'))
FRONT = os.path.join(REPO, 'frontend')
BASE = os.path.join(AQUI, 'base')

if len(sys.argv) != 2:
    sys.exit(__doc__)
salida = os.path.abspath(sys.argv[1])
if os.path.exists(salida):
    sys.exit('La carpeta de salida ya existe: ' + salida)

VERSION = json.load(open(os.path.join(REPO, 'backend', 'package.json'), encoding='utf-8'))['version']
MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
hoy = datetime.date.today()
FECHA = f'{hoy.day}-{MESES[hoy.month - 1]}-{hoy.year}'

# 1. frontend
FUERA = {'sw.js', 'manifest.json', 'login.html'}   # login.html: se queda el de la demo
for raiz, dirs, archivos in os.walk(FRONT):
    rel = os.path.relpath(raiz, FRONT)
    en_descargas = rel.split(os.sep)[0] == 'descargas'
    for a in archivos:
        r = os.path.normpath(os.path.join(rel, a))
        if r in FUERA:
            continue
        if en_descargas and not a.endswith('.bat'):   # la ayuda enlaza los .bat; los .exe pesan y no van en la demo
            continue
        os.makedirs(os.path.join(salida, rel), exist_ok=True)
        shutil.copy2(os.path.join(raiz, a), os.path.join(salida, r))

# 2. lo propio de la demo
shutil.copytree(BASE, salida, dirs_exist_ok=True)

MOCKS = sorted(f for f in os.listdir(os.path.join(BASE, 'js')) if re.fullmatch(r'demo-mock[a-z-]*\.js', f))
MOCKS.sort(key=lambda f: (f != 'demo-mock.js', f))   # demo-mock.js primero: los demás se apoyan en él


def scripts(prefijo):
    return ''.join(f'<script src="{prefijo}js/{m}"></script>' for m in MOCKS)


def raiz_demo(txt):
    # location.origin + '/x.html'  y  `${location.origin}/x.html`
    txt = re.sub(r"location\.origin \+ '/([a-z-]+\.html)'", r"(window.DEMO_ROOT || location.origin + '/') + '\1'", txt)
    txt = re.sub(r"\$\{location\.origin\}/([a-z-]+\.html)", r"${window.DEMO_ROOT || location.origin + '/'}\1", txt)
    txt = txt.replace("window.location.href = '/login.html'", "window.location.href = (window.DEMO_ROOT || '/') + 'login.html'")
    txt = txt.replace("const API = '/api/tienda/publico';", "const API = (window.DEMO_API || '/api') + '/tienda/publico';")
    txt = txt.replace("fetch('/api/tienda/publico/info?s='", "fetch((window.DEMO_API || '/api') + '/tienda/publico/info?s='")
    return txt


# 3 y 4. páginas y scripts
cambios = 0
for raiz, dirs, archivos in os.walk(salida):
    for a in archivos:
        ruta = os.path.join(raiz, a)
        rel = os.path.relpath(ruta, salida)
        if not (a.endswith('.html') or (a.endswith('.js') and not a.startswith('demo-mock') and 'vendor' not in rel)):
            continue
        txt = open(ruta, encoding='utf-8', newline='').read()
        orig = txt
        if a.endswith('.html'):
            prefijo = '../' * rel.count(os.sep)
            txt = re.sub(r'(<script src="(\.\./)*js/demo-mock[a-z-]*\.js"></script>)+\r?\n?', '', txt)
            txt = re.sub(r'(<meta charset="utf-8">)', lambda m: m.group(1) + '\n' + scripts(prefijo), txt, count=1, flags=re.I)
            txt = re.sub(r'\s*<link rel="manifest" href="[^"]*">', '', txt)
        txt = raiz_demo(txt)
        if txt != orig:
            open(ruta, 'w', encoding='utf-8', newline='').write(txt)
            cambios += 1


# 5. versión
def cambiar(rel, patron, nuevo):
    ruta = os.path.join(salida, rel)
    t = open(ruta, encoding='utf-8', newline='').read()
    t2, n = re.subn(patron, nuevo, t)
    if n == 0:
        print(f'AVISO: no encontré la versión en {rel} (revísalo a mano)')
    open(ruta, 'w', encoding='utf-8', newline='').write(t2)


cambiar(os.path.join('js', 'demo-mock-extra.js'), r"var VERSION_SISTEMA = '[0-9.]+';", f"var VERSION_SISTEMA = '{VERSION}';")
cambiar('login.html', r'\(versión [0-9.]+\)', f'(versión {VERSION})')
cambiar('LEEME-DEMO.txt', r'Version:    [0-9.]+ \([^)]*\)', f'Version:    {VERSION} ({FECHA})')

# 6. ZIP (el contenido va en la raíz del ZIP: se descomprime dentro de demos/punto/)
zip_ruta = shutil.make_archive(salida, 'zip', salida)
print(f'Demo {VERSION} lista: {salida}')
print(f'Páginas/scripts ajustados: {cambios}')
print(f'ZIP para subir: {zip_ruta}')
