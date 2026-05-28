"""
╔══════════════════════════════════════════════════════════════════════╗
║       CALCULADORA LAGRANGE-EULER — MODELO DINÁMICO                  ║
║       Robótica Industrial — Universidad de Pamplona                 ║
║       Motor verificado contra ejemplo del profesor (2 GDL: R+P)     ║
║                                                                      ║
║       Produce:  τ = D·q̈ + H + C                                    ║
║         D = Matriz de inercias (N×N)                                 ║
║         H = Vector de Coriolis y fuerzas centrífugas (N×1)          ║
║         C = Vector de fuerzas gravitacionales (N×1)                  ║
╚══════════════════════════════════════════════════════════════════════╝
"""

import sympy as sp
from sympy import (symbols, cos, sin, pi, Matrix, simplify, diff,
                   trace, zeros, Symbol, Rational, trigsimp)
from sympy.parsing.sympy_parser import (parse_expr,
    standard_transformations, implicit_multiplication_application,
    convert_xor)
import time
import sys
import re


# ══════════════════════════════════════════════════════════════
#  MOTOR DE CÁLCULO (VERIFICADO)
# ══════════════════════════════════════════════════════════════

def matriz_DH(theta, d, a, alpha):
    """Matriz de transformación homogénea 4×4 estándar D-H."""
    ct, st = cos(theta), sin(theta)
    ca, sa = cos(alpha), sin(alpha)
    return Matrix([
        [ct, -st*ca,  st*sa, a*ct],
        [st,  ct*ca, -ct*sa, a*st],
        [ 0,     sa,     ca,    d],
        [ 0,      0,      0,    1]
    ])


def lagrange_euler(GDL, dh_params, centroides, masas, g_vec, var_articulares, verbose=True):
    """
    Algoritmo Lagrange-Euler completo.
    Retorna: D, H_vec, C_vec, tau, q_dot, q_ddot
    """
    N = GDL

    def log(msg=""):
        if verbose:
            print(msg)

    def log_matrix(nombre, mat):
        if verbose:
            print(f"\n  {nombre} =")
            sp.pprint(mat, use_unicode=True)

    # ────────────────────────────────────────────────
    # PASO 1: Datos de entrada
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log("  PASO 1: Datos de entrada recibidos")
    log("─"*65)
    log(f"  GDL = {N}")
    log(f"  Variables articulares: {var_articulares}")
    log(f"  Masas: {masas}")
    log(f"  Vector gravedad: g = {g_vec}")
    for i in range(N):
        log(f"  Centroide eslabón {i+1}: ({centroides[i][0]}, {centroides[i][1]}, {centroides[i][2]})")

    # ────────────────────────────────────────────────
    # PASO 2: Matrices de transformación ⁰Aᵢ
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log("  PASO 2: Matrices de transformación ⁰Aᵢ")
    log("─"*65)

    A_ind = []
    for i in range(N):
        Ai = simplify(matriz_DH(*dh_params[i]))
        A_ind.append(Ai)
        log_matrix(f"  {i}→{i+1}  (individual)", Ai)

    A_comp = []
    acum = sp.eye(4)
    for i in range(N):
        acum = simplify(acum * A_ind[i])
        A_comp.append(acum)
        log_matrix(f"  ⁰A{i+1} (compuesta)", acum)

    # ────────────────────────────────────────────────
    # PASO 3: Matrices Uᵢⱼ = ∂(⁰Aᵢ)/∂qⱼ
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 3: Matrices Uij — {N}×{N} = {N**2} matrices")
    log("─"*65)

    U = {}
    for i in range(1, N+1):
        for j in range(1, N+1):
            U[(i,j)] = simplify(diff(A_comp[i-1], var_articulares[j-1]))
            es_cero = U[(i,j)] == zeros(4,4)
            if es_cero:
                log(f"  U{i}{j} = [0]")
            else:
                log_matrix(f"  U{i}{j}", U[(i,j)])

    # ────────────────────────────────────────────────
    # PASO 4: Matrices Uᵢⱼₖ = ∂Uᵢⱼ/∂qₖ
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 4: Matrices Uijk — {N}³ = {N**3} matrices")
    log("─"*65)

    Uijk = {}
    for i in range(1, N+1):
        for j in range(1, N+1):
            for k in range(1, N+1):
                Uijk[(i,j,k)] = simplify(diff(U[(i,j)], var_articulares[k-1]))
                es_cero = Uijk[(i,j,k)] == zeros(4,4)
                if es_cero:
                    log(f"  U{i}{j}{k} = [0]")
                else:
                    log_matrix(f"  U{i}{j}{k}", Uijk[(i,j,k)])

    # ────────────────────────────────────────────────
    # PASO 5: Matrices de pseudoinercia Jᵢ
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 5: Matrices de pseudoinercia Jᵢ")
    log("─"*65)

    J = {}
    for i in range(1, N+1):
        xi, yi, zi = centroides[i-1]
        mi = masas[i-1]
        Ji = Matrix([
            [xi**2*mi, xi*yi*mi, xi*zi*mi, xi*mi],
            [yi*xi*mi, yi**2*mi, yi*zi*mi, yi*mi],
            [zi*xi*mi, zi*yi*mi, zi**2*mi, zi*mi],
            [xi*mi,    yi*mi,    zi*mi,    mi   ]
        ])
        J[i] = simplify(Ji)
        log_matrix(f"  J{i}", J[i])

    # ────────────────────────────────────────────────
    # PASO 6: Matriz de inercia D (N×N)
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 6: Matriz de inercia D ({N}×{N})")
    log("─"*65)

    D = sp.zeros(N, N)
    for i in range(1, N+1):
        for j in range(1, N+1):
            dij = 0
            for k in range(max(i,j), N+1):
                traza = simplify(trace(U[(k,j)] * J[k] * U[(k,i)].T))
                dij += traza
                if verbose and traza != 0:
                    log(f"  d{i}{j}: k={k} → Tr = {traza}")
            D[i-1, j-1] = simplify(dij)
            log(f"  → d{i}{j} = {D[i-1, j-1]}")

    log_matrix("  ★ MATRIZ D", D)

    # ────────────────────────────────────────────────
    # PASO 7: Términos hᵢₖₘ
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 7: Términos hikm — {N}³ = {N**3} términos")
    log("─"*65)

    h_ikm = {}
    for i in range(1, N+1):
        for k in range(1, N+1):
            for m in range(1, N+1):
                hikm = 0
                for j in range(max(i,k,m), N+1):
                    hikm += simplify(trace(Uijk[(j,k,m)] * J[j] * U[(j,i)].T))
                h_ikm[(i,k,m)] = simplify(hikm)
                log(f"  h{i}{k}{m} = {h_ikm[(i,k,m)]}")

    # ────────────────────────────────────────────────
    # PASO 8: Vector H de Coriolis/centrífugas
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 8: Vector H de Coriolis/centrífugas")
    log("─"*65)

    q_dot = []
    for i in range(N):
        vn = str(var_articulares[i])
        q_dot.append(Symbol(vn + '_dot'))
    log(f"  Velocidades: {q_dot}")

    H_vec = sp.zeros(N, 1)
    for i in range(1, N+1):
        hi = 0
        for k in range(1, N+1):
            for m in range(1, N+1):
                hi += h_ikm[(i,k,m)] * q_dot[k-1] * q_dot[m-1]
        H_vec[i-1, 0] = simplify(hi)
        log(f"  h{i} = {H_vec[i-1, 0]}")

    log_matrix("  ★ VECTOR H", H_vec)

    # ────────────────────────────────────────────────
    # PASO 9: Vector C de fuerzas gravitacionales
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 9: Vector C de fuerzas de gravedad")
    log("─"*65)

    g_row = Matrix([[g_vec[0], g_vec[1], g_vec[2], g_vec[3]]])
    log(f"  g = {g_row}")

    r_vecs = []
    for i in range(N):
        xi, yi, zi = centroides[i]
        r_vecs.append(Matrix([[xi], [yi], [zi], [1]]))
        log(f"  r{i+1} = [{xi}, {yi}, {zi}, 1]ᵀ")

    C_vec = sp.zeros(N, 1)
    for i in range(1, N+1):
        ci = 0
        for j in range(1, N+1):
            ci += -masas[j-1] * (g_row * U[(j,i)] * r_vecs[j-1])[0,0]
        C_vec[i-1, 0] = simplify(ci)
        log(f"  c{i} = {C_vec[i-1, 0]}")

    log_matrix("  ★ VECTOR C", C_vec)

    # ────────────────────────────────────────────────
    # PASO 10: Modelo dinámico τ = D·q̈ + H + C
    # ────────────────────────────────────────────────
    log("\n" + "─"*65)
    log(f"  PASO 10: Modelo dinámico  τ = D·q̈ + H + C")
    log("─"*65)

    q_ddot = []
    for i in range(N):
        vn = str(var_articulares[i])
        q_ddot.append(Symbol(vn + '_ddot'))

    q_ddot_vec = Matrix(q_ddot)
    tau = D * q_ddot_vec + H_vec + C_vec
    for i in range(N):
        tau[i, 0] = simplify(tau[i, 0])

    for i in range(N):
        vs = str(var_articulares[i])
        tipo = f"T{i+1} (torque)" if vs.startswith('q') else f"F{i+1} (fuerza)"
        log(f"\n  {tipo} = {tau[i, 0]}")

    return D, H_vec, C_vec, tau, q_dot, q_ddot


# ══════════════════════════════════════════════════════════════
#  PARSER DE EXPRESIONES SIMBÓLICAS
# ══════════════════════════════════════════════════════════════

# Diccionario global de símbolos creados dinámicamente
_sym_cache = {'pi': pi, 'Pi': pi, 'PI': pi}

def _get_or_create_symbol(name):
    """Obtiene un símbolo del caché o lo crea."""
    if name not in _sym_cache:
        _sym_cache[name] = Symbol(name)
    return _sym_cache[name]

def parsear_expresion(texto):
    """
    Convierte una cadena de texto en una expresión simbólica de SymPy.

    Soporta:
      - Números: 0, 5, 5.6, -90
      - Variables articulares: q_1, q_2, d_1, d_2, d_3
      - Constantes: pi, L_1, L_2
      - Masas: m_1, m_2
      - Operaciones: +, -, *, /, **
      - Expresiones compuestas: q_1+pi/2, pi/2, -pi/2
      - Ángulos en grados si se especifica: 90°, -90°
    """
    texto = texto.strip()

    if texto == '' or texto == '0':
        return sp.Integer(0)

    # Manejar grados (convertir a radianes)
    if texto.endswith('°') or texto.endswith('deg'):
        texto = texto.rstrip('°').rstrip('deg').strip()
        try:
            val = float(texto)
            return val * pi / 180
        except ValueError:
            pass

    # Reemplazar patrones comunes
    texto = texto.replace('^', '**')

    # Crear todos los símbolos posibles que el usuario podría usar
    local_dict = dict(_sym_cache)

    # Detectar y crear símbolos con guion bajo: q_1, d_2, m_3, L_1, etc.
    patron = re.findall(r'[a-zA-Z]+_\d+', texto)
    for p in patron:
        local_dict[p] = _get_or_create_symbol(p)

    # Detectar símbolos simples: g, L, etc.
    patron2 = re.findall(r'\b([a-zA-Z]\w*)\b', texto)
    for p in patron2:
        if p not in ['pi', 'Pi', 'PI', 'sin', 'cos', 'tan', 'sqrt']:
            if p not in local_dict:
                local_dict[p] = _get_or_create_symbol(p)

    try:
        transformations = standard_transformations + (implicit_multiplication_application, convert_xor)
        expr = parse_expr(texto, local_dict=local_dict, transformations=transformations)
        return expr
    except Exception as e:
        print(f"  ⚠ Error parseando '{texto}': {e}")
        print(f"    Intente con formato: pi/2, q_1, d_2, m_1, L_1, 5.6, 0")
        return None


def detectar_variable_articular(theta_str, d_str, indice):
    """
    Detecta cuál es la variable articular de una fila DH.
    - Si theta contiene q_n → rotacional, variable = theta parseado
    - Si d contiene d_n → prismática, variable = d parseado
    """
    theta_str = theta_str.strip()
    d_str = d_str.strip()

    es_rotacional = bool(re.search(r'q_?\d+', theta_str))
    es_prismatica = bool(re.search(r'd_?\d+', d_str))

    if es_rotacional:
        return 'R', parsear_expresion(theta_str)
    elif es_prismatica:
        return 'P', parsear_expresion(d_str)
    else:
        print(f"  ⚠ Art. {indice}: No se detectó variable articular.")
        print(f"    θ='{theta_str}', d='{d_str}'")
        print(f"    Use q_n para rotacional o d_n para prismática.")
        return None, None


# ══════════════════════════════════════════════════════════════
#  INTERFAZ DE USUARIO (CALCULADORA)
# ══════════════════════════════════════════════════════════════

def separador(titulo=""):
    print("\n" + "═"*65)
    if titulo:
        print(f"  {titulo}")
        print("═"*65)

def imprimir_instrucciones():
    print("""
╔══════════════════════════════════════════════════════════════════╗
║           CALCULADORA LAGRANGE-EULER                             ║
║           Modelo dinámico de manipuladores                       ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  FORMATO DE ENTRADA:                                             ║
║                                                                  ║
║  • Variables rotacionales:  q_1, q_2, q_3, q_4                  ║
║  • Variables prismáticas:   d_1, d_2, d_3, d_4                   ║
║  • Constantes conocidas:    pi, L_1, L_2, 5.6, 0                ║
║  • Masas simbólicas:        m_1, m_2, m_3, m_4                   ║
║  • Ángulos fijos:           pi/2, -pi/2, pi/4, 0                ║
║  • Combinaciones:           q_1+pi/2, d_3+L_1                   ║
║  • Gravedad:                -9.8, 9.8, g (simbólica)             ║
║                                                                  ║
║  CONVENCIÓN:                                                     ║
║  • θ con q_n  → articulación ROTACIONAL                         ║
║  • d con d_n  → articulación PRISMÁTICA                          ║
║  • Centroides referidos al sistema {Si} de cada eslabón          ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
""")


def solicitar_entero(pregunta, minimo=1, maximo=10):
    """Solicita un número entero con validación."""
    while True:
        try:
            val = int(input(pregunta))
            if minimo <= val <= maximo:
                return val
            print(f"  → Ingrese un valor entre {minimo} y {maximo}")
        except ValueError:
            print(f"  → Debe ser un número entero")


def solicitar_expresion(pregunta, permitir_vacio=False):
    """Solicita y parsea una expresión simbólica."""
    while True:
        texto = input(pregunta).strip()
        if permitir_vacio and texto == '':
            return sp.Integer(0)
        if texto == '':
            print("  → No puede estar vacío")
            continue
        expr = parsear_expresion(texto)
        if expr is not None:
            return expr


def solicitar_tabla_dh(GDL):
    """Solicita la tabla DH completa fila por fila."""
    separador("TABLA DENAVIT-HARTENBERG")
    print("""
  Ingrese los parámetros D-H para cada articulación.
  Recuerde:
    • Rotacional → θ = q_n (ej: q_1, q_2)
    • Prismática → d = d_n (ej: d_1, d_2)
    • Ángulos constantes en radianes: pi/2, -pi/2, 0
    • Distancias constantes como números: 5, 5.6, L_1
    """)

    dh_params = []
    var_articulares = []
    tipos = []

    for i in range(1, GDL+1):
        print(f"\n  ── Articulación {i} ──")

        theta_str = input(f"    θ{i} = ").strip()
        d_str     = input(f"    d{i} = ").strip()
        a_str     = input(f"    a{i} = ").strip()
        alpha_str = input(f"    α{i} = ").strip()

        # Parsear las 4 expresiones
        theta = parsear_expresion(theta_str)
        d_val = parsear_expresion(d_str)
        a_val = parsear_expresion(a_str if a_str else '0')
        alpha = parsear_expresion(alpha_str)

        dh_params.append((theta, d_val, a_val, alpha))

        # Detectar variable articular
        tipo, var = detectar_variable_articular(theta_str, d_str, i)
        if tipo is None:
            print("  ⚠ Error en detección. Revise los datos.")
            return None, None, None

        tipos.append(tipo)

        # La variable articular es el símbolo base (sin sumas)
        if tipo == 'R':
            # Extraer el símbolo q_n de theta
            match = re.search(r'(q_?\d+)', theta_str)
            if match:
                var_articulares.append(_get_or_create_symbol(match.group(1)))
        else:
            # Extraer el símbolo d_n
            match = re.search(r'(d_?\d+)', d_str)
            if match:
                var_articulares.append(_get_or_create_symbol(match.group(1)))

        print(f"    → Tipo: {'Rotacional' if tipo=='R' else 'Prismática'}, Variable: {var_articulares[-1]}")

    # Mostrar tabla resumen
    print(f"\n  ┌──────┬──────────┬{'─'*12}┬{'─'*12}┬{'─'*12}┬{'─'*12}┐")
    print(f"  │  i   │   Tipo   │     θᵢ     │     dᵢ     │     aᵢ     │     αᵢ     │")
    print(f"  ├──────┼──────────┼{'─'*12}┼{'─'*12}┼{'─'*12}┼{'─'*12}┤")
    for i in range(GDL):
        t = 'R' if tipos[i] == 'R' else 'P'
        th = str(dh_params[i][0])[:10].center(12)
        d  = str(dh_params[i][1])[:10].center(12)
        a  = str(dh_params[i][2])[:10].center(12)
        al = str(dh_params[i][3])[:10].center(12)
        print(f"  │  {i+1}   │    {t}     │{th}│{d}│{a}│{al}│")
    print(f"  └──────┴──────────┴{'─'*12}┴{'─'*12}┴{'─'*12}┴{'─'*12}┘")

    return dh_params, var_articulares, tipos


def solicitar_centroides_masas(GDL):
    """Solicita centroides y masas para cada eslabón."""
    separador("CENTROIDES Y MASAS")
    print("""
  Ingrese la posición del centro de masa de cada eslabón
  referida al sistema de coordenadas {Si} de ese eslabón.

  Las 3 primeras columnas son X, Y, Z y la 4ta es la masa.
  Use 0 si el centro de masa está en el origen.
  Use m_n para masas simbólicas (ej: m_1, m_2).
    """)

    centroides = []
    masas = []

    for i in range(1, GDL+1):
        print(f"\n  ── Eslabón {i} ──")
        x = solicitar_expresion(f"    X{i} (centroide) = ")
        y = solicitar_expresion(f"    Y{i} (centroide) = ")
        z = solicitar_expresion(f"    Z{i} (centroide) = ")
        m = solicitar_expresion(f"    M{i} (masa)      = ")

        centroides.append((x, y, z))
        masas.append(m)
        print(f"    → Centro: ({x}, {y}, {z}), Masa: {m}")

    return centroides, masas


def solicitar_gravedad():
    """Solicita el vector de gravedad en sistema base {S0}."""
    separador("VECTOR DE GRAVEDAD")
    print("""
  Ingrese las componentes del vector de gravedad
  expresadas en el sistema de la base {S0}.

  Ejemplos comunes:
    • Robot vertical (Z hacia arriba): gx=0, gy=0, gz=-9.8
    • Robot horizontal (Y hacia abajo): gx=0, gy=-9.8, gz=0
    • Simbólico: gx=0, gy=0, gz=-g
    """)

    gx = solicitar_expresion("  gx (comp. X) = ")
    gy = solicitar_expresion("  gy (comp. Y) = ")
    gz = solicitar_expresion("  gz (comp. Z) = ")

    g_vec = [gx, gy, gz, 0]
    print(f"\n  → g = {g_vec}")
    return g_vec


def mostrar_resultados_finales(D, H_vec, C_vec, tau, var_articulares, q_dot, q_ddot, GDL):
    """Muestra los resultados finales de forma limpia."""

    separador("RESULTADOS FINALES")

    print("\n  ┌─────────────────────────────────────────────────────────┐")
    print("  │              τ = D·q̈ + H + C                           │")
    print("  └─────────────────────────────────────────────────────────┘")

    # Matriz D
    print("\n  ★ MATRIZ DE INERCIAS D:")
    sp.pprint(D, use_unicode=True)

    # Vector H
    print("\n  ★ VECTOR DE CORIOLIS/CENTRÍFUGAS H:")
    sp.pprint(H_vec, use_unicode=True)

    # Vector C
    print("\n  ★ VECTOR DE GRAVEDAD C:")
    sp.pprint(C_vec, use_unicode=True)

    # Ecuación por articulación
    print("\n  ★ ECUACIÓN POR ARTICULACIÓN:")
    print("  " + "─"*60)
    for i in range(GDL):
        vs = str(var_articulares[i])
        if vs.startswith('q'):
            tipo = f"T{i+1} (torque)"
        else:
            tipo = f"F{i+1} (fuerza)"
        print(f"\n  {tipo} =")
        sp.pprint(tau[i, 0], use_unicode=True)

    # Variables usadas
    print("\n  " + "─"*60)
    print(f"  Variables de posición:     {var_articulares}")
    print(f"  Variables de velocidad:    {q_dot}")
    print(f"  Variables de aceleración:  {q_ddot}")


# ══════════════════════════════════════════════════════════════
#  MODO API (para uso desde el servidor web HMI)
# ══════════════════════════════════════════════════════════════

def main_api(json_input_path):
    """
    Lee parámetros desde JSON, ejecuta Lagrange-Euler y
    devuelve el resultado como JSON por stdout.
    Usado por el servidor Node.js del HMI.
    """
    import json

    try:
        with open(json_input_path) as f:
            inp = json.load(f)

        GDL = int(inp['gdl'])
        dh_raw = inp['dh_params']       # [{theta, d, a, alpha}, ...]
        centroids_raw = inp['centroids'] # [{x, y, z}, ...]
        masses_raw = inp['masses']       # [expr_str, ...]
        gravity_raw = inp['gravity']     # {gx, gy, gz}

        # ── Parsear tabla DH y detectar variables articulares ──
        dh_params = []
        var_articulares = []

        for i, row in enumerate(dh_raw):
            theta = parsear_expresion(str(row['theta']))
            d_val = parsear_expresion(str(row['d']))
            a_val = parsear_expresion(str(row.get('a', '0')))
            alpha = parsear_expresion(str(row['alpha']))

            if any(v is None for v in [theta, d_val, a_val, alpha]):
                raise ValueError(f"Error parseando DH articulación {i+1}")

            dh_params.append((theta, d_val, a_val, alpha))

            tipo, _ = detectar_variable_articular(
                str(row['theta']), str(row['d']), i+1
            )
            if tipo == 'R':
                match = re.search(r'(q_?\d+)', str(row['theta']))
                if match:
                    var_articulares.append(_get_or_create_symbol(match.group(1)))
                else:
                    raise ValueError(f"No se encontró q_n en θ{i+1}='{row['theta']}'")
            elif tipo == 'P':
                match = re.search(r'(d_?\d+)', str(row['d']))
                if match:
                    var_articulares.append(_get_or_create_symbol(match.group(1)))
                else:
                    raise ValueError(f"No se encontró d_n en d{i+1}='{row['d']}'")
            else:
                raise ValueError(
                    f"Articulación {i+1}: use q_n en θ (rotacional) "
                    f"o d_n en d (prismática)"
                )

        # ── Parsear centroides ──
        centroides = []
        for i, c in enumerate(centroids_raw):
            x = parsear_expresion(str(c.get('x', '0')))
            y = parsear_expresion(str(c.get('y', '0')))
            z = parsear_expresion(str(c.get('z', '0')))
            if any(v is None for v in [x, y, z]):
                raise ValueError(f"Error parseando centroide eslabón {i+1}")
            centroides.append((x, y, z))

        # ── Parsear masas ──
        masas = []
        for i, m in enumerate(masses_raw):
            expr = parsear_expresion(str(m))
            if expr is None:
                raise ValueError(f"Error parseando masa {i+1}: '{m}'")
            masas.append(expr)

        # ── Parsear gravedad ──
        gx = parsear_expresion(str(gravity_raw.get('gx', '0')))
        gy = parsear_expresion(str(gravity_raw.get('gy', '0')))
        gz = parsear_expresion(str(gravity_raw.get('gz', '0')))
        if any(v is None for v in [gx, gy, gz]):
            raise ValueError("Error parseando vector de gravedad")
        g_vec = [gx, gy, gz, sp.Integer(0)]

        # ── Ejecutar algoritmo ──
        t_start = time.time()
        D, H_vec, C_vec, tau, q_dot, q_ddot = lagrange_euler(
            GDL=GDL,
            dh_params=dh_params,
            centroides=centroides,
            masas=masas,
            g_vec=g_vec,
            var_articulares=var_articulares,
            verbose=False
        )
        t_end = time.time()

        # ── Serializar a JSON ──
        def mat2list(mat, rows, cols):
            return [[str(mat[r, c]) for c in range(cols)] for r in range(rows)]

        output = {
            "ok": True,
            "gdl": GDL,
            "D": mat2list(D, GDL, GDL),
            "H": [str(H_vec[i, 0]) for i in range(GDL)],
            "C": [str(C_vec[i, 0]) for i in range(GDL)],
            "tau": [str(tau[i, 0]) for i in range(GDL)],
            "q_dot": [str(q) for q in q_dot],
            "q_ddot": [str(q) for q in q_ddot],
            "var_articulares": [str(v) for v in var_articulares],
            "time": round(t_end - t_start, 2)
        }
        print(json.dumps(output))

    except Exception as e:
        import traceback
        import json
        err = {
            "ok": False,
            "message": str(e),
            "trace": traceback.format_exc()
        }
        print(json.dumps(err))


# ══════════════════════════════════════════════════════════════
#  PROGRAMA PRINCIPAL
# ══════════════════════════════════════════════════════════════

def main():
    imprimir_instrucciones()

    while True:
        # ── Paso 1: Grados de libertad ──
        separador("CONFIGURACIÓN DEL MANIPULADOR")
        GDL = solicitar_entero(
            "\n  ¿Cuántos grados de libertad tiene el manipulador? (1-6): ",
            minimo=1, maximo=6
        )
        print(f"\n  ✓ Manipulador de {GDL} GDL configurado")

        # ── Paso 2: Tabla DH ──
        resultado = solicitar_tabla_dh(GDL)
        if resultado[0] is None:
            continue
        dh_params, var_articulares, tipos = resultado

        # ── Paso 3: Centroides y masas ──
        centroides, masas = solicitar_centroides_masas(GDL)

        # ── Paso 4: Gravedad ──
        g_vec = solicitar_gravedad()

        # ── Confirmación ──
        separador("CONFIRMACIÓN DE DATOS")
        print(f"\n  GDL: {GDL}")
        print(f"  Variables: {var_articulares}")
        print(f"  Tipos: {['Rotacional' if t=='R' else 'Prismática' for t in tipos]}")
        print(f"  Gravedad: {g_vec}")

        print(f"\n  Tabla D-H:")
        for i in range(GDL):
            print(f"    Art {i+1}: θ={dh_params[i][0]}, d={dh_params[i][1]}, a={dh_params[i][2]}, α={dh_params[i][3]}")

        print(f"\n  Centroides y masas:")
        for i in range(GDL):
            print(f"    Eslabón {i+1}: centro=({centroides[i][0]},{centroides[i][1]},{centroides[i][2]}), m={masas[i]}")

        # Preguntar si desea ver pasos detallados
        ver_detalle = input("\n  ¿Mostrar pasos detallados? (s/n) [s]: ").strip().lower()
        verbose = ver_detalle != 'n'

        confirmar = input("\n  ¿Los datos son correctos? Presione ENTER para calcular (o 'n' para corregir): ").strip().lower()
        if confirmar == 'n':
            print("  → Reiniciando ingreso de datos...")
            continue

        # ── Paso 5: CALCULAR ──
        separador("EJECUTANDO ALGORITMO LAGRANGE-EULER")
        print(f"  Calculando para {GDL} GDL...")
        print(f"  Operaciones estimadas: {GDL**4} (paso 7 es O(n⁴))")
        print(f"  Esto puede tomar unos segundos...")

        t_inicio = time.time()

        try:
            D, H_vec, C_vec, tau, q_dot, q_ddot = lagrange_euler(
                GDL=GDL,
                dh_params=dh_params,
                centroides=centroides,
                masas=masas,
                g_vec=g_vec,
                var_articulares=var_articulares,
                verbose=verbose
            )

            t_fin = time.time()

            # Mostrar resultados
            mostrar_resultados_finales(D, H_vec, C_vec, tau, var_articulares, q_dot, q_ddot, GDL)

            print(f"\n  ⏱ Tiempo de cálculo: {t_fin - t_inicio:.2f} segundos")
            print("  ✅ Cálculo completado exitosamente")

        except Exception as e:
            print(f"\n  ❌ Error durante el cálculo: {e}")
            print(f"     Verifique los datos ingresados e intente de nuevo.")
            import traceback
            traceback.print_exc()

        # Preguntar si desea calcular otro
        separador()
        opcion = input("  ¿Desea calcular otro manipulador? (s/n): ").strip().lower()
        if opcion != 's':
            print("\n  ¡Hasta luego!")
            break


# ══════════════════════════════════════════════════════════════
#  MODO AUTOMÁTICO (para pruebas sin interacción)
# ══════════════════════════════════════════════════════════════

def test_ejemplo_profesor():
    """Ejecuta el ejemplo del profesor automáticamente para verificación."""
    print("\n" + "█"*65)
    print("  TEST AUTOMÁTICO: Ejemplo del profesor (2 GDL: R+P)")
    print("█"*65)

    q_1 = Symbol('q_1')
    d_2 = Symbol('d_2')
    L_1 = Symbol('L_1')
    m_1, m_2 = symbols('m_1 m_2')
    g = Symbol('g')

    D, H, C, tau, qd, qdd = lagrange_euler(
        GDL=2,
        dh_params=[(q_1, 0, 0, -pi/2), (0, d_2, 0, 0)],
        centroides=[(0, 0, L_1), (0, 0, 0)],
        masas=[m_1, m_2],
        g_vec=[0, 0, -g, 0],
        var_articulares=[q_1, d_2],
        verbose=False
    )

    # Verificar
    D_ok = simplify(D[0,0] - (m_1*L_1**2 + m_2*d_2**2)) == 0
    D_ok = D_ok and D[0,1] == 0 and D[1,0] == 0
    D_ok = D_ok and simplify(D[1,1] - m_2) == 0

    H_ok = simplify(H[0,0] - 2*d_2*m_2*qd[0]*qd[1]) == 0
    H_ok = H_ok and simplify(H[1,0] + d_2*m_2*qd[0]**2) == 0

    C_ok = C[0,0] == 0 and C[1,0] == 0

    if D_ok and H_ok and C_ok:
        print("\n  ✅ TEST PASADO — Todos los resultados coinciden con el PDF")
    else:
        print("\n  ❌ TEST FALLIDO")
        print(f"  D_ok={D_ok}, H_ok={H_ok}, C_ok={C_ok}")

    return D_ok and H_ok and C_ok


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Modo test: ejecutar verificación automática
        test_ejemplo_profesor()
    elif len(sys.argv) > 2 and sys.argv[1] == '--api':
        # Modo API: leer JSON desde archivo y devolver JSON por stdout
        main_api(sys.argv[2])
    else:
        # Modo calculadora interactiva
        main()
