#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  PUNTO 2 — VOLUMEN DE TRABAJO OPERATIVO
  PUNTO 3 — VALIDACIÓN TOTAL DE CINEMÁTICA INVERSA
  Manipulador PPP+R | Robótica II | Univ. de Pamplona
═══════════════════════════════════════════════════════════════════════

USO:
  python3 workspace_volume.py                   # paso 10mm / 5°  (rápido)
  python3 workspace_volume.py --step-lin 2      # paso 2mm / 5°   (~18M pts)
  python3 workspace_volume.py --step-lin 2 --step-ang 2  # 2mm / 2° (~44M pts)
  python3 workspace_volume.py --step-lin 5 --step-ang 3  # personalizado

Cinemática directa compensada:
  Pₓ = d₂
  Pᵧ = d₁ + L₂·[cos(θ_real) − 1]
  Pz = 295 − d₃ − L₂·sin(θ_real)

  θ_real = (servo − 36°) * 90/38

  T₀E (forma cerrada, rotación Rₓ(θ_real) + traslación):
        [ 1   0    0    d₂                    ]
        [ 0   c   -s    d₁+L₂·(c−1)         ]
        [ 0   s    c    295−d₃−L₂·s         ]
        [ 0   0    0    1                    ]
  c = cos(θ_real), s = sin(θ_real)

Mapeo para gráficas:
  Plot X = Px  Plot Y = Py  Plot Z = Pz

Descomposición → cine_directa_descompuesta()
"""

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import sys
import os
import time
import argparse

from manipulator_kinematics import (
    D1_MAX,
    D2_MAX,
    D3_MAX,
    FLOAT_TOL,
    L2,
    SERVO_HOME,
    SERVO_MAX,
    SERVO_MIN,
    SERVO_REAL_SCALE,
    Z_REF,
    fk_components,
    ik_batch_from_mth,
    ik_from_mth,
    is_within_limits,
    mth_batch,
    mth_directa,
)


# ═══════════════════════════════════════════════════════════════════
# PARÁMETROS FÍSICOS
# ═══════════════════════════════════════════════════════════════════
L1 = 50.0  # solo para el dibujo físico simplificado
T4_MIN = SERVO_MIN
T4_MAX = SERVO_MAX


# ═══════════════════════════════════════════════════════════════════
# CINEMÁTICA DIRECTA — FÓRMULAS Y DESCOMPOSICIÓN FÍSICA
# ═══════════════════════════════════════════════════════════════════
#   Pₓ = d₂ ;  Pᵧ = d₁ + L₂·(cos θ_real − 1) ;  Pz = Z_REF − d₃ − L₂·sin θ_real
# ═══════════════════════════════════════════════════════════════════


def cine_directa_descompuesta(d1, d2, d3, servo_deg):
    """
    Misma cinemática que mth_directa, desglosada por aporte de cada causa.

    Retorna dict con totales y términos parciales (escalares o arrays si
    se pasan arrays numpy).
    """
    fk = fk_components(d1, d2, d3, servo_deg)
    px_motor = np.asarray(d2, dtype=np.float64)
    py_riel_y = np.asarray(d1, dtype=np.float64)
    delta_py_brazo = fk["dpy"]
    pz_columna = Z_REF - np.asarray(d3, dtype=np.float64)
    delta_pz_brazo = fk["dpz"]

    return {
        "theta_real_rad": fk["theta_real_rad"],
        "theta_real_deg": fk["theta_real_deg"],
        "Px": fk["px"],
        "Py": fk["py"],
        "Pz": fk["pz"],
        "Px_de_d2": px_motor,
        "delta_Px_brazo": np.zeros_like(np.asarray(d2, dtype=np.float64)),
        "Py_de_d1": py_riel_y,
        "delta_Py_brazo": delta_py_brazo,
        "Pz_de_ZREF_menos_d3": pz_columna,
        "delta_Pz_brazo": delta_pz_brazo,
    }


def cine_inversa(NOAP):
    """Inversa algebraica para UNA NOAP. Devuelve (d1, d2, d3, servo_deg, MTH_verificación)."""
    return ik_from_mth(NOAP)


# ═══════════════════════════════════════════════════════════════════
# DIBUJO 3D — Coordenadas físicas (X=Px, Y=Pz, Z=Py)
# ═══════════════════════════════════════════════════════════════════
def draw_robot_physical(ax, d1, d2, d3, servo_deg, show_labels=True):
    t4 = np.radians(servo_deg)
    C4, S4 = np.cos(t4), np.sin(t4)

    def p(px, py, pz):
        return (px, pz, py)

    lw_r, lw_l = 5, 6

    ax.plot(*zip(p(0,0,0), p(0,0,D1_MAX)), color='#059669', lw=lw_r, solid_capstyle='round')
    ax.scatter(*p(0,0,0), color='#059669', s=50, marker='s')
    ax.scatter(*p(0,0,D1_MAX), color='#059669', s=30, marker='s')
    ax.scatter(*p(0,0,d1), color='#333', s=70)

    ax.plot(*zip(p(0,0,d1), p(D2_MAX,0,d1)), color='#dc2626', lw=lw_r, solid_capstyle='round')
    ax.scatter(*p(d2,0,d1), color='#333', s=70)

    ax.plot(*zip(p(d2,0,d1), p(d2,-D3_MAX,d1)), color='#2563eb', lw=lw_r-1, solid_capstyle='round')
    ax.scatter(*p(d2,-d3,d1), color='#333', s=70)

    ax.plot(*zip(p(d2,-d3,d1), p(d2,-d3,d1-L1)), color='#B0B4B8', lw=lw_l, solid_capstyle='round')

    srv = p(d2, -d3, d1-L1)
    ax.scatter(*srv, color='#7c3aed', s=140, zorder=7, edgecolors='white', linewidths=1)

    arc_servo = np.linspace(T4_MIN, T4_MAX, 40)
    arc_t = np.radians(arc_servo)
    # Arco en plano Py–Pz (plot Y=Pz, Z=Py), Pₓ = d₂ fijo
    ax.plot(np.full(40, d2), d3 - L2 * np.sin(arc_t), d1 + L1 + L2 * np.cos(arc_t),
            color='#7c3aed', lw=1.5, ls='--', alpha=0.6)

    tip = p(d2, d3 - L2 * S4, d1 + L1 + L2 * C4)
    ax.plot(*zip(srv, tip), color='#ef4444', lw=lw_l, solid_capstyle='round')
    ax.scatter(*tip, color='#3b82f6', s=160, zorder=8, edgecolors='white', linewidths=1.5)

    ax.plot([0], [0], [0], 'k*', ms=12, zorder=10)

    if show_labels:
        ax.text(D2_MAX/2, d1+8, 5, 'd2(X)', color='#dc2626', fontsize=9, fontweight='bold')
        ax.text(5, D1_MAX/2, 5, 'd1(Y)', color='#059669', fontsize=9, fontweight='bold')
        ax.text(d2+8, d1+5, -D3_MAX/2, 'd3(Z)↓', color='#2563eb', fontsize=9, fontweight='bold')
        ax.text(d2+5, d1-L1-5, -d3+5, 'θ4', color='#7c3aed', fontsize=10, fontweight='bold')


# ═══════════════════════════════════════════════════════════════════
#  PUNTO 2 — VOLUMEN DE TRABAJO
# ═══════════════════════════════════════════════════════════════════
def punto2_volumen_trabajo(step_lin=10, step_ang=5):
    print("=" * 65)
    print("  PUNTO 2 — VOLUMEN DE TRABAJO OPERATIVO — PPP+R")
    print("=" * 65)

    rango_d1 = np.arange(0, D1_MAX + 0.01, step_lin, dtype=np.float32)
    rango_d2 = np.arange(0, D2_MAX + 0.01, step_lin, dtype=np.float32)
    rango_d3 = np.arange(0, D3_MAX + 0.01, step_lin, dtype=np.float32)
    rango_t4 = np.arange(T4_MIN, T4_MAX + 0.01, step_ang, dtype=np.float32)

    n1, n2, n3, n4 = len(rango_d1), len(rango_d2), len(rango_d3), len(rango_t4)
    N_total = n1 * n2 * n3 * n4
    mem_mth_gb = N_total * 16 * 4 / 1e9
    mem_total_gb = N_total * (16 + 3 + 4) * 4 / 1e9

    print(f"\n  Paso lineal:  {step_lin} mm")
    print(f"  Paso angular: {step_ang}°")
    print(f"  d1: {n1} vals  [0, {D1_MAX}] mm")
    print(f"  d2: {n2} vals  [0, {D2_MAX}] mm")
    print(f"  d3: {n3} vals  [0, {D3_MAX}] mm")
    print(f"  θ4: {n4} vals  [{T4_MIN}, {T4_MAX}]°")
    print(f"  Combinaciones totales: {N_total:,.0f}")
    print(f"  Memoria estimada: {mem_total_gb:.2f} GB (NOAPs: {mem_mth_gb:.2f} GB)")

    # ── Generar todas las combinaciones de forma vectorizada ──
    print("\n  [1/3] Generando combinaciones articulares...")
    t0 = time.time()
    D1, D2, D3, T4 = np.meshgrid(rango_d1, rango_d2, rango_d3, rango_t4, indexing='ij')
    d1_flat = D1.ravel()
    d2_flat = D2.ravel()
    d3_flat = D3.ravel()
    t4_flat = T4.ravel()
    print(f"       {time.time()-t0:.1f}s — {N_total:,.0f} combinaciones")

    # ── Calcular todas las MTH vectorizadamente ──
    print("  [2/3] Calculando MTH para TODOS los puntos...")
    t0 = time.time()
    noap_all = mth_batch(d1_flat, d2_flat, d3_flat, t4_flat)
    Px_all = noap_all[:, 0, 3]
    Py_all = noap_all[:, 1, 3]
    Pz_all = noap_all[:, 2, 3]
    print(f"       {time.time()-t0:.1f}s — {N_total:,.0f} MTH generadas")

    # ── Filtrar restricciones físicas ──
    print("  [3/3] Aplicando límites físicos...")
    t0 = time.time()
    mask = is_within_limits(d1_flat, d2_flat, d3_flat, t4_flat)
    n_desc = np.sum(~mask)

    noap_all = noap_all[mask]
    Px_all = Px_all[mask]
    Py_all = Py_all[mask]
    Pz_all = Pz_all[mask]
    q_all = np.column_stack([d1_flat[mask], d2_flat[mask],
                              d3_flat[mask], t4_flat[mask]])
    N = len(Px_all)
    print(f"       {time.time()-t0:.1f}s — {n_desc:,.0f} descartados, {N:,.0f} válidos")

    # ── Guardar TODO ──
    print(f"\n  Guardando {N:,.0f} NOAPs completas (4×4 float32 c/u)...")
    t0 = time.time()
    save_path = 'noap_all.npz'
    np.savez_compressed(save_path,
                        noap_all=noap_all,
                        Px_all=Px_all, Py_all=Py_all, Pz_all=Pz_all,
                        q_all=q_all,
                        step_lin=step_lin, step_ang=step_ang,
                        L1=L1, L2=L2, N=N)
    fsize = os.path.getsize(save_path) / (1024**2)
    print(f"  → noap_all.npz ({fsize:.1f} MB) — {time.time()-t0:.1f}s")

    print(f"\n  {'='*55}")
    print(f"  RESUMEN — {N:,.0f} puntos alcanzables")
    print(f"  {'='*55}")
    print(f"  Px: [{Px_all.min():.1f}, {Px_all.max():.1f}] mm")
    print(f"  Py: [{Py_all.min():.1f}, {Py_all.max():.1f}] mm")
    print(f"  Pz: [{Pz_all.min():.1f}, {Pz_all.max():.1f}] mm")
    print(f"  Pasos: lineal={step_lin}mm, angular={step_ang}°")
    print(f"  NOAPs almacenadas: {N:,.0f} matrices 4×4 float32")
    print(f"  Archivo: noap_all.npz ({fsize:.1f} MB)")
    print(f"  {'='*55}")

    return noap_all, Px_all, Py_all, Pz_all, q_all, N


# ═══════════════════════════════════════════════════════════════════
#  GRÁFICAS
# ═══════════════════════════════════════════════════════════════════
def graficar_volumen(Px_all, Py_all, Pz_all, N, step_lin, step_ang):
    max_pts = min(30000, N)
    sub = np.random.choice(N, max_pts, replace=False) if N > max_pts else np.arange(N)

    px, py, pz = Px_all[sub], Py_all[sub], Pz_all[sub]

    # ── Fig 1: 4 vistas ──
    fig1 = plt.figure(figsize=(16, 12), facecolor='white')
    fig1.suptitle(f'Volumen de Trabajo — PPP+R — {N:,.0f} puntos\n'
                  f'Paso: {step_lin}mm / {step_ang}° · θ4∈[{T4_MIN:.0f}°,{T4_MAX:.0f}°]',
                  fontsize=13, fontweight='bold')

    for idx, (title, elev, azim) in enumerate([
        (f'Robot + Volumen', 25, -55),
        ('Vista lateral', 10, 0),
        ('Vista superior', 85, -90),
        ('Nube por Z', 30, 45)
    ], 1):
        ax = fig1.add_subplot(2, 2, idx, projection='3d')
        sc = ax.scatter(px, py, pz, c=pz, cmap='jet', s=0.5, alpha=0.15)
        if idx == 4:
            fig1.colorbar(sc, ax=ax, shrink=0.5, label='Pz [mm]', pad=0.08)
            ax.plot([0], [0], [0], 'k*', ms=12)
        ax.set_xlabel('Px [mm]', fontweight='bold', color='#dc2626')
        ax.set_ylabel('Py [mm]', fontweight='bold', color='#059669')
        ax.set_zlabel('Pz [mm]', fontweight='bold', color='#2563eb')
        ax.set_title(title, fontsize=11)
        ax.grid(True, alpha=0.3)
        ax.view_init(elev=elev, azim=azim)

    plt.tight_layout(rect=[0, 0, 1, 0.93])
    plt.savefig('volumen_trabajo_3D.png', dpi=180, bbox_inches='tight')
    print("  → volumen_trabajo_3D.png")
    plt.close()

    # ── Fig 2: Proyecciones 2D ──
    max_2d = min(50000, N)
    s2 = np.random.choice(N, max_2d, replace=False) if N > max_2d else np.arange(N)

    fig2, axes = plt.subplots(1, 3, figsize=(18, 5), facecolor='white')
    fig2.suptitle(f'Proyecciones — {N:,.0f} pts — {step_lin}mm/{step_ang}°',
                  fontsize=12, fontweight='bold')

    for ax, (xd, yd, cd, xl, yl, t) in zip(axes, [
        (Px_all[s2], Py_all[s2], Pz_all[s2],
         'Px [mm]', 'Py [mm]', 'Plano XY'),
        (Px_all[s2], Pz_all[s2], Py_all[s2],
         'Px [mm]', 'Pz [mm]', 'Plano XZ'),
        (Py_all[s2], Pz_all[s2], Px_all[s2],
         'Py [mm]', 'Pz [mm]', 'Plano YZ'),
    ]):
        ax.scatter(xd, yd, c=cd, cmap='jet', s=0.3, alpha=0.2)
        ax.set_xlabel(xl, fontweight='bold')
        ax.set_ylabel(yl, fontweight='bold')
        ax.set_title(t)
        ax.grid(True, alpha=0.3)
        ax.set_aspect('equal')

    plt.tight_layout()
    plt.savefig('proyecciones_volumen.png', dpi=180, bbox_inches='tight')
    print("  → proyecciones_volumen.png")
    plt.close()

    # ── Fig 3: Vista grande robot + nube ──
    fig3 = plt.figure(figsize=(14, 10), facecolor='white')
    ax = fig3.add_subplot(111, projection='3d')
    sc = ax.scatter(px, py, pz, c=pz, cmap='jet', s=0.6, alpha=0.12)
    ax.plot([0], [0], [0], 'k*', ms=14)
    fig3.colorbar(sc, ax=ax, shrink=0.5, label='Pz [mm]', pad=0.06)
    ax.set_xlabel('Px [mm]', fontsize=12, fontweight='bold', color='#dc2626')
    ax.set_ylabel('Py [mm]', fontsize=12, fontweight='bold', color='#059669')
    ax.set_zlabel('Pz [mm]', fontsize=12, fontweight='bold', color='#2563eb')
    ax.set_title(f'Volumen de Trabajo — {N:,.0f} pts — {step_lin}mm/{step_ang}°',
                 fontsize=12, fontweight='bold')
    ax.grid(True, alpha=0.3)
    ax.view_init(elev=25, azim=-55)

    from matplotlib.lines import Line2D
    ax.legend(handles=[
        Line2D([0],[0], color='#059669', lw=4, label=f'd1(Y) [0–{D1_MAX:.0f}] mm'),
        Line2D([0],[0], color='#dc2626', lw=4, label=f'd2(X) [0–{D2_MAX:.0f}] mm'),
        Line2D([0],[0], color='#2563eb', lw=4, label=f'd3(Z) [0–{D3_MAX:.0f}] mm'),
        Line2D([0],[0], color='#7c3aed', lw=1.5, ls='--',
               label=f'Servo [{T4_MIN:.0f}°–{T4_MAX:.0f}°] → θ_real compensado'),
    ], loc='upper left', fontsize=9, framealpha=0.9)

    plt.tight_layout()
    plt.savefig('volumen_robot_3D.png', dpi=200, bbox_inches='tight')
    print("  → volumen_robot_3D.png")
    plt.close()


# ═══════════════════════════════════════════════════════════════════
#  PUNTO 3 — VALIDACIÓN INVERSA (vectorizada)
# ═══════════════════════════════════════════════════════════════════
def punto3_validacion_inversa(noap_all, Px_all, Py_all, Pz_all, q_all, N):
    print("\n" + "=" * 65)
    print("  PUNTO 3 — VALIDACIÓN DE CINEMÁTICA INVERSA")
    print("=" * 65)
    print(f"  NOAPs a validar: {N:,.0f}")

    tol = 1e-4

    print("  Calculando inversa vectorizada...")
    t0 = time.time()

    Px = noap_all[:, 0, 3]
    Py = noap_all[:, 1, 3]
    Pz = noap_all[:, 2, 3]

    d1_inv, d2_inv, d3_inv, servo_inv = ik_batch_from_mth(noap_all)
    noap_ver = mth_batch(d1_inv.astype(np.float32),
                         d2_inv.astype(np.float32),
                         d3_inv.astype(np.float32),
                         servo_inv.astype(np.float32))
    Px_ver = noap_ver[:, 0, 3]
    Py_ver = noap_ver[:, 1, 3]
    Pz_ver = noap_ver[:, 2, 3]

    err = np.sqrt((Px - Px_ver)**2 + (Py - Py_ver)**2 + (Pz - Pz_ver)**2)
    valid = err < tol

    # Rango articular (servo_inv debe estar en [T4_MIN, T4_MAX])
    fuera = ~is_within_limits(d1_inv, d2_inv, d3_inv, servo_inv, tol=tol)
    valid[fuera] = False

    elapsed = time.time() - t0
    n_ok = np.sum(valid)
    pct = 100.0 * n_ok / N

    print(f"  Completado en {elapsed:.1f}s")

    # Guardar
    t0 = time.time()
    save_path = 'validacion_inversa.npz'
    np.savez_compressed(save_path,
                        d1=d1_inv, d2=d2_inv, d3=d3_inv, servo=servo_inv,
                        error=err, valid=valid,
                        q_all=q_all, N=N, tol=tol)
    fsize = os.path.getsize(save_path) / (1024**2)
    print(f"  → validacion_inversa.npz ({fsize:.1f} MB) — {time.time()-t0:.1f}s")

    print(f"\n  {'='*55}")
    print(f"  ESTADÍSTICAS")
    print(f"  {'-'*55}")
    print(f"  Total evaluaciones: {N:,.0f}")
    print(f"  Válidas:            {n_ok:,.0f}  ({pct:.2f}%)")
    print(f"  Inválidas:          {N - n_ok:,.0f}")
    print(f"  Error máximo:       {err.max():.2e} mm")
    print(f"  Error medio:        {err.mean():.2e} mm")
    print(f"  {'='*55}")

    if n_ok == N:
        print(f"\n  >> Cinemática inversa PERFECTA en todo el volumen.")
    else:
        idx_bad = np.where(~valid)[0]
        print(f"\n  --- {len(idx_bad):,.0f} inválidos ---")
        print(f"  d1 fuera: {np.sum((d1_inv[idx_bad]<0)|(d1_inv[idx_bad]>D1_MAX)):,}")
        print(f"  d2 fuera: {np.sum((d2_inv[idx_bad]<0)|(d2_inv[idx_bad]>D2_MAX)):,}")
        print(f"  d3 fuera: {np.sum((d3_inv[idx_bad]<0)|(d3_inv[idx_bad]>D3_MAX)):,}")
        print(f"  Servo fuera: {np.sum((servo_inv[idx_bad]<T4_MIN)|(servo_inv[idx_bad]>T4_MAX)):,}")

    # Muestra primeros 5
    print(f"\n  {'Idx':<8} {'d1':<9} {'d2':<9} {'d3':<9} {'Servo°':<10} {'Err[mm]':<12} Ok")
    for k in range(min(5, N)):
        print(f"  {k+1:<8} {d1_inv[k]:<9.2f} {d2_inv[k]:<9.2f} "
              f"{d3_inv[k]:<9.2f} {servo_inv[k]:<10.3f} {err[k]:<12.2e} {valid[k]}")

    return valid, err


def graficar_validacion(Px_all, Py_all, Pz_all, valid, err, N, tol=1e-4):
    max_pts = min(20000, N)

    fig = plt.figure(figsize=(16, 6), facecolor='white')
    fig.suptitle(f'Validación Inversa — {N:,.0f} pts — {np.sum(valid):,.0f} válidos',
                 fontsize=13, fontweight='bold')

    ax1 = fig.add_subplot(1, 2, 1, projection='3d')
    ok_idx = np.where(valid)[0]
    s_ok = ok_idx[np.random.choice(len(ok_idx), min(max_pts, len(ok_idx)), replace=False)]
    ax1.scatter(Px_all[s_ok], Py_all[s_ok], Pz_all[s_ok],
                c='#22cc66', s=0.4, alpha=0.1, label='Válida')
    bad_idx = np.where(~valid)[0]
    if len(bad_idx) > 0:
        s_bad = bad_idx[np.random.choice(len(bad_idx), min(5000, len(bad_idx)), replace=False)]
        ax1.scatter(Px_all[s_bad], Py_all[s_bad], Pz_all[s_bad],
                    c='#ff3333', s=2, alpha=0.4, label='Inválida')
    ax1.set_xlabel('Px', fontweight='bold', color='#dc2626')
    ax1.set_ylabel('Py', fontweight='bold', color='#059669')
    ax1.set_zlabel('Pz', fontweight='bold', color='#2563eb')
    ax1.legend(fontsize=9)
    ax1.grid(True, alpha=0.3)
    ax1.view_init(elev=25, azim=45)

    ax2 = fig.add_subplot(1, 2, 2)
    log_err = np.log10(err + 1e-16)
    ax2.hist(log_err, bins=80, color='#4488cc', edgecolor='none', alpha=0.8)
    ax2.axvline(np.log10(tol), color='red', ls='--', lw=2, label=f'Tol {tol:.0e}')
    ax2.set_xlabel('log₁₀(Error [mm])', fontweight='bold')
    ax2.set_ylabel('Frecuencia', fontweight='bold')
    ax2.set_title('Distribución del error')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    n_ok = np.sum(valid)
    ax2.text(0.02, 0.95, f'{n_ok:,}/{N:,} ({100*n_ok/N:.1f}%)',
             transform=ax2.transAxes, fontsize=10, va='top',
             bbox=dict(boxstyle='round', facecolor='#eef', alpha=0.8))

    plt.tight_layout()
    plt.savefig('validacion_inversa.png', dpi=180, bbox_inches='tight')
    print("  → validacion_inversa.png")
    plt.close()


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Volumen de trabajo y validación IK — Manipulador PPP+R')
    parser.add_argument('--step-lin', type=float, default=10,
                        help='Paso lineal en mm (default: 10)')
    parser.add_argument('--step-ang', type=float, default=5,
                        help='Paso angular en grados (default: 5)')
    parser.add_argument('--no-plot', action='store_true',
                        help='Solo calcular, no generar gráficas')
    parser.add_argument('--no-ik', action='store_true',
                        help='Solo Punto 2 (sin validación inversa)')
    args = parser.parse_args()

    sl = args.step_lin
    sa = args.step_ang

    print("╔═══════════════════════════════════════════════════════════╗")
    print("║  MANIPULADOR PPP+R — VOLUMEN & VALIDACIÓN                ║")
    print(f"║  Paso: {sl}mm lineal / {sa}° angular{' '*(29-len(f'{sl}mm lineal / {sa}° angular'))}║")
    print("╚═══════════════════════════════════════════════════════════╝\n")

    t_global = time.time()

    # ── PUNTO 2 ──
    noap_all, Px_all, Py_all, Pz_all, q_all, N = \
        punto2_volumen_trabajo(step_lin=sl, step_ang=sa)

    if not args.no_plot:
        print("\n  Generando gráficas...")
        graficar_volumen(Px_all, Py_all, Pz_all, N, sl, sa)

    # ── PUNTO 3 ──
    if not args.no_ik:
        valid, err = punto3_validacion_inversa(
            noap_all, Px_all, Py_all, Pz_all, q_all, N)
        if not args.no_plot:
            graficar_validacion(Px_all, Py_all, Pz_all, valid, err, N)

    elapsed_total = time.time() - t_global
    print(f"\n{'='*65}")
    print(f"  TIEMPO TOTAL: {elapsed_total:.1f}s")
    print(f"  ARCHIVOS:")
    for f in ['noap_all.npz', 'validacion_inversa.npz',
              'volumen_trabajo_3D.png', 'volumen_robot_3D.png',
              'proyecciones_volumen.png', 'validacion_inversa.png']:
        if os.path.exists(f):
            sz = os.path.getsize(f) / (1024**2)
            print(f"    {f:<30} {sz:>8.1f} MB")
    print(f"{'='*65}")
