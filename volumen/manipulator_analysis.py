#!/usr/bin/env python3
"""
Manipulador Lineal 3P+1R — Análisis Cinemático y Volumen de Trabajo

Robot: 3 articulaciones prismáticas + 1 rotacional
  d1 (Y): 0–265 mm   Motor Y
  d2 (X): 0–190 mm   Motor X
  d3 (Z): 0–120 mm   Motor Z (baja)
  θ4:     0–110°      Servo rotacional

Estructura física:
  Eje Y (d1) → Eje X (d2) → Eje Z (d3, baja) →
  Barra fija L1=50mm (paralela a Y) → Servo θ4 → Brazo L2=56mm

Cinemática Directa:
  Px = d2
  Py = d1 + L1 + L2·cos(θ4)
  Pz = -d3 - L2·sin(θ4)
"""

import numpy as np
import matplotlib
import sys

# Backend compatible con macOS, Windows y PyCharm
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
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.colors import Normalize
from matplotlib import cm
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
import tkinter as tk
from tkinter import ttk
import threading
import os
os.environ["TK_SILENCE_DEPRECATION"] = "1"

# ═══════════════════════════════════════════════════════════════════
# PARÁMETROS DEL ROBOT
# ═══════════════════════════════════════════════════════════════════
L1 = 50.0   # mm — barra fija del carro Z al servo (paralela a Y)
L2 = 56.0   # mm — brazo efector (rota con θ4)

D1_LIM = (0, 265)   # d1 — motor Y (mm)
D2_LIM = (0, 190)   # d2 — motor X (mm)
D3_LIM = (0, 120)   # d3 — motor Z (mm)
T4_LIM = (0, 110)   # θ4 — servo (grados)

BASE_HEIGHT = 230    # mm — altura del eje Y sobre el suelo
X_OFFSET_Y  = 50     # mm — eje X por encima del eje Y
X_MIN_OFF   = 50     # mm — clearance del carro X al poste Y


# ═══════════════════════════════════════════════════════════════════
# MATRICES DE TRANSFORMACIÓN HOMOGÉNEA
# ═══════════════════════════════════════════════════════════════════

def rot_x(angle):
    c, s = np.cos(angle), np.sin(angle)
    return np.array([
        [1, 0,  0, 0],
        [0, c, -s, 0],
        [0, s,  c, 0],
        [0, 0,  0, 1],
    ])

def trans(dx, dy, dz):
    return np.array([
        [1, 0, 0, dx],
        [0, 1, 0, dy],
        [0, 0, 1, dz],
        [0, 0, 0,  1],
    ])


# ═══════════════════════════════════════════════════════════════════
# CINEMÁTICA DIRECTA
# ═══════════════════════════════════════════════════════════════════

def fk_matrices(d1, d2, d3, theta4_deg):
    """Cinemática directa por composición de matrices.
    Retorna T04 (4×4) y las matrices intermedias [T01, T12, T23, T34]."""
    t4 = np.radians(theta4_deg)

    T01 = trans(0, d1, 0)                        # d1 a lo largo de Y
    T12 = trans(d2, 0, 0)                         # d2 a lo largo de X
    T23 = trans(0, 0, -d3)                        # d3 hacia abajo (-Z)
    T34 = trans(0, L1, 0) @ rot_x(-t4) @ trans(0, L2, 0)  # L1 + giro + L2

    T02 = T01 @ T12
    T03 = T02 @ T23
    T04 = T03 @ T34

    return T04, [T01, T12, T23, T34, T02, T03]


def fk(d1, d2, d3, theta4_deg):
    """Cinemática directa analítica. Retorna [Px, Py, Pz]."""
    t4 = np.radians(theta4_deg)
    Px = d2
    Py = d1 + L1 + L2 * np.cos(t4)
    Pz = -d3 - L2 * np.sin(t4)
    return np.array([Px, Py, Pz])


# ═══════════════════════════════════════════════════════════════════
# CINEMÁTICA INVERSA
# ═══════════════════════════════════════════════════════════════════

def ik(Px, Py, Pz):
    """Cinemática inversa analítica.
    Retorna lista de (d1, d2, d3, θ4°) posibles."""
    d2 = Px
    if not (D2_LIM[0] <= d2 <= D2_LIM[1]):
        return []

    sols = []
    for t4_deg in np.arange(T4_LIM[0], T4_LIM[1] + 0.5, 0.5):
        t4 = np.radians(t4_deg)
        d1 = Py - L1 - L2 * np.cos(t4)
        d3 = -Pz - L2 * np.sin(t4)
        if (D1_LIM[0] <= d1 <= D1_LIM[1] and
                D3_LIM[0] <= d3 <= D3_LIM[1]):
            sols.append((round(d1, 2), round(d2, 2), round(d3, 2), round(t4_deg, 1)))
    return sols


# ═══════════════════════════════════════════════════════════════════
# JACOBIANO
# ═══════════════════════════════════════════════════════════════════

def jacobian_linear(theta4_deg):
    """Jacobiano lineal 3×4 (vel. articulares → vel. efector)."""
    t4 = np.radians(theta4_deg)
    return np.array([
        [0, 1,  0,  0],
        [1, 0,  0, -L2 * np.sin(t4)],
        [0, 0, -1, -L2 * np.cos(t4)],
    ])


def jacobian_full(theta4_deg):
    """Jacobiano completo 6×4 (lineal + angular)."""
    Jv = jacobian_linear(theta4_deg)
    Jw = np.array([
        [0, 0, 0, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ])
    return np.vstack([Jv, Jw])


# ═══════════════════════════════════════════════════════════════════
# ÍNDICES DE MANIPULABILIDAD
# ═══════════════════════════════════════════════════════════════════

def yoshikawa(J):
    """w = sqrt(det(J·Jᵀ))"""
    M = J @ J.T
    return np.sqrt(max(0.0, np.linalg.det(M)))


def inverse_condition(J):
    """σ_min / σ_max"""
    sv = np.linalg.svd(J, compute_uv=False)
    return sv[-1] / sv[0] if sv[0] > 1e-12 else 0.0


def joint_limit_proximity(d1, d2, d3, t4_deg):
    """0 = en el límite, 1 = centro del rango."""
    def nd(v, lo, hi):
        h = (hi - lo) / 2.0
        return 1.0 - abs(v - lo - h) / h if h > 0 else 0
    return min(nd(d1, *D1_LIM), nd(d2, *D2_LIM),
               nd(d3, *D3_LIM), nd(t4_deg, *T4_LIM))


# ═══════════════════════════════════════════════════════════════════
# GENERACIÓN DEL VOLUMEN DE TRABAJO
# ═══════════════════════════════════════════════════════════════════

def generate_workspace(step_lin=25, step_ang=25, progress_cb=None):
    """Genera puntos del workspace, configuraciones e índices."""
    d1v = np.arange(D1_LIM[0], D1_LIM[1] + 1, step_lin)
    d2v = np.arange(D2_LIM[0], D2_LIM[1] + 1, step_lin)
    d3v = np.arange(D3_LIM[0], D3_LIM[1] + 1, step_lin)
    t4v = np.arange(T4_LIM[0], T4_LIM[1] + 1, step_ang)

    total = len(d1v) * len(d2v) * len(d3v) * len(t4v)
    pts, cfgs = [], []
    i_yosh, i_icn, i_jlp = [], [], []

    n = 0
    for d1 in d1v:
        for d2 in d2v:
            for d3 in d3v:
                for t4 in t4v:
                    pts.append(fk(d1, d2, d3, t4))
                    cfgs.append([d1, d2, d3, t4])
                    Jv = jacobian_linear(t4)
                    i_yosh.append(yoshikawa(Jv))
                    i_icn.append(inverse_condition(Jv))
                    i_jlp.append(joint_limit_proximity(d1, d2, d3, t4))
                    n += 1
                    if progress_cb and n % 2000 == 0:
                        progress_cb(n / total)

    if progress_cb:
        progress_cb(1.0)

    return {
        "points": np.array(pts),
        "configs": np.array(cfgs),
        "yoshikawa": np.array(i_yosh),
        "inv_condition": np.array(i_icn),
        "joint_limit": np.array(i_jlp),
        "total": total,
    }


# ═══════════════════════════════════════════════════════════════════
# DIBUJO 3D DEL ROBOT
# ═══════════════════════════════════════════════════════════════════

def draw_robot(ax, d1, d2, d3, theta4_deg, clear=True):
    """Dibuja el robot en una Axes3D de matplotlib."""
    if clear:
        ax.cla()

    t4 = np.radians(theta4_deg)

    # Coordenadas clave (X, Y, Z del mundo)
    origin   = np.array([0, 0, 0])
    p_base_y = np.array([0, 0, BASE_HEIGHT])                  # base del riel Y
    p_ycar   = np.array([0, d1, BASE_HEIGHT])                  # carro Y
    p_xcar   = np.array([d2, d1, BASE_HEIGHT + X_OFFSET_Y])    # carro X
    p_zcar   = np.array([d2, d1, BASE_HEIGHT + X_OFFSET_Y - d3])  # carro Z
    p_servo  = np.array([d2, d1 + L1, BASE_HEIGHT + X_OFFSET_Y - d3])  # fin L1 = servo
    p_tip    = np.array([d2,
                         d1 + L1 + L2 * np.cos(t4),
                         BASE_HEIGHT + X_OFFSET_Y - d3 - L2 * np.sin(t4)])  # punta

    # Riel Y (verde)
    ax.plot([0, 0], [0, D1_LIM[1]], [BASE_HEIGHT, BASE_HEIGHT],
            color="#059669", linewidth=4, label="Riel Y (d1)")
    # Riel X (rojo) — relativo al carro Y
    ax.plot([0, D2_LIM[1]], [d1, d1],
            [BASE_HEIGHT + X_OFFSET_Y, BASE_HEIGHT + X_OFFSET_Y],
            color="#dc2626", linewidth=4, label="Riel X (d2)")

    # Poste Y→X
    ax.plot([0, d2], [d1, d1], [BASE_HEIGHT, BASE_HEIGHT + X_OFFSET_Y],
            color="gray", linewidth=2)

    # Columna Z (azul)
    ztop = BASE_HEIGHT + X_OFFSET_Y + 10
    zbot = ztop - 200
    ax.plot([d2, d2], [d1, d1], [ztop, zbot], color="#2563eb", linewidth=3, label="Col Z (d3)")

    # Carro Z
    ax.scatter(*p_zcar, color="#1a1c22", s=60, zorder=5)

    # Barra L1 (gris, fija)
    ax.plot([p_zcar[0], p_servo[0]], [p_zcar[1], p_servo[1]], [p_zcar[2], p_servo[2]],
            color="#C0C4C8", linewidth=5, label=f"L1={L1}mm")

    # Servo
    ax.scatter(*p_servo, color="#7c3aed", s=80, zorder=5)

    # Brazo L2 (rojo, rota)
    ax.plot([p_servo[0], p_tip[0]], [p_servo[1], p_tip[1]], [p_servo[2], p_tip[2]],
            color="#ef4444", linewidth=4, label=f"L2={L2}mm")

    # Punta
    ax.scatter(*p_tip, color="#3b82f6", s=100, zorder=6, edgecolors="white")

    # Línea punteada al suelo
    ax.plot([p_tip[0], p_tip[0]], [p_tip[1], p_tip[1]], [p_tip[2], 0],
            color="#3b82f6", linewidth=0.5, linestyle="--", alpha=0.4)

    # Patas
    for yy in [0, D1_LIM[1] * 0.8]:
        ax.plot([0, 0], [yy, yy], [0, BASE_HEIGHT], color="gray", linewidth=1, alpha=0.4)

    ax.set_xlabel("X (mm)")
    ax.set_ylabel("Y (mm)")
    ax.set_zlabel("Z (mm)")
    ax.set_title(f"d1={d1:.0f}  d2={d2:.0f}  d3={d3:.0f}  θ4={theta4_deg:.0f}°\n"
                 f"Tip = ({p_tip[0]:.1f}, {p_tip[1]:.1f}, {p_tip[2]:.1f})")

    ax.set_xlim(-20, D2_LIM[1] + 30)
    ax.set_ylim(-20, D1_LIM[1] + L1 + L2 + 20)
    ax.set_zlim(0, BASE_HEIGHT + X_OFFSET_Y + 40)


# ═══════════════════════════════════════════════════════════════════
# GUI
# ═══════════════════════════════════════════════════════════════════

class App:
    def __init__(self, root):
        self.root = root
        root.title("Manipulador 3P+1R — Análisis Cinemático")
        root.geometry("1280x820")
        root.configure(bg="#f0f2f5")

        self.ws_data = None

        style = ttk.Style()
        style.theme_use("clam")

        # ─── Layout ───
        left = ttk.Frame(root, width=340)
        left.pack(side=tk.LEFT, fill=tk.Y, padx=6, pady=6)
        left.pack_propagate(False)

        right = ttk.Frame(root)
        right.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=6, pady=6)

        # ─── Matplotlib figure (embebido en tkinter) ───
        matplotlib.use("TkAgg")   # forzar TkAgg aquí, dentro del evento tkinter
        from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg as FCA
        from matplotlib.backends.backend_tkagg import NavigationToolbar2Tk as NT
        self.fig = matplotlib.figure.Figure(figsize=(8, 6), dpi=100, facecolor="#f0f2f5")
        self.ax = self.fig.add_subplot(111, projection="3d")
        self.canvas = FCA(self.fig, master=right)
        toolbar = NT(self.canvas, right)
        toolbar.update()
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)

        # ─── Tabs ───
        nb = ttk.Notebook(left)
        nb.pack(fill=tk.BOTH, expand=True)

        tab_fk = ttk.Frame(nb)
        tab_ik = ttk.Frame(nb)
        tab_ws = ttk.Frame(nb)
        nb.add(tab_fk, text=" Cinem. Directa ")
        nb.add(tab_ik, text=" Cinem. Inversa ")
        nb.add(tab_ws, text=" Vol. Trabajo ")

        self._build_fk_tab(tab_fk)
        self._build_ik_tab(tab_ik)
        self._build_ws_tab(tab_ws)

        self._run_fk()

    # ─── Tab Cinemática Directa ───
    def _build_fk_tab(self, parent):
        ttk.Label(parent, text="Cinemática Directa", font=("Helvetica", 13, "bold")).pack(pady=(10, 4))
        ttk.Label(parent, text="Ingresa valores articulares:").pack()

        self.fk_vars = {}
        for name, lim, default in [("d1 (Y mm)", D1_LIM, 100),
                                     ("d2 (X mm)", D2_LIM, 80),
                                     ("d3 (Z mm)", D3_LIM, 30),
                                     ("θ4 (°)",    T4_LIM, 45)]:
            f = ttk.Frame(parent)
            f.pack(fill=tk.X, padx=10, pady=3)
            ttk.Label(f, text=name, width=12).pack(side=tk.LEFT)
            var = tk.DoubleVar(value=default)
            sc = ttk.Scale(f, from_=lim[0], to=lim[1], variable=var,
                           command=lambda _: self._run_fk())
            sc.pack(side=tk.LEFT, fill=tk.X, expand=True)
            lbl = ttk.Label(f, textvariable=var, width=6)
            lbl.pack(side=tk.RIGHT)
            self.fk_vars[name] = var

        ttk.Button(parent, text="Calcular FK", command=self._run_fk).pack(pady=8)

        self.fk_result = tk.Text(parent, height=10, width=38, font=("JetBrains Mono", 10))
        self.fk_result.pack(padx=10, fill=tk.X)

    def _run_fk(self):
        d1 = self.fk_vars["d1 (Y mm)"].get()
        d2 = self.fk_vars["d2 (X mm)"].get()
        d3 = self.fk_vars["d3 (Z mm)"].get()
        t4 = self.fk_vars["θ4 (°)"].get()

        pos = fk(d1, d2, d3, t4)
        T04, mats = fk_matrices(d1, d2, d3, t4)
        Jv = jacobian_linear(t4)

        txt = f"═══ Posición del efector ═══\n"
        txt += f"  Px = {pos[0]:.2f} mm\n"
        txt += f"  Py = {pos[1]:.2f} mm\n"
        txt += f"  Pz = {pos[2]:.2f} mm\n\n"
        txt += f"═══ Índices (Jv lineal) ═══\n"
        txt += f"  Yoshikawa:  {yoshikawa(Jv):.4f}\n"
        txt += f"  Inv. Cond:  {inverse_condition(Jv):.4f}\n"
        txt += f"  Lím. Artic: {joint_limit_proximity(d1, d2, d3, t4):.4f}\n"

        self.fk_result.delete("1.0", tk.END)
        self.fk_result.insert("1.0", txt)

        draw_robot(self.ax, d1, d2, d3, t4)
        self.canvas.draw_idle()

    # ─── Tab Cinemática Inversa ───
    def _build_ik_tab(self, parent):
        ttk.Label(parent, text="Cinemática Inversa", font=("Helvetica", 13, "bold")).pack(pady=(10, 4))
        ttk.Label(parent, text="Posición deseada del efector:").pack()

        self.ik_vars = {}
        for name, default in [("Px (mm)", 80), ("Py (mm)", 180), ("Pz (mm)", -60)]:
            f = ttk.Frame(parent)
            f.pack(fill=tk.X, padx=10, pady=3)
            ttk.Label(f, text=name, width=10).pack(side=tk.LEFT)
            var = tk.DoubleVar(value=default)
            ttk.Entry(f, textvariable=var, width=10).pack(side=tk.LEFT, padx=4)
            self.ik_vars[name] = var

        ttk.Button(parent, text="Calcular IK", command=self._run_ik).pack(pady=8)

        self.ik_result = tk.Text(parent, height=18, width=38, font=("JetBrains Mono", 10))
        self.ik_result.pack(padx=10, fill=tk.BOTH, expand=True)

    def _run_ik(self):
        Px = self.ik_vars["Px (mm)"].get()
        Py = self.ik_vars["Py (mm)"].get()
        Pz = self.ik_vars["Pz (mm)"].get()

        sols = ik(Px, Py, Pz)

        txt = f"═══ IK para ({Px}, {Py}, {Pz}) ═══\n"
        if not sols:
            txt += "\n  ⚠ No se encontraron soluciones\n  dentro de los límites articulares.\n"
        else:
            txt += f"  {len(sols)} soluciones encontradas\n\n"
            step = max(1, len(sols) // 12)
            for i in range(0, min(len(sols), 12 * step), step):
                s = sols[i]
                txt += f"  d1={s[0]:6.1f}  d2={s[1]:5.1f}  d3={s[2]:5.1f}  θ4={s[3]:5.1f}°\n"
            if len(sols) > 12:
                txt += f"  ... ({len(sols)} total)\n"

            mid = sols[len(sols) // 2]
            draw_robot(self.ax, mid[0], mid[1], mid[2], mid[3])
            self.canvas.draw_idle()

        self.ik_result.delete("1.0", tk.END)
        self.ik_result.insert("1.0", txt)

    # ─── Tab Volumen de Trabajo ───
    def _build_ws_tab(self, parent):
        ttk.Label(parent, text="Volumen de Trabajo", font=("Helvetica", 13, "bold")).pack(pady=(10, 4))

        f1 = ttk.Frame(parent)
        f1.pack(fill=tk.X, padx=10, pady=2)
        ttk.Label(f1, text="Paso lineal (mm):").pack(side=tk.LEFT)
        self.ws_step_lin = tk.IntVar(value=25)
        ttk.Combobox(f1, textvariable=self.ws_step_lin, values=[10, 15, 20, 25, 30, 50],
                     width=5, state="readonly").pack(side=tk.RIGHT)

        f2 = ttk.Frame(parent)
        f2.pack(fill=tk.X, padx=10, pady=2)
        ttk.Label(f2, text="Paso angular (°):").pack(side=tk.LEFT)
        self.ws_step_ang = tk.IntVar(value=25)
        ttk.Combobox(f2, textvariable=self.ws_step_ang, values=[5, 10, 15, 20, 25, 30],
                     width=5, state="readonly").pack(side=tk.RIGHT)

        f3 = ttk.Frame(parent)
        f3.pack(fill=tk.X, padx=10, pady=2)
        ttk.Label(f3, text="Color por:").pack(side=tk.LEFT)
        self.ws_color = tk.StringVar(value="joint_limit")
        ttk.Combobox(f3, textvariable=self.ws_color,
                     values=["yoshikawa", "inv_condition", "joint_limit", "altura (Pz)"],
                     width=16, state="readonly").pack(side=tk.RIGHT)

        self.ws_btn = ttk.Button(parent, text="▶  Generar Workspace", command=self._start_ws)
        self.ws_btn.pack(pady=8)

        self.ws_prog = ttk.Progressbar(parent, mode="determinate")
        self.ws_prog.pack(fill=tk.X, padx=10, pady=2)

        self.ws_info = tk.Text(parent, height=12, width=38, font=("JetBrains Mono", 10))
        self.ws_info.pack(padx=10, fill=tk.BOTH, expand=True)

    def _start_ws(self):
        self.ws_btn.configure(state="disabled", text="Calculando…")
        self.ws_prog["value"] = 0

        def progress(frac):
            self.ws_prog["value"] = frac * 100

        def task():
            data = generate_workspace(
                step_lin=self.ws_step_lin.get(),
                step_ang=self.ws_step_ang.get(),
                progress_cb=progress,
            )
            self.ws_data = data
            self.root.after(0, lambda: self._show_ws(data))

        threading.Thread(target=task, daemon=True).start()

    def _show_ws(self, data):
        pts = data["points"]
        color_key = self.ws_color.get()

        if color_key == "yoshikawa":
            vals = data["yoshikawa"]
            cmap_name, label = "viridis", "Yoshikawa"
        elif color_key == "inv_condition":
            vals = data["inv_condition"]
            cmap_name, label = "plasma", "Inv. Condition"
        elif color_key == "joint_limit":
            vals = data["joint_limit"]
            cmap_name, label = "RdYlBu", "Prox. Límites"
        else:
            vals = pts[:, 2]
            cmap_name, label = "coolwarm", "Pz (mm)"

        self.ax.cla()
        norm = Normalize(vmin=vals.min(), vmax=vals.max())
        colors = cm.get_cmap(cmap_name)(norm(vals))

        self.ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2],
                        c=colors, s=1.2, alpha=0.6)

        sm = cm.ScalarMappable(cmap=cmap_name, norm=norm)
        sm.set_array([])
        if hasattr(self, "_cbar"):
            self._cbar.remove()
        self._cbar = self.fig.colorbar(sm, ax=self.ax, shrink=0.6, label=label)

        self.ax.set_xlabel("X (mm)")
        self.ax.set_ylabel("Y (mm)")
        self.ax.set_zlabel("Z (mm)")
        self.ax.set_title(f"Volumen de Trabajo — {data['total']:,} puntos — {label}")
        self.canvas.draw_idle()

        txt  = f"═══ Estadísticas ═══\n"
        txt += f"  Puntos: {data['total']:,}\n\n"
        txt += f"  Px: [{pts[:,0].min():.1f}, {pts[:,0].max():.1f}] mm\n"
        txt += f"  Py: [{pts[:,1].min():.1f}, {pts[:,1].max():.1f}] mm\n"
        txt += f"  Pz: [{pts[:,2].min():.1f}, {pts[:,2].max():.1f}] mm\n\n"
        txt += f"═══ Yoshikawa (lineal) ═══\n"
        txt += f"  min={data['yoshikawa'].min():.4f}\n"
        txt += f"  max={data['yoshikawa'].max():.4f}\n"
        txt += f"  (constante para robots cartesianos)\n\n"
        txt += f"═══ Prox. Límites ═══\n"
        txt += f"  min={data['joint_limit'].min():.4f}\n"
        txt += f"  max={data['joint_limit'].max():.4f}\n"

        self.ws_info.delete("1.0", tk.END)
        self.ws_info.insert("1.0", txt)

        self.ws_btn.configure(state="normal", text="▶  Generar Workspace")
        self.ws_prog["value"] = 100


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    root = tk.Tk()
    app = App(root)
    root.mainloop()
