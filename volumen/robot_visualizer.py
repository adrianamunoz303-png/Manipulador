#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  VISUALIZACIÓN 3D DETALLADA — Manipulador PPP+R
  Réplica de la visualización Three.js del HTML en Python/Matplotlib
  Robótica II — Univ. de Pamplona
═══════════════════════════════════════════════════════════════════════

Uso:
  python3 robot_visualizer.py                    # Pose por defecto
  python3 robot_visualizer.py 100 80 50 45       # d1 d2 d3 θ4
"""

import numpy as np
import matplotlib
import sys

if sys.platform == "darwin":
    try:
        matplotlib.use("MacOSX")
    except Exception:
        matplotlib.use("Agg")
else:
    try:
        matplotlib.use("TkAgg")
    except Exception:
        matplotlib.use("Agg")

import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from manipulator_kinematics import (
    D1_MAX,
    D2_MAX,
    D3_MAX,
    L2,
    SERVO_HOME,
    SERVO_MAX,
    SERVO_MIN,
    pose_directa,
    theta_real_rad,
)

# ═══════════════════════════════════════════════════════════════════
# CONSTANTES FÍSICAS
# ═══════════════════════════════════════════════════════════════════
L1 = 50.0
T4_MIN, T4_MAX = SERVO_MIN, SERVO_MAX

BASE_HEIGHT = 230.0
X_OFFSET_Y  = 50.0
X_MIN_OFF   = 50.0
Y_RAIL_SPAN = 210.0
X_RAIL_SPAN = 265.0
Z_FRONT     = 20.0
LEG_W       = 12.0


# ═══════════════════════════════════════════════════════════════════
# HELPERS PARA DIBUJAR SÓLIDOS 3D
# ═══════════════════════════════════════════════════════════════════

# Coordenadas del plot:
#   X_plot = Robot X (d2 direction)    → Three.js Z
#   Y_plot = Robot Y (d1 direction)    → Three.js X
#   Z_plot = Altura  (vertical UP)     → Three.js Y
#
# HTML vb(w,h,d, mat, px,py,pz) en Three.js → plot(pz, px, py)
#   w → along Three.js X → along plot Y
#   h → along Three.js Y → along plot Z
#   d → along Three.js Z → along plot X

def _box_faces(cx, cy, cz, sx, sy, sz):
    """Genera las 6 caras de un paralelepípedo centrado en (cx,cy,cz)."""
    dx, dy, dz = sx/2, sy/2, sz/2
    v = np.array([
        [cx-dx, cy-dy, cz-dz], [cx+dx, cy-dy, cz-dz],
        [cx+dx, cy+dy, cz-dz], [cx-dx, cy+dy, cz-dz],
        [cx-dx, cy-dy, cz+dz], [cx+dx, cy-dy, cz+dz],
        [cx+dx, cy+dy, cz+dz], [cx-dx, cy+dy, cz+dz],
    ])
    faces = [
        [v[0],v[1],v[2],v[3]], [v[4],v[5],v[6],v[7]],
        [v[0],v[1],v[5],v[4]], [v[2],v[3],v[7],v[6]],
        [v[0],v[3],v[7],v[4]], [v[1],v[2],v[6],v[5]],
    ]
    return faces


def draw_box(ax, cx, cy, cz, sx, sy, sz, color, alpha=0.85, edge='#222'):
    """Dibuja un paralelepípedo sólido en el plot."""
    faces = _box_faces(cx, cy, cz, sx, sy, sz)
    poly = Poly3DCollection(faces, alpha=alpha, facecolor=color,
                            edgecolor=edge, linewidths=0.3)
    ax.add_collection3d(poly)


def draw_cylinder_z(ax, cx, cy, cz, r, h, color, n=12, alpha=0.85):
    """Dibuja un cilindro con eje en Z (vertical)."""
    theta = np.linspace(0, 2*np.pi, n+1)
    x = cx + r * np.cos(theta)
    y = cy + r * np.sin(theta)
    z_lo, z_hi = cz - h/2, cz + h/2

    # Lado
    for i in range(n):
        verts = [[x[i],y[i],z_lo], [x[i+1],y[i+1],z_lo],
                 [x[i+1],y[i+1],z_hi], [x[i],y[i],z_hi]]
        poly = Poly3DCollection([verts], alpha=alpha, facecolor=color,
                                edgecolor=color, linewidths=0.1)
        ax.add_collection3d(poly)

    # Tapas
    top = [[x[i], y[i], z_hi] for i in range(n)]
    bot = [[x[i], y[i], z_lo] for i in range(n)]
    ax.add_collection3d(Poly3DCollection([top, bot], alpha=alpha,
                                         facecolor=color, edgecolor='#333',
                                         linewidths=0.2))


def vb(ax, w, h, d, color, px_3js, py_3js, pz_3js, alpha=0.85):
    """
    Dibuja un box con la misma API que el HTML:
    vb(w,h,d, color, px,py,pz) donde coords son Three.js.
    Convierte internamente a coordenadas del plot.
    """
    # Three.js → Plot: (pz, px, py), dims: (d, w, h)
    draw_box(ax, pz_3js, px_3js, py_3js, d, w, h, color, alpha)


def vc(ax, r, h, color, px_3js, py_3js, pz_3js, alpha=0.85):
    """Cilindro con API Three.js. Eje Y en Three.js → eje Z en plot."""
    draw_cylinder_z(ax, pz_3js, px_3js, py_3js, r, h, color, alpha=alpha)


# ═══════════════════════════════════════════════════════════════════
# CONSTRUCCIÓN DEL ROBOT COMPLETO
# ═══════════════════════════════════════════════════════════════════
def build_robot(ax, d1, d2, d3, t4_deg):
    """
    Construye la visualización 3D completa del manipulador.
    Coordenadas del plot: X=d2(rojo), Y=d1(verde), Z=Altura(arriba).
    """
    hY = BASE_HEIGHT
    hX = BASE_HEIGHT + X_OFFSET_Y

    C_FRAME    = '#555860'
    C_DARK     = '#22242a'
    C_CARRIAGE = '#1a1c22'
    C_GREEN    = '#059669'
    C_RED      = '#CC2222'
    C_BLUE     = '#2563eb'
    C_PURPLE   = '#7c3aed'
    C_ALUM     = '#C0C4C8'
    C_TIP      = '#3b82f6'
    C_ENDSTOP  = '#ee3333'

    # ══════════════════════════════════════════════════════════════
    # ESTRUCTURA FIJA — Base + Patas + Riel Y
    # ══════════════════════════════════════════════════════════════

    # 4 Patas verticales
    vb(ax, LEG_W, hY, LEG_W, C_FRAME, -10, hY/2, -25)
    vb(ax, LEG_W, hY, LEG_W, C_FRAME, -10, hY/2,  25)
    vb(ax, LEG_W, hY, LEG_W, C_FRAME, Y_RAIL_SPAN, hY/2, -25)
    vb(ax, LEG_W, hY, LEG_W, C_FRAME, Y_RAIL_SPAN, hY/2,  25)

    # Travesaños inferiores
    vb(ax, LEG_W, LEG_W, 56, C_FRAME, -10, 20, 0)
    vb(ax, LEG_W, LEG_W, 56, C_FRAME, Y_RAIL_SPAN, 20, 0)

    # Travesaños superiores
    vb(ax, Y_RAIL_SPAN+20, LEG_W, LEG_W, C_FRAME, Y_RAIL_SPAN/2, hY-20, -25)
    vb(ax, Y_RAIL_SPAN+20, LEG_W, LEG_W, C_FRAME, Y_RAIL_SPAN/2, hY-20,  25)

    # Placa superior
    vb(ax, Y_RAIL_SPAN+30, 6, 60, C_FRAME, Y_RAIL_SPAN/2, hY-3, 0)

    # Riel Y (d1 — verde)
    vb(ax, Y_RAIL_SPAN, 10, 20, C_GREEN, Y_RAIL_SPAN/2, hY+5, 0)
    # Guías de aluminio
    vb(ax, Y_RAIL_SPAN, 4, 4, C_ALUM, Y_RAIL_SPAN/2, hY+10,  8)
    vb(ax, Y_RAIL_SPAN, 4, 4, C_ALUM, Y_RAIL_SPAN/2, hY+10, -8)
    # Endstops del riel Y
    vb(ax, 5, 12, 24, C_ENDSTOP, -5, hY+5, 0)
    vb(ax, 5, 12, 24, C_ENDSTOP, Y_RAIL_SPAN+5, hY+5, 0)

    # ══════════════════════════════════════════════════════════════
    # CARRITO Y — d1 (se desplaza a lo largo del riel Y)
    # Posición en Three.js X = d1
    # ══════════════════════════════════════════════════════════════
    yp = d1  # Three.js X position

    # Bloque carrito Y
    vb(ax, 30, 16, 40, C_CARRIAGE, yp, hY+2, 0)

    # Poste vertical (conecta carro Y con riel X)
    postH = hX - hY - 8
    vb(ax, 16, postH, 16, C_FRAME, yp, hY+8+postH/2, 0)
    vb(ax, 28, 8, 28, C_FRAME, yp, hX-4, 0)

    # Riel X (d2 — rojo) — va en Three.js +Z
    vb(ax, 16, 10, X_RAIL_SPAN, C_RED, yp, hX, X_RAIL_SPAN/2)
    vb(ax, 4, 4, X_RAIL_SPAN, C_ALUM, yp+5, hX+5, X_RAIL_SPAN/2)
    vb(ax, 4, 4, X_RAIL_SPAN, C_ALUM, yp-5, hX+5, X_RAIL_SPAN/2)
    # Endstop inicio
    vb(ax, 22, 14, 6, C_ENDSTOP, yp, hX, 3)
    # Motor/endstop final
    vb(ax, 26, 20, 20, C_CARRIAGE, yp, hX, X_RAIL_SPAN+10)

    # ══════════════════════════════════════════════════════════════
    # CARRITO X — d2 (se desplaza a lo largo del riel X)
    # Posición en Three.js Z = d2 + X_MIN_OFF
    # ══════════════════════════════════════════════════════════════
    xp = d2 + X_MIN_OFF  # Three.js Z position

    # Bloque carrito X
    vb(ax, 32, 18, 30, C_CARRIAGE, yp, hX, xp)

    # ══════════════════════════════════════════════════════════════
    # COLUMNA Z (d3 — azul) — Sale al frente del carro X
    # ══════════════════════════════════════════════════════════════
    zColH = D3_MAX + L1 + 30
    zColTop = hX + 10
    zColMidY = zColTop - zColH/2

    vb(ax, 16, zColH, 16, C_BLUE, yp+Z_FRONT, zColMidY, xp)
    # Guías aluminio
    vb(ax, 4, zColH, 4, C_ALUM, yp+Z_FRONT+6, zColMidY, xp+6)
    vb(ax, 4, zColH, 4, C_ALUM, yp+Z_FRONT-6, zColMidY, xp+6)
    # Endstop superior
    vb(ax, 22, 6, 22, C_ENDSTOP, yp+Z_FRONT, zColTop, xp)
    # Escuadra
    vb(ax, Z_FRONT+8, 8, 20, C_FRAME, yp+Z_FRONT/2, hX+6, xp)

    # ══════════════════════════════════════════════════════════════
    # CARRITO Z — d3 (baja sobre la columna Z)
    # ══════════════════════════════════════════════════════════════
    zCarY = (hX + 10) - 14 - d3  # Three.js Y (Altura) del carro Z

    vb(ax, 30, 14, 30, C_CARRIAGE, yp+Z_FRONT, zCarY, xp)
    vb(ax, 24, 4, 24, C_DARK, yp+Z_FRONT, zCarY-9, xp)

    # ══════════════════════════════════════════════════════════════
    # BARRA L1 (50mm, fija, horizontal) — sale en +X Three.js
    # ══════════════════════════════════════════════════════════════
    vb(ax, L1, 8, 8, C_ALUM, yp+Z_FRONT+L1/2, zCarY-9, xp)

    # ══════════════════════════════════════════════════════════════
    # SERVO θ₄ — cilindro púrpura al final de L1
    # ══════════════════════════════════════════════════════════════
    servo_3js_x = yp + Z_FRONT + L1
    servo_3js_y = zCarY - 9
    servo_3js_z = xp

    vc(ax, 11, 20, C_PURPLE, servo_3js_x, servo_3js_y, servo_3js_z)

    # ══════════════════════════════════════════════════════════════
    # BRAZO L2 — rota con theta_real compensado.
    # En Three.js: +X = horizontal hacia el frente, -Y = hacia abajo.
    # ══════════════════════════════════════════════════════════════
    t4 = theta_real_rad(t4_deg)
    C4, S4 = np.cos(t4), np.sin(t4)
    tip_3js_x = servo_3js_x + L2 * C4
    tip_3js_y = servo_3js_y - L2 * S4
    tip_3js_z = servo_3js_z

    srv_plot = (servo_3js_z, servo_3js_x, servo_3js_y)
    tip_plot = (tip_3js_z, tip_3js_x, tip_3js_y)

    # Brazo L2 (línea gruesa roja)
    ax.plot([srv_plot[0], tip_plot[0]],
            [srv_plot[1], tip_plot[1]],
            [srv_plot[2], tip_plot[2]],
            color=C_RED, lw=6, solid_capstyle='round', zorder=6)

    # Caja del electroimán en la punta
    vb(ax, 14, 14, 14, C_DARK, tip_plot_y, tip_plot_z, tip_plot_x, alpha=0.9)

    # Punta azul (esfera representada como punto)
    ax.scatter(tip_plot[0], tip_plot[1], tip_plot[2]-9,
               color=C_TIP, s=200, zorder=10, edgecolors='white', linewidths=1.5)

    # Línea punteada al suelo desde la punta
    ax.plot([tip_plot[0], tip_plot[0]],
            [tip_plot[1], tip_plot[1]],
            [tip_plot[2]-9, 0],
            color=C_TIP, lw=0.8, ls='--', alpha=0.3)

    arc_servo = np.linspace(T4_MIN, T4_MAX, 40)
    arc_t = theta_real_rad(arc_servo)
    arc_x = np.full(40, tip_3js_z)
    arc_y = servo_3js_x + L2 * np.cos(arc_t)
    arc_z = servo_3js_y - L2 * np.sin(arc_t)
    ax.plot(arc_x, arc_y, arc_z, color=C_PURPLE, lw=1.5, ls='--', alpha=0.5)

    return srv_plot, tip_plot


def add_floor_and_axes(ax):
    """Agrega piso, cuadrícula de referencia y etiquetas de ejes."""
    # Piso semitransparente
    floor_x = [-40, 330, 330, -40]
    floor_y = [-30, -30, 230, 230]
    floor = [[floor_x[i], floor_y[i], 0] for i in range(4)]
    ax.add_collection3d(Poly3DCollection([floor], alpha=0.08,
                                         facecolor='#aabbcc', edgecolor='#999'))

    # Líneas de cuadrícula en el suelo
    for v in range(0, 280, 50):
        ax.plot([-30, 320], [v, v], [0, 0], color='#ccc', lw=0.3, alpha=0.4)
    for v in range(0, 330, 50):
        ax.plot([v, v], [-20, 220], [0, 0], color='#ccc', lw=0.3, alpha=0.4)

    # Ejes de referencia
    ax.plot([0, 320], [0, 0], [0, 0], color='#dc2626', lw=1.5, alpha=0.6)
    ax.plot([0, 0], [0, 220], [0, 0], color='#059669', lw=1.5, alpha=0.6)
    ax.plot([0, 0], [0, 0], [0, 340], color='#888', lw=1.5, alpha=0.6)

    # Marcas cada 50mm
    for v in range(50, 350, 50):
        ax.text(v, -15, -8, str(v), fontsize=6, color='#dc2626', ha='center')
    for v in range(50, 220, 50):
        ax.text(-15, v, -8, str(v), fontsize=6, color='#059669', ha='center')
    for v in range(50, 340, 50):
        ax.text(-18, -12, v, str(v), fontsize=6, color='#888', ha='center')


def add_labels(ax, d1, d2, d3, t4_deg):
    """Agrega etiquetas de ejes y nombre de articulaciones."""
    ax.set_xlabel('X [mm] — d2 (motor X)', fontsize=11, fontweight='bold',
                  color='#dc2626', labelpad=8)
    ax.set_ylabel('Y [mm] — d1 (motor Y)', fontsize=11, fontweight='bold',
                  color='#059669', labelpad=8)
    ax.set_zlabel('Altura [mm]', fontsize=11, fontweight='bold',
                  color='#555', labelpad=8)

    # Etiquetas de articulaciones en la escena
    hY = BASE_HEIGHT
    hX = BASE_HEIGHT + X_OFFSET_Y
    ax.text(X_RAIL_SPAN/2 + X_MIN_OFF, d1-10, hX+25,
            f'd2 (X)', color='#CC2222', fontsize=10, fontweight='bold')
    ax.text(-5, Y_RAIL_SPAN/2, hY+22,
            f'd1 (Y)', color='#059669', fontsize=10, fontweight='bold')
    ax.text(d2+X_MIN_OFF+5, d1+Z_FRONT+25, hX-40,
            f'd3 (Z)', color='#2563eb', fontsize=10, fontweight='bold')

    from matplotlib.lines import Line2D
    legend = [
        Line2D([0],[0], color='#059669', lw=5, label=f'd1(Y) = {d1:.0f} mm'),
        Line2D([0],[0], color='#CC2222', lw=5, label=f'd2(X) = {d2:.0f} mm'),
        Line2D([0],[0], color='#2563eb', lw=5, label=f'd3(Z) = {d3:.0f} mm ↓'),
        Line2D([0],[0], color='#7c3aed', lw=3,
               label=f'θ₄ = {t4_deg:.0f}°'),
        Line2D([0],[0], color='#C0C4C8', lw=4, label=f'L1 = {L1:.0f} mm'),
        Line2D([0],[0], color='#CC2222', lw=4, label=f'L2 = {L2:.0f} mm'),
        Line2D([0],[0], marker='o', color='w', markerfacecolor='#3b82f6',
               ms=8, lw=0, label='Efector final'),
        Line2D([0],[0], color='#aaa', lw=1, ls=':',
               label='Servo compensado: theta_real=(servo-36)*90/38'),
    ]
    ax.legend(handles=legend, loc='upper left', fontsize=8, framealpha=0.9)


# ═══════════════════════════════════════════════════════════════════
# FK — Para mostrar posición del efector
# ═══════════════════════════════════════════════════════════════════
def fk(d1, d2, d3, servo_deg):
    """FK compensada: Px=d2, Py=d1+56(cos(theta_real)-1), Pz=295-d3-56 sin(theta_real)."""
    return pose_directa(d1, d2, d3, servo_deg)


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════
def visualize_robot(d1=95, d2=130, d3=60, t4_deg=45, save=True, show=True):
    """Genera la visualización 3D completa del manipulador."""

    Px, Py, Pz = fk(d1, d2, d3, t4_deg)

    print(f"  Pose: d1={d1:.0f} d2={d2:.0f} d3={d3:.0f}")
    print(f"  θ₄ (servo)={t4_deg:.0f}°")
    print(f"  FK:   Px={Px:.2f}  Py={Py:.2f}  Pz={Pz:.2f}")

    fig = plt.figure(figsize=(16, 11), facecolor='#f0f2f5')
    ax = fig.add_subplot(111, projection='3d', computed_zorder=False)
    ax.set_facecolor('#f0f2f5')

    # Construir robot
    add_floor_and_axes(ax)
    srv, tip = build_robot(ax, d1, d2, d3, t4_deg)
    add_labels(ax, d1, d2, d3, t4_deg)

    # Título
    ax.set_title(
        f'Manipulador PPP+R — Visualización 3D\n'
        f'd1={d1:.0f}  d2={d2:.0f}  d3={d3:.0f}  θ₄={t4_deg:.0f}°\n'
        f'Efector: Px={Px:.1f}  Py={Py:.1f}  Pz={Pz:.1f} mm',
        fontsize=13, fontweight='bold', pad=15)

    # Limitar ejes
    ax.set_xlim(-40, 350)
    ax.set_ylim(-30, 240)
    ax.set_zlim(0, 340)
    ax.grid(True, alpha=0.15)
    ax.view_init(elev=22, azim=-52)

    plt.tight_layout()

    if save:
        plt.savefig('robot_3d.png', dpi=200, bbox_inches='tight',
                    facecolor='#f0f2f5')
        print("  → robot_3d.png guardado")

    plt.show()

    return fig, ax


if __name__ == '__main__':
    d1, d2, d3, t4 = 95, 130, 60, 45
    if len(sys.argv) >= 5:
        d1 = float(sys.argv[1])
        d2 = float(sys.argv[2])
        d3 = float(sys.argv[3])
        t4 = float(sys.argv[4])

    print("╔═══════════════════════════════════════════════════════╗")
    print("║  VISUALIZACIÓN 3D — Manipulador PPP+R                ║")
    print("╚═══════════════════════════════════════════════════════╝")

    visualize_robot(d1, d2, d3, t4, save=True)
