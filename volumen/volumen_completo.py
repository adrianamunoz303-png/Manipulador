#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  CÁLCULO COMPLETO DEL VOLUMEN DE TRABAJO — Manipulador PPP+R
Resolución base: 1mm (lineal) × 1° (angular)
  Robótica II — Univ. de Pamplona
═══════════════════════════════════════════════════════════════════════

USO:
  python3 volumen_completo.py                         # 1mm / 1° (completo)
  python3 volumen_completo.py --step-lin 2           # 2mm / 1°
  python3 volumen_completo.py --step-ang 5           # 1mm / 5°
  python3 volumen_completo.py --plot-max-points 0    # intentar graficar todos los puntos
  python3 volumen_completo.py --no-open-viewer       # no abrir visor 3D interactivo
  python3 volumen_completo.py --no-anim              # sin animación
  python3 volumen_completo.py --anim-only            # solo animación

Cinemática directa compensada:
  Pₓ = d₂
  Pᵧ = d₁ + 56·[cos(theta_real) − 1]
  Pz = 295 − d₃ − 56·sin(theta_real)
  theta_real = (servo − 36°) * 90/38

Sección (d₂,d₃,servo): Pₓ y Pz no dependen de d₁; Pᵧ = d₁ + Py_parcial por lote.
MTH = manipulator_kinematics.mth_directa (Rₓ(theta_real) + traslación).
"""

import numpy as np
import os
import sys
import time
import argparse
import json
import shutil
import subprocess

import matplotlib
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
    SERVO_REAL_SCALE,
    Z_REF,
    fk_components,
    ik_batch_from_mth,
    is_within_limits,
    mth_batch,
    mth_directa,
    theta_real_deg,
    theta_real_rad,
)

# ═══════════════════════════════════════════════════════════════════
# CONSTANTES FÍSICAS
# ═══════════════════════════════════════════════════════════════════
L1 = 50.0  # solo geometría visual del robot
T4_MIN = SERVO_MIN
T4_MAX = SERVO_MAX

OUTPUT_ROOT = 'MTH'
DIRECT_ROOT = os.path.join(OUTPUT_ROOT, 'directa')
INVERSE_ROOT = os.path.join(OUTPUT_ROOT, 'inversa')
QUERY_ROOT = os.path.join(OUTPUT_ROOT, 'consultas')
REPORT_ROOT = os.path.join(OUTPUT_ROOT, 'reportes')
DEFAULT_PLOT_MAX_POINTS = 250_000
DEFAULT_VOXEL_MM = 1.0


# ═══════════════════════════════════════════════════════════════════
# RECONSTRUCCIÓN DE MTH
# ═══════════════════════════════════════════════════════════════════
def reconstruir_mth(d1, d2, d3, servo):
    """Reconstruye la MTH 4×4 completa para una configuración."""
    return mth_directa(d1, d2, d3, servo)


def reconstruir_mth_batch(d1_arr, d2_arr, d3_arr, servo_arr):
    """Reconstruye N matrices MTH 4×4 de forma vectorizada."""
    return mth_batch(d1_arr, d2_arr, d3_arr, servo_arr)


def _batch_path(d1_value):
    return os.path.join(DIRECT_ROOT, f'batch_d1_{int(d1_value):03d}mm.npz')


def _write_metadata(step_lin, step_ang, n1, n2, n3, n4, n_cross, n_total):
    os.makedirs(OUTPUT_ROOT, exist_ok=True)
    os.makedirs(DIRECT_ROOT, exist_ok=True)
    os.makedirs(INVERSE_ROOT, exist_ok=True)
    os.makedirs(QUERY_ROOT, exist_ok=True)
    os.makedirs(REPORT_ROOT, exist_ok=True)
    metadata = {
        "version": "2.0",
        "kinematics": "compensated_rx_theta_real",
        "formula": {
            "Px": "d2",
            "Py": "d1 + 56*(cos(theta_real)-1)",
            "Pz": "295 - d3 - 56*sin(theta_real)",
            "theta_real": "(servo-36) * 90/38",
        },
        "ranges": {
            "d1_mm": [0.0, D1_MAX],
            "d2_mm": [0.0, D2_MAX],
            "d3_mm": [0.0, D3_MAX],
            "servo_deg": [T4_MIN, T4_MAX],
        },
        "steps": {
            "linear_mm": float(step_lin),
            "angular_deg": float(step_ang),
        },
        "counts": {
            "d1": int(n1),
            "d2": int(n2),
            "d3": int(n3),
            "servo": int(n4),
            "cross_section": int(n_cross),
            "total": int(n_total),
        },
        "paths": {
            "root": OUTPUT_ROOT,
            "direct_root": DIRECT_ROOT,
            "inverse_root": INVERSE_ROOT,
            "query_root": QUERY_ROOT,
            "batch_pattern": os.path.join(DIRECT_ROOT, "batch_d1_XXXmm.npz"),
        },
    }
    with open(os.path.join(OUTPUT_ROOT, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)


def _build_plot_cloud(Px_cross, Py_partial, Pz_cross, rango_d1, plot_max_points):
    """
    Construye una nube 3D de visualización a partir del barrido completo.

    El cálculo y guardado de MTH SIEMPRE recorre todas las combinaciones.
    Esta función solo decima la nube para que matplotlib pueda dibujarla.
    """
    n_cross = len(Px_cross)
    n_d1 = len(rango_d1)
    n_total = n_cross * n_d1

    if plot_max_points is None or plot_max_points <= 0 or plot_max_points >= n_total:
        stride_d1 = 1
        stride_cross = 1
    else:
        target_d1 = min(n_d1, max(25, int(np.sqrt(plot_max_points * n_d1 / max(n_cross, 1)))))
        target_cross = max(1, plot_max_points // max(target_d1, 1))
        stride_d1 = max(1, int(np.ceil(n_d1 / target_d1)))
        stride_cross = max(1, int(np.ceil(n_cross / target_cross)))

    d1_sel = np.asarray(rango_d1[::stride_d1], dtype=np.float32)
    cross_idx = np.arange(0, n_cross, stride_cross, dtype=np.int64)

    px_sel = np.asarray(Px_cross[cross_idx], dtype=np.float32)
    py_sel = np.asarray(Py_partial[cross_idx], dtype=np.float32)
    pz_sel = np.asarray(Pz_cross[cross_idx], dtype=np.float32)

    px_plot = np.tile(px_sel, len(d1_sel))
    pz_plot = np.tile(pz_sel, len(d1_sel))
    py_plot = np.repeat(d1_sel, len(cross_idx)) + np.tile(py_sel, len(d1_sel))

    return {
        "Px": px_plot,
        "Py": py_plot.astype(np.float32),
        "Pz": pz_plot,
        "d1_stride": stride_d1,
        "cross_stride": stride_cross,
        "n_points": int(len(px_plot)),
        "n_total": int(n_total),
    }


def _sample_mask_points(mask, origin_xyz, voxel_mm, max_points):
    flat = np.flatnonzero(mask.ravel())
    if flat.size == 0:
        return {
            "Px": np.empty(0, dtype=np.float32),
            "Py": np.empty(0, dtype=np.float32),
            "Pz": np.empty(0, dtype=np.float32),
            "count_total": 0,
            "count_preview": 0,
            "stride": 1,
        }

    if max_points is None or max_points <= 0 or flat.size <= max_points:
        stride = 1
        sampled = flat
    else:
        stride = int(np.ceil(flat.size / max_points))
        sampled = flat[::stride]

    ix, iy, iz = np.unravel_index(sampled, mask.shape)
    x0, y0, z0 = origin_xyz

    return {
        "Px": (x0 + ix * voxel_mm).astype(np.float32),
        "Py": (y0 + iy * voxel_mm).astype(np.float32),
        "Pz": (z0 + iz * voxel_mm).astype(np.float32),
        "count_total": int(flat.size),
        "count_preview": int(sampled.size),
        "stride": int(stride),
    }


def _build_boundary_diagnostics(Pz_cross, Py_partial, rango_d1, pz_bin_mm=1.0):
    """
    Diagnóstico de la frontera Py-Pz sin tocar la MTH.

    Para cada franja de Pz calcula el borde izquierdo y derecho alcanzable.
    """
    pz_bins = np.rint(Pz_cross / pz_bin_mm).astype(np.int32)
    unique_bins = np.unique(pz_bins)
    rows = []
    d1_min = float(rango_d1.min())
    d1_max = float(rango_d1.max())

    for key in unique_bins:
        mask = pz_bins == key
        py_left = float(d1_min + np.min(Py_partial[mask]))
        py_right = float(d1_max + np.max(Py_partial[mask]))
        rows.append({
            "Pz_mm": float(key * pz_bin_mm),
            "Py_left_mm": py_left,
            "Py_right_mm": py_right,
            "width_mm": py_right - py_left,
        })

    left = np.array([r["Py_left_mm"] for r in rows], dtype=np.float64)
    right = np.array([r["Py_right_mm"] for r in rows], dtype=np.float64)
    pz = np.array([r["Pz_mm"] for r in rows], dtype=np.float64)

    return {
        "rows": rows,
        "left_boundary_mm": {
            "min": float(left.min()),
            "max": float(left.max()),
            "variation": float(left.max() - left.min()),
            "pz_at_min": float(pz[left.argmin()]),
            "pz_at_max": float(pz[left.argmax()]),
        },
        "right_boundary_mm": {
            "min": float(right.min()),
            "max": float(right.max()),
            "variation": float(right.max() - right.min()),
            "pz_at_min": float(pz[right.argmin()]),
            "pz_at_max": float(pz[right.argmax()]),
        },
    }


def _compute_exact_py_pz_boundary(py_step_mm=0.5, pz_step_mm=0.5, servo_step_deg=0.1):
    """
    Frontera exacta del corte Py-Pz usando la misma MTH y un barrido angular denso.

    No depende del mallado principal del volumen; sirve para verificar si la
    forma de la frontera izquierda/derecha está bien.
    """
    servos = np.arange(SERVO_MIN, SERVO_MAX + 0.001, servo_step_deg, dtype=np.float64)
    tr = theta_real_rad(servos)
    c = np.cos(tr)
    s = np.sin(tr)

    shift_y = L2 * (c - 1.0)
    top_z = Z_REF - L2 * s
    bot_z = Z_REF - D3_MAX - L2 * s

    py_min = float(np.floor(shift_y.min()))
    py_max = float(np.ceil(D1_MAX + shift_y.max()))
    pz_min = float(np.floor(bot_z.min()))
    pz_max = float(np.ceil(top_z.max()))

    py_grid = np.arange(py_min, py_max + 0.001, py_step_mm, dtype=np.float64)
    pz_top_grid = np.full_like(py_grid, np.nan)
    pz_bottom_grid = np.full_like(py_grid, np.nan)

    for i, py in enumerate(py_grid):
        feasible = (shift_y <= py + 1e-12) & (py <= D1_MAX + shift_y + 1e-12)
        if np.any(feasible):
            pz_top_grid[i] = np.max(top_z[feasible])
            pz_bottom_grid[i] = np.min(bot_z[feasible])

    pz_grid = np.arange(pz_min, pz_max + 0.001, pz_step_mm, dtype=np.float64)
    py_left_grid = np.full_like(pz_grid, np.nan)
    py_right_grid = np.full_like(pz_grid, np.nan)

    for i, pz in enumerate(pz_grid):
        feasible = (bot_z <= pz + 1e-12) & (pz <= top_z + 1e-12)
        if np.any(feasible):
            py_left_grid[i] = np.min(shift_y[feasible])
            py_right_grid[i] = np.max(D1_MAX + shift_y[feasible])

    left_valid = ~np.isnan(py_left_grid)
    right_valid = ~np.isnan(py_right_grid)

    return {
        "py_grid_mm": py_grid.astype(np.float32),
        "pz_top_mm": pz_top_grid.astype(np.float32),
        "pz_bottom_mm": pz_bottom_grid.astype(np.float32),
        "pz_grid_mm": pz_grid.astype(np.float32),
        "py_left_mm": py_left_grid.astype(np.float32),
        "py_right_mm": py_right_grid.astype(np.float32),
        "meta": {
            "py_step_mm": float(py_step_mm),
            "pz_step_mm": float(pz_step_mm),
            "servo_step_deg": float(servo_step_deg),
            "left_cap_width_mm": float(np.nanmax(py_left_grid) - np.nanmin(py_left_grid[left_valid])),
            "right_cap_width_mm": float(np.nanmax(py_right_grid[right_valid]) - np.nanmin(py_right_grid[right_valid])),
            "top_flat_start_py_mm": float(np.min(py_grid[np.isclose(pz_top_grid, np.nanmax(pz_top_grid), atol=1e-3)])),
            "top_flat_end_py_mm": float(np.max(py_grid[np.isclose(pz_top_grid, np.nanmax(pz_top_grid), atol=1e-3)])),
        },
    }


def _save_exact_boundary_artifacts(boundary):
    npz_path = os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.npz")
    csv_path = os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.csv")
    fig_path = os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.png")

    np.savez_compressed(
        npz_path,
        py_grid_mm=boundary["py_grid_mm"],
        pz_top_mm=boundary["pz_top_mm"],
        pz_bottom_mm=boundary["pz_bottom_mm"],
        pz_grid_mm=boundary["pz_grid_mm"],
        py_left_mm=boundary["py_left_mm"],
        py_right_mm=boundary["py_right_mm"],
        meta=json.dumps(boundary["meta"], ensure_ascii=False),
    )

    with open(csv_path, "w", encoding="utf-8") as f:
        f.write("Py_mm,Pz_top_mm,Pz_bottom_mm\n")
        for py, pzt, pzb in zip(boundary["py_grid_mm"], boundary["pz_top_mm"], boundary["pz_bottom_mm"]):
            if not np.isnan(pzt):
                f.write(f"{float(py):.3f},{float(pzt):.3f},{float(pzb):.3f}\n")

    py = boundary["py_grid_mm"]
    pzt = boundary["pz_top_mm"]
    pzb = boundary["pz_bottom_mm"]
    pz = boundary["pz_grid_mm"]
    pyl = boundary["py_left_mm"]
    pyr = boundary["py_right_mm"]

    fig, axes = plt.subplots(1, 2, figsize=(15, 6), facecolor="white")

    ax = axes[0]
    mask = ~np.isnan(pzt)
    ax.plot(py[mask], pzt[mask], color="#dc2626", lw=2, label="Frontera superior")
    ax.plot(py[mask], pzb[mask], color="#2563eb", lw=2, label="Frontera inferior")
    ax.fill_between(py[mask], pzb[mask], pzt[mask], color="#22c55e", alpha=0.10)
    ax.set_title("Frontera Exacta del Corte Py-Pz", fontweight="bold")
    ax.set_xlabel("Py [mm]")
    ax.set_ylabel("Pz [mm]")
    ax.grid(True, alpha=0.25)
    ax.legend()

    ax = axes[1]
    mask2 = ~np.isnan(pyl)
    ax.plot(pyl[mask2], pz[mask2], color="#7c3aed", lw=2, label="Borde izquierdo")
    ax.plot(pyr[mask2], pz[mask2], color="#f59e0b", lw=2, label="Borde derecho")
    ax.set_title("Bordes Izquierdo y Derecho vs Pz", fontweight="bold")
    ax.set_xlabel("Py [mm]")
    ax.set_ylabel("Pz [mm]")
    ax.grid(True, alpha=0.25)
    ax.legend()

    plt.tight_layout()
    plt.savefig(fig_path, dpi=220, bbox_inches="tight")
    plt.close(fig)

    return npz_path, csv_path, fig_path


def _write_hmi_diagnostics(step_lin, step_ang, voxel_mm, result, ik_summary=None):
    """
    Escribe un resumen listo para HMI con hallazgos y limitaciones del workspace.
    """
    diag = result["boundary_diag"]
    exact = result["exact_boundary"]
    reach = result["reachability_map"]

    left_var = float(exact["meta"]["left_cap_width_mm"])
    right_var = float(exact["meta"]["right_cap_width_mm"])
    if left_var <= 10.0:
        left_title = "Recorte leve en el lado izquierdo"
        left_tail = "por eso visualmente casi se ve recta."
    else:
        left_title = "Recorte visible en el lado izquierdo"
        left_tail = "con este paso de muestreo ya se aprecia claramente."

    findings = [
        {
            "type": "workspace_limitation",
            "title": "Borde superior e inferior recortado por el servo",
            "detail": "La frontera real no llena una caja completa; el último eje rotacional recorta la zona alta y baja del workspace.",
        },
        {
            "type": "workspace_asymmetry",
            "title": "Recorte fuerte en el lado derecho",
            "detail": f"La frontera derecha en Py cambia {right_var:.2f} mm entre zonas de Pz; esa mordida es la principal limitación visible.",
        },
        {
            "type": "workspace_asymmetry",
            "title": left_title,
            "detail": f"La frontera izquierda también se recorta {left_var:.2f} mm; {left_tail}",
        },
        {
            "type": "modeling_note",
            "title": "No usar ConvexHull como workspace real",
            "detail": "La envolvente geométrica rellena huecos no alcanzables. Para HMI debe usarse el mapa voxelizado y su frontera real.",
        },
    ]

    if ik_summary:
        if abs(float(ik_summary["pct"]) - 100.0) < 1e-9:
            findings.append({
                "type": "validation_ok",
                "title": "Cinemática inversa consistente",
                "detail": "La validación de IK sobre las MTH generadas no mostró fallos numéricos dentro del barrido ejecutado.",
            })
        else:
            findings.append({
                "type": "validation_warning",
                "title": "Se detectaron configuraciones con error IK",
                "detail": f"Validación IK = {ik_summary['pct']:.4f}% correcta. Revisar validacion_ejemplos.json.",
            })

    summary = {
        "run": {
            "step_lin_mm": float(step_lin),
            "step_ang_deg": float(step_ang),
            "voxel_mm": float(voxel_mm),
            "configurations_total": int(result["N_total"]),
        },
        "workspace": {
            "reachable_volume_cm3": float(reach["reachable_volume_cm3"]),
            "reachable_volume_mm3": float(reach["reachable_volume_mm3"]),
            "occupied_voxels": int(reach["occupied_count"]),
            "shell_voxels": int(reach["shell_count"]),
            "bbox": reach["bbox"],
        },
        "boundary_py_pz": {
            "left": diag["left_boundary_mm"],
            "right": diag["right_boundary_mm"],
            "exact_meta": exact["meta"],
        },
        "ik_validation": ik_summary,
        "findings": findings,
        "files": {
            "interactive_map": os.path.join(OUTPUT_ROOT, "alcance_voxelizado.npz"),
            "interactive_viewer": os.path.abspath(os.path.join(os.path.dirname(__file__), "workspace_3d_viewer.py")),
            "report_png": result["latest_report_path"],
            "exact_boundary_npz": os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.npz"),
            "exact_boundary_csv": os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.csv"),
            "exact_boundary_png": os.path.join(OUTPUT_ROOT, "frontera_real_py_pz.png"),
            "ik_summary_npz": os.path.join(INVERSE_ROOT, "validacion_resumen.npz"),
            "ik_examples_json": os.path.join(INVERSE_ROOT, "validacion_ejemplos.json"),
        },
    }

    json_path = os.path.join(OUTPUT_ROOT, "diagnostico_hmi.json")
    txt_path = os.path.join(OUTPUT_ROOT, "diagnostico_hmi.txt")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    lines = [
        "DIAGNOSTICO PARA HMI",
        "",
        f"Barrido: {step_lin} mm / {step_ang}°",
        f"Resolucion voxel: {voxel_mm} mm",
        f"Configuraciones evaluadas: {result['N_total']:,}",
        f"Volumen alcanzable: {reach['reachable_volume_cm3']:.2f} cm3",
        f"Frontera izquierda (variacion): {left_var:.2f} mm",
        f"Frontera derecha (variacion): {right_var:.2f} mm",
        "",
        "Hallazgos:",
    ]
    for item in findings:
        lines.append(f"- {item['title']}: {item['detail']}")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    return json_path, txt_path


def _build_reachability_map(Px_cross, Py_partial, Pz_cross, rango_d1, voxel_mm=DEFAULT_VOXEL_MM,
                            preview_max_points=DEFAULT_PLOT_MAX_POINTS):
    """
    Mapea el workspace real en una rejilla cartesiana de vóxeles.

    No cambia la cinemática: solo marca qué puntos del espacio SÍ quedan
    ocupados por alguna configuración articular del barrido exhaustivo.
    """
    from scipy.ndimage import binary_erosion, generate_binary_structure

    x_min = float(np.floor(Px_cross.min() / voxel_mm) * voxel_mm)
    x_max = float(np.ceil(Px_cross.max() / voxel_mm) * voxel_mm)
    y_min = float(np.floor(Py_partial.min() / voxel_mm) * voxel_mm)
    y_max = float(np.ceil((rango_d1[-1] + Py_partial.max()) / voxel_mm) * voxel_mm)
    z_min = float(np.floor(Pz_cross.min() / voxel_mm) * voxel_mm)
    z_max = float(np.ceil(Pz_cross.max() / voxel_mm) * voxel_mm)

    nx = int(round((x_max - x_min) / voxel_mm)) + 1
    ny = int(round((y_max - y_min) / voxel_mm)) + 1
    nz = int(round((z_max - z_min) / voxel_mm)) + 1

    occupancy = np.zeros((nx, ny, nz), dtype=bool)

    ix = np.rint((Px_cross - x_min) / voxel_mm).astype(np.int32)
    iz = np.rint((Pz_cross - z_min) / voxel_mm).astype(np.int32)

    print(f"       Rejilla cartesiana: {nx} × {ny} × {nz} = {nx*ny*nz:,} vóxeles")
    t0 = time.time()
    for i, d1_val in enumerate(rango_d1):
        iy = np.rint((d1_val + Py_partial - y_min) / voxel_mm).astype(np.int32)
        occupancy[ix, iy, iz] = True
        if i % 20 == 0 or i == len(rango_d1) - 1:
            print(f"       [{i+1:3d}/{len(rango_d1)}] capa d1={d1_val:5.0f}mm")

    occupied_count = int(occupancy.sum())
    structure = generate_binary_structure(3, 1)
    shell = occupancy & ~binary_erosion(occupancy, structure=structure, border_value=0)
    shell_count = int(shell.sum())
    elapsed = time.time() - t0

    reachable_volume_mm3 = occupied_count * (voxel_mm ** 3)
    reachable_volume_cm3 = reachable_volume_mm3 / 1e3
    reachable_volume_m3 = reachable_volume_mm3 / 1e9

    reachable_preview = _sample_mask_points(occupancy, (x_min, y_min, z_min), voxel_mm, preview_max_points)
    shell_preview = _sample_mask_points(shell, (x_min, y_min, z_min), voxel_mm, preview_max_points)

    return {
        "occupancy": occupancy,
        "shell": shell,
        "origin_xyz": np.array([x_min, y_min, z_min], dtype=np.float32),
        "shape_xyz": np.array([nx, ny, nz], dtype=np.int32),
        "voxel_mm": float(voxel_mm),
        "occupied_count": occupied_count,
        "shell_count": shell_count,
        "reachable_volume_mm3": float(reachable_volume_mm3),
        "reachable_volume_cm3": float(reachable_volume_cm3),
        "reachable_volume_m3": float(reachable_volume_m3),
        "elapsed_s": float(elapsed),
        "reachable_preview": reachable_preview,
        "shell_preview": shell_preview,
        "bbox": {
            "Px_min": x_min, "Px_max": x_max,
            "Py_min": y_min, "Py_max": y_max,
            "Pz_min": z_min, "Pz_max": z_max,
        },
    }


def _copy_latest_report(src_path):
    latest_path = os.path.join(REPORT_ROOT, 'ultimo_reporte_volumen.png')
    shutil.copyfile(src_path, latest_path)
    return latest_path


def _open_file_default_app(path):
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif os.name == 'nt':
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(['xdg-open', path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception as exc:
        print(f"  Aviso: no se pudo abrir automáticamente el reporte ({exc})")
        return False


def _launch_interactive_viewer(cloud_path=None, map_path=None, mode='shell'):
    viewer_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'workspace_3d_viewer.py')
    if not os.path.exists(viewer_script):
        print(f"  Aviso: no existe el visor interactivo {viewer_script}")
        return False

    try:
        cmd = [sys.executable, viewer_script, '--mode', mode]
        if map_path:
            cmd.extend(['--map', map_path])
        elif cloud_path:
            cmd.extend(['--cloud', cloud_path, '--mode', 'cloud'])
        else:
            print("  Aviso: no hay datos para abrir el visor interactivo")
            return False
        subprocess.Popen(
            cmd,
            cwd=os.path.dirname(viewer_script),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception as exc:
        print(f"  Aviso: no se pudo abrir el visor 3D interactivo ({exc})")
        return False


def _generar_reporte_final(Px, Pz_cross, pts_2d, hull, plot_cloud, reachability_map,
                           area_2d, height, vol_mm3, vol_cm3, vol_m3, N_total,
                           step_lin, step_ang, Py_min, Py_max, Pz_min, Pz_max):
    """
    Genera una infografía final resumida y la guarda con marca de tiempo.
    """
    stamp = time.strftime('%Y%m%d_%H%M%S')
    os.makedirs(REPORT_ROOT, exist_ok=True)
    report_path = os.path.join(REPORT_ROOT, f'reporte_volumen_{stamp}.png')

    plot_px = np.asarray(plot_cloud['Px'], dtype=np.float32)
    plot_py = np.asarray(plot_cloud['Py'], dtype=np.float32)
    plot_pz = np.asarray(plot_cloud['Pz'], dtype=np.float32)
    shell_px = np.asarray(reachability_map['shell_preview']['Px'], dtype=np.float32)
    shell_py = np.asarray(reachability_map['shell_preview']['Py'], dtype=np.float32)
    shell_pz = np.asarray(reachability_map['shell_preview']['Pz'], dtype=np.float32)
    reachable_cm3 = float(reachability_map['reachable_volume_cm3'])

    fig = plt.figure(figsize=(18, 10), facecolor='#f4f4f4')
    gs = fig.add_gridspec(2, 3, width_ratios=[1.05, 1.2, 1.5], height_ratios=[1.0, 1.0])

    ax_summary = fig.add_subplot(gs[:, 0])
    ax_section = fig.add_subplot(gs[0, 1])
    ax_proj = fig.add_subplot(gs[1, 1])
    ax_cloud = fig.add_subplot(gs[:, 2], projection='3d')

    ax_summary.set_facecolor('#fffaf0')
    ax_summary.axis('off')
    summary_lines = [
        'REPORTE FINAL',
        '',
        'Barrido exhaustivo:',
        f'  d1 = 0..{D1_MAX:.0f} mm',
        f'  d2 = 0..{D2_MAX:.0f} mm',
        f'  d3 = 0..{D3_MAX:.0f} mm',
        f'  servo = {T4_MIN:.0f}..{T4_MAX:.0f}°',
        '',
        f'Paso lineal: {step_lin} mm',
        f'Paso angular: {step_ang}°',
        f'Total configuraciones: {N_total:,}',
        '',
        'Rangos del efector:',
        f'  Px = {Px.min():.1f} .. {Px.max():.1f} mm',
        f'  Py = {Py_min:.1f} .. {Py_max:.1f} mm',
        f'  Pz = {Pz_min:.1f} .. {Pz_max:.1f} mm',
        '',
        f'Área 2D Px-Pz: {area_2d:,.1f} mm²',
        f'Altura Py: {height:,.1f} mm',
        f'Envolvente: {vol_cm3:,.2f} cm³',
        '',
        'Mapa de alcanzabilidad real:',
        f'  Vóxel = {reachability_map["voxel_mm"]:.1f} mm',
        f'  Vóxeles alcanzables = {reachability_map["occupied_count"]:,}',
        f'  Frontera = {reachability_map["shell_count"]:,}',
        f'  Vol. alcanzable = {reachable_cm3:,.2f} cm³',
        '',
        'Vista de nube:',
        f'  {len(plot_px):,} puntos mostrados',
        f'  stride d1 = {plot_cloud["d1_stride"]}',
        f'  stride sección = {plot_cloud["cross_stride"]}',
        '',
        f'Generado: {stamp}',
    ]
    ax_summary.text(
        0.05, 0.98, '\n'.join(summary_lines),
        va='top', ha='left', fontsize=12, family='monospace', color='#1f2937'
    )

    hv = hull.vertices
    hull_closed = np.append(hv, hv[0])
    ax_section.scatter(Px, Pz_cross, s=0.25, alpha=0.10, c='#2563eb')
    ax_section.plot(pts_2d[hull_closed, 0], pts_2d[hull_closed, 1], color='#dc2626', lw=2.0)
    ax_section.fill(pts_2d[hull_closed, 0], pts_2d[hull_closed, 1], color='#fb923c', alpha=0.15)
    ax_section.set_title('Sección de Trabajo Px-Pz', fontsize=12, fontweight='bold')
    ax_section.set_xlabel('Px [mm]')
    ax_section.set_ylabel('Pz [mm]')
    ax_section.grid(True, alpha=0.25)
    ax_section.set_aspect('equal')

    ax_proj.scatter(shell_px, shell_py, s=0.45, alpha=0.24, c='#1d4ed8', label='Frontera Px-Py')
    ax_proj.scatter(shell_pz, shell_py, s=0.45, alpha=0.16, c='#059669', label='Frontera Pz-Py')
    ax_proj.set_title('Proyecciones de la Frontera Real', fontsize=12, fontweight='bold')
    ax_proj.set_xlabel('Px o Pz [mm]')
    ax_proj.set_ylabel('Py [mm]')
    ax_proj.grid(True, alpha=0.25)
    ax_proj.legend(fontsize=9, loc='best')

    ax_cloud.scatter(shell_px, shell_py, shell_pz, s=0.9, alpha=0.24, c=shell_pz, cmap='viridis', linewidths=0)
    ax_cloud.set_title('Frontera Real del Workspace 3D', fontsize=13, fontweight='bold')
    ax_cloud.set_xlabel('Px [mm]')
    ax_cloud.set_ylabel('Py [mm]')
    ax_cloud.set_zlabel('Pz [mm]')
    ax_cloud.view_init(elev=22, azim=-55)
    ax_cloud.grid(True, alpha=0.20)

    fig.suptitle('Manipulador PPP+R — Infografía de Volumen de Trabajo',
                 fontsize=18, fontweight='bold', y=0.98)
    plt.tight_layout(rect=(0, 0, 1, 0.965))
    plt.savefig(report_path, dpi=220, bbox_inches='tight')
    plt.close(fig)

    latest_path = _copy_latest_report(report_path)
    return report_path, latest_path


# ═══════════════════════════════════════════════════════════════════
# CÁLCULO DEL VOLUMEN DE TRABAJO
# ═══════════════════════════════════════════════════════════════════
def calcular_volumen(step_lin=1, step_ang=1, plot_max_points=DEFAULT_PLOT_MAX_POINTS,
                     voxel_mm=DEFAULT_VOXEL_MM):
    """
    Calcula y guarda el volumen de trabajo completo.
    Guarda en MTH/ la sección transversal y lotes por d1.
    """
    print("=" * 65)
    print("  CÁLCULO COMPLETO — VOLUMEN DE TRABAJO PPP+R")
    print("  T₀₄ compensada con Rₓ(theta_real)")
    print(f"  theta_real = (servo - {SERVO_HOME:.0f}) * {SERVO_REAL_SCALE:.6f}")
    print("=" * 65)

    rango_d1    = np.arange(0, D1_MAX + 0.01, step_lin, dtype=np.float32)
    rango_d2    = np.arange(0, D2_MAX + 0.01, step_lin, dtype=np.float32)
    rango_d3    = np.arange(0, D3_MAX + 0.01, step_lin, dtype=np.float32)
    rango_servo = np.arange(T4_MIN, T4_MAX + 0.01, step_ang, dtype=np.float32)

    n1, n2, n3, n4 = len(rango_d1), len(rango_d2), len(rango_d3), len(rango_servo)
    N_cross = n2 * n3 * n4
    N_total = n1 * N_cross
    _write_metadata(step_lin, step_ang, n1, n2, n3, n4, N_cross, N_total)

    print(f"\n  Paso lineal:   {step_lin} mm")
    print(f"  Paso angular:  {step_ang}°")
    print(f"  d1:    {n1:>6} vals  [0, {D1_MAX:.0f}] mm")
    print(f"  d2:    {n2:>6} vals  [0, {D2_MAX:.0f}] mm")
    print(f"  d3:    {n3:>6} vals  [0, {D3_MAX:.0f}] mm")
    print(f"  servo: {n4:>6} vals  [{T4_MIN:.0f}, {T4_MAX:.0f}]°")
    print(f"  Sección transversal:  {N_cross:>15,} pts  (d2 × d3 × servo)")
    print(f"  TOTAL configuraciones:{N_total:>15,} pts  ({N_total/1e6:.1f}M)")
    print(f"  Barrido exhaustivo:    SI, se recorren todas las combinaciones")

    # ── Sección transversal (independiente de d1) ──
    print(f"\n  [1/5] Calculando sección transversal...")
    t0 = time.time()

    D2g, D3g, SRVg = np.meshgrid(rango_d2, rango_d3, rango_servo, indexing='ij')
    d2_flat    = D2g.ravel().astype(np.float32)
    d3_flat    = D3g.ravel().astype(np.float32)
    servo_flat = SRVg.ravel().astype(np.float32)

    fk_cross = fk_components(np.zeros_like(d2_flat), d2_flat, d3_flat, servo_flat)
    C4 = np.asarray(fk_cross['c'], dtype=np.float32)
    S4 = np.asarray(fk_cross['s'], dtype=np.float32)
    theta_real = np.asarray(fk_cross['theta_real_deg'], dtype=np.float32)
    Px = np.asarray(fk_cross['px'], dtype=np.float32)
    Py_partial = np.asarray(fk_cross['py'], dtype=np.float32)
    Pz_cross = np.asarray(fk_cross['pz'], dtype=np.float32)

    print(f"       {time.time()-t0:.1f}s — {N_cross:,} puntos calculados")
    print(f"       Px: [{Px.min():.1f}, {Px.max():.1f}] mm")
    print(f"       Py parcial: [{Py_partial.min():.1f}, {Py_partial.max():.1f}] mm")
    print(f"       Pz: [{Pz_cross.min():.1f}, {Pz_cross.max():.1f}] mm")

    # ── Guardar sección transversal ──
    print(f"  [2/5] Guardando datos en {DIRECT_ROOT}/...")
    t0 = time.time()
    os.makedirs(DIRECT_ROOT, exist_ok=True)

    cross_path = os.path.join(DIRECT_ROOT, 'seccion_transversal.npz')
    np.savez_compressed(cross_path,
        d2=d2_flat, d3=d3_flat, servo=servo_flat,
        theta_real_deg=theta_real,
        C4=C4, S4=S4, Px=Px, Pz_cross=Pz_cross, Py_partial=Py_partial,
        rango_d1=rango_d1,
        step_lin=np.float32(step_lin), step_ang=np.float32(step_ang),
        params=np.array([L2, Z_REF, D1_MAX, D2_MAX, D3_MAX,
                         T4_MIN, T4_MAX, SERVO_HOME, SERVO_REAL_SCALE], dtype=np.float32))

    cs_size = os.path.getsize(cross_path)
    print(f"       {time.time()-t0:.1f}s — {cross_path} ({cs_size/1e6:.1f} MB)")

    # ── Guardar lotes con MTH completas por d1 ──
    print(f"  [3/5] Guardando {n1} lotes de MTH completas...")
    t0 = time.time()
    batch_sizes = []

    for i, d1_val in enumerate(rango_d1):
        d1_arr = np.full(N_cross, d1_val, dtype=np.float32)
        Py = (d1_arr + Py_partial).astype(np.float32)
        Pz = Pz_cross.astype(np.float32)
        mth = reconstruir_mth_batch(d1_arr, d2_flat, d3_flat, servo_flat)

        fname = _batch_path(d1_val)
        np.savez_compressed(fname, mth=mth,
                            d1=d1_val, d2=d2_flat, d3=d3_flat, servo=servo_flat,
                            theta_real_deg=theta_real,
                            Px=Px, Py=Py, Pz=Pz)
        batch_sizes.append(os.path.getsize(fname))

        if i % 20 == 0 or i == n1 - 1:
            elapsed = time.time() - t0
            eta = elapsed / (i + 1) * (n1 - i - 1) if i > 0 else 0
            size_so_far = sum(batch_sizes) / 1e9
            print(f"       [{i+1:3d}/{n1}] d1={d1_val:5.0f}mm  "
                  f"({elapsed:.0f}s, ETA ~{eta:.0f}s, {size_so_far:.2f} GB)")

    total_batch_size = sum(batch_sizes)
    print(f"       Completado: {time.time()-t0:.0f}s — "
          f"{total_batch_size/1e9:.2f} GB en {n1} archivos")

    # ── Mapa de alcanzabilidad real en vóxeles cartesianos ──
    print(f"  [4/6] Mapeando workspace real por ocupación cartesiana...")
    t0 = time.time()
    reachability_map = _build_reachability_map(
        Px, Py_partial, Pz_cross, rango_d1,
        voxel_mm=voxel_mm,
        preview_max_points=plot_max_points,
    )
    reachability_path = os.path.join(OUTPUT_ROOT, 'alcance_voxelizado.npz')
    np.savez_compressed(
        reachability_path,
        occupancy=reachability_map['occupancy'],
        shell=reachability_map['shell'],
        origin_xyz=reachability_map['origin_xyz'],
        shape_xyz=reachability_map['shape_xyz'],
        voxel_mm=np.float32(reachability_map['voxel_mm']),
        occupied_count=np.int64(reachability_map['occupied_count']),
        shell_count=np.int64(reachability_map['shell_count']),
        reachable_volume_mm3=np.float64(reachability_map['reachable_volume_mm3']),
        reachable_volume_cm3=np.float64(reachability_map['reachable_volume_cm3']),
        reachable_volume_m3=np.float64(reachability_map['reachable_volume_m3']),
        preview_reachable_Px=reachability_map['reachable_preview']['Px'],
        preview_reachable_Py=reachability_map['reachable_preview']['Py'],
        preview_reachable_Pz=reachability_map['reachable_preview']['Pz'],
        preview_shell_Px=reachability_map['shell_preview']['Px'],
        preview_shell_Py=reachability_map['shell_preview']['Py'],
        preview_shell_Pz=reachability_map['shell_preview']['Pz'],
        preview_reachable_stride=np.int32(reachability_map['reachable_preview']['stride']),
        preview_shell_stride=np.int32(reachability_map['shell_preview']['stride']),
    )
    print(f"       {time.time()-t0:.1f}s")
    print(f"       Vóxeles alcanzables: {reachability_map['occupied_count']:,}")
    print(f"       Frontera real:       {reachability_map['shell_count']:,}")
    print(f"       Volumen real:        {reachability_map['reachable_volume_cm3']:,.2f} cm³")
    print(f"       → {reachability_path}")

    # ── Volumen por ConvexHull 2D × altura (envolvente) ──
    print(f"  [5/6] Calculando envolvente (ConvexHull en plano Px–Pz × altura Py)...")
    t0 = time.time()

    from scipy.spatial import ConvexHull

    pts_2d = np.column_stack([Px, Pz_cross]).astype(np.float64)
    hull = ConvexHull(pts_2d)
    area_2d = hull.volume  # en 2D, .volume = área

    Py_min = float(Py_partial.min())
    Py_max = float(D1_MAX + Py_partial.max())
    height = Py_max - Py_min
    Pz_min = float(Pz_cross.min())
    Pz_max = float(Pz_cross.max())

    vol_mm3 = area_2d * height
    vol_cm3 = vol_mm3 / 1e3
    vol_m3  = vol_mm3 / 1e9

    print(f"       {time.time()-t0:.1f}s")

    # Guardar resumen
    np.savez(os.path.join(OUTPUT_ROOT, 'volumen_info.npz'),
             area_2d=area_2d, height=height,
             vol_mm3=vol_mm3, vol_cm3=vol_cm3,
             Px_min=Px.min(), Px_max=Px.max(),
             Py_min=Py_min, Py_max=Py_max,
             Pz_min=Pz_min, Pz_max=Pz_max,
             N_total=N_total, N_cross=N_cross,
             hull_vertices_Px=pts_2d[hull.vertices, 0],
             hull_vertices_Pz=pts_2d[hull.vertices, 1])

    # ── Gráficas ──
    print(f"  [6/6] Generando gráficas...")
    t0 = time.time()
    plot_cloud = _build_plot_cloud(Px, Py_partial, Pz_cross, rango_d1, plot_max_points)
    plot_cloud_path = os.path.join(OUTPUT_ROOT, 'nube_puntos_preview.npz')
    np.savez_compressed(
        plot_cloud_path,
        Px=plot_cloud['Px'],
        Py=plot_cloud['Py'],
        Pz=plot_cloud['Pz'],
        step_lin=np.float32(step_lin),
        step_ang=np.float32(step_ang),
        d1_stride=np.int32(plot_cloud['d1_stride']),
        cross_stride=np.int32(plot_cloud['cross_stride']),
        n_total=np.int64(plot_cloud['n_total']),
    )
    print(f"       Nube 3D para gráfica: {plot_cloud['n_points']:,} puntos "
          f"(stride d1={plot_cloud['d1_stride']}, stride sección={plot_cloud['cross_stride']})")
    print(f"       Frontera preview:     {reachability_map['shell_preview']['count_preview']:,} puntos "
          f"(stride={reachability_map['shell_preview']['stride']})")
    exact_boundary = _compute_exact_py_pz_boundary(py_step_mm=max(0.25, voxel_mm / 2.0),
                                                   pz_step_mm=max(0.25, voxel_mm / 2.0),
                                                   servo_step_deg=0.1)
    exact_npz, exact_csv, exact_png = _save_exact_boundary_artifacts(exact_boundary)
    print(f"       Frontera exacta Py-Pz verificada")
    print(f"       → {exact_npz}")
    print(f"       → {exact_csv}")
    print(f"       → {exact_png}")
    _generar_graficas(Px, Pz_cross, rango_d1, hull, pts_2d, area_2d, height,
                      vol_mm3, vol_cm3, N_total, step_lin, step_ang,
                      Py_min, Py_max, Py_partial, plot_cloud, reachability_map)
    report_path, latest_report_path = _generar_reporte_final(
        Px, Pz_cross, pts_2d, hull, plot_cloud, reachability_map, area_2d, height,
        vol_mm3, vol_cm3, vol_m3, N_total, step_lin, step_ang,
        Py_min, Py_max, Pz_min, Pz_max
    )
    print(f"       → {report_path}")
    print(f"       → {latest_report_path}")
    print(f"       {time.time()-t0:.1f}s")

    # ── Resumen final ──
    total_disk = (
        cs_size
        + total_batch_size
        + os.path.getsize(os.path.join(OUTPUT_ROOT, 'volumen_info.npz'))
        + os.path.getsize(reachability_path)
    )

    print(f"\n  {'═'*60}")
    print(f"  RESULTADOS — VOLUMEN DE TRABAJO")
    print(f"  {'═'*60}")
    print(f"  Configuraciones totales:  {N_total:>15,}")
    print(f"  Sección transversal:      {N_cross:>15,} pts")
    print(f"  Rango Px (d2):           [{Px.min():.1f}, {Px.max():.1f}] mm")
    print(f"  Rango Pz:                [{Pz_min:.1f}, {Pz_max:.1f}] mm")
    print(f"  Rango Py:                [{Py_min:.1f}, {Py_max:.1f}] mm")
    print(f"  Vóxel cartesiano:         {voxel_mm:>12.1f} mm")
    print(f"  Vóxeles alcanzables:      {reachability_map['occupied_count']:>15,}")
    print(f"  Frontera real:            {reachability_map['shell_count']:>15,}")
    print(f"  Volumen real (ocupación): {reachability_map['reachable_volume_cm3']:>12,.2f} cm³")
    print(f"  Área 2D (ConvexHull Px–Pz): {area_2d:>12,.0f} mm²")
    print(f"  Altura (extensión Py):    {height:>12,.0f} mm")
    print(f"  ┌──────────────────────────────────────────────────┐")
    print(f"  │  V. REAL = {reachability_map['reachable_volume_mm3']:>14,.0f}  mm³                 │")
    print(f"  │          = {reachability_map['reachable_volume_cm3']:>14,.2f}  cm³                 │")
    print(f"  │          = {reachability_map['reachable_volume_m3']:>14,.6f}  m³                  │")
    print(f"  └──────────────────────────────────────────────────┘")
    print(f"  Envolvente ConvexHull:    {vol_cm3:>12,.2f} cm³")
    print(f"  Disco total: {total_disk/1e9:.2f} GB ({n1} lotes + sección + info)")
    print(f"  {'═'*60}")

    return {
        'Px': Px, 'Pz_cross': Pz_cross, 'Py_partial': Py_partial, 'rango_d1': rango_d1,
        'hull': hull, 'pts_2d': pts_2d,
        'vol_mm3': vol_mm3, 'vol_cm3': vol_cm3,
        'area_2d': area_2d, 'height': height,
        'N_total': N_total, 'N_cross': N_cross,
        'd2': d2_flat, 'd3': d3_flat, 'servo': servo_flat,
        'plot_cloud': plot_cloud,
        'plot_cloud_path': plot_cloud_path,
        'reachability_map_path': reachability_path,
        'reachability_map': reachability_map,
        'boundary_diag': _build_boundary_diagnostics(Pz_cross, Py_partial, rango_d1, pz_bin_mm=voxel_mm),
        'exact_boundary': exact_boundary,
        'exact_boundary_paths': {
            'npz': exact_npz,
            'csv': exact_csv,
            'png': exact_png,
        },
        'report_path': report_path,
        'latest_report_path': latest_report_path,
    }


def validar_inversa_guardada(rango_d1, tol=1e-4):
    """
    Recorre los lotes de MTH guardados por FK, aplica IK cerrada y verifica
    que la reconstrucción coincida con la MTH original.
    """
    print("\n" + "=" * 65)
    print("  VALIDACIÓN POR CINEMÁTICA INVERSA")
    print("=" * 65)
    os.makedirs(INVERSE_ROOT, exist_ok=True)

    d1_vals = []
    n_points = []
    n_valid = []
    max_err = []
    mean_err = []
    global_examples = []

    t0 = time.time()
    for i, d1_val in enumerate(rango_d1):
        batch_path = _batch_path(d1_val)
        batch = np.load(batch_path)
        mth = batch['mth']

        d1_inv, d2_inv, d3_inv, servo_inv = ik_batch_from_mth(mth)
        mth_ver = mth_batch(d1_inv.astype(np.float32),
                            d2_inv.astype(np.float32),
                            d3_inv.astype(np.float32),
                            servo_inv.astype(np.float32))
        err = np.linalg.norm((mth_ver - mth).reshape(mth.shape[0], -1), axis=1)
        valid = (err < tol) & is_within_limits(d1_inv, d2_inv, d3_inv, servo_inv, tol=tol)

        d1_vals.append(float(d1_val))
        n_points.append(int(mth.shape[0]))
        n_valid.append(int(np.sum(valid)))
        max_err.append(float(err.max()))
        mean_err.append(float(err.mean()))

        bad_idx = np.where(~valid)[0]
        if bad_idx.size:
            for k in bad_idx[:3]:
                global_examples.append({
                    "batch_d1": float(d1_val),
                    "index": int(k),
                    "err": float(err[k]),
                    "d1": float(d1_inv[k]),
                    "d2": float(d2_inv[k]),
                    "d3": float(d3_inv[k]),
                    "servo": float(servo_inv[k]),
                })

        if i % 20 == 0 or i == len(rango_d1) - 1:
            print(f"       [{i+1:3d}/{len(rango_d1)}] d1={d1_val:5.0f}mm  "
                  f"max_err={err.max():.2e}  valid={np.sum(valid):,}/{len(valid):,}")

    summary_path = os.path.join(INVERSE_ROOT, 'validacion_resumen.npz')
    np.savez_compressed(
        summary_path,
        d1=np.asarray(d1_vals, dtype=np.float32),
        n_points=np.asarray(n_points, dtype=np.int64),
        n_valid=np.asarray(n_valid, dtype=np.int64),
        max_err=np.asarray(max_err, dtype=np.float32),
        mean_err=np.asarray(mean_err, dtype=np.float32),
        tol=np.float32(tol),
    )
    with open(os.path.join(INVERSE_ROOT, 'validacion_ejemplos.json'), 'w', encoding='utf-8') as f:
        json.dump(global_examples, f, indent=2, ensure_ascii=False)

    total_points = int(np.sum(n_points))
    total_valid = int(np.sum(n_valid))
    pct = 100.0 * total_valid / total_points if total_points else 0.0
    print(f"  → {summary_path}")
    print(f"  Total validado: {total_valid:,}/{total_points:,} ({pct:.4f}%)")
    print(f"  Error máximo global: {max(max_err) if max_err else 0.0:.2e}")
    print(f"  Tiempo validación IK: {time.time()-t0:.1f}s")

    return {
        'total_points': total_points,
        'total_valid': total_valid,
        'pct': pct,
        'max_err': max(max_err) if max_err else 0.0,
        'summary_path': summary_path,
    }


def _generar_graficas(Px, Pz_cross, rango_d1, hull, pts_2d, area_2d, height,
                      vol_mm3, vol_cm3, N_total, step_lin, step_ang,
                      Py_min, Py_max, Py_partial, plot_cloud, reachability_map):
    """Genera las gráficas del volumen de trabajo."""

    plot_px = np.asarray(plot_cloud['Px'], dtype=np.float32)
    plot_py = np.asarray(plot_cloud['Py'], dtype=np.float32)
    plot_pz = np.asarray(plot_cloud['Pz'], dtype=np.float32)
    shell_px = np.asarray(reachability_map['shell_preview']['Px'], dtype=np.float32)
    shell_py = np.asarray(reachability_map['shell_preview']['Py'], dtype=np.float32)
    shell_pz = np.asarray(reachability_map['shell_preview']['Pz'], dtype=np.float32)

    # ── Fig 1: Sección transversal 2D + ConvexHull ──
    fig1, axes1 = plt.subplots(1, 2, figsize=(16, 7), facecolor='white')

    ax = axes1[0]
    sub_n = min(50000, len(Px))
    idx = np.random.choice(len(Px), sub_n, replace=False)
    ax.scatter(Px[idx], Pz_cross[idx], s=0.3, alpha=0.15, c='steelblue')
    hv = hull.vertices
    hull_closed = np.append(hv, hv[0])
    ax.plot(pts_2d[hull_closed, 0], pts_2d[hull_closed, 1],
            'r-', lw=2, label=f'ConvexHull (A={area_2d:.0f} mm²)')
    ax.fill(pts_2d[hull_closed, 0], pts_2d[hull_closed, 1],
            alpha=0.1, color='red')
    ax.set_xlabel('Px [mm] (d2)', fontsize=12, fontweight='bold')
    ax.set_ylabel('Pz [mm]', fontsize=12, fontweight='bold')
    ax.set_title(f'Sección (Px, Pz)\n{len(Px):,} puntos — '
                 f'paso {step_lin}mm/{step_ang}°', fontsize=11)
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)
    ax.set_aspect('equal')

    ax = axes1[1]
    ax.barh(['Px\n(d2)', 'Pz\n(295-d3-56·sin)', 'Py\n(d1+56·(cos-1))'],
            [Px.max()-Px.min(), Pz_cross.max()-Pz_cross.min(), Py_max-Py_min],
            left=[Px.min(), Pz_cross.min(), Py_min],
            color=['#dc2626', '#059669', '#2563eb'], alpha=0.7, height=0.6)
    ax.set_xlabel('mm', fontsize=12)
    ax.set_title(f'Rangos del efector final\nVol = {vol_cm3:,.2f} cm³', fontsize=11)
    ax.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_ROOT, 'volumen_seccion_2D.png'), dpi=200, bbox_inches='tight')
    plt.close()
    print(f"       → {os.path.join(OUTPUT_ROOT, 'volumen_seccion_2D.png')}")

    # ── Fig 2: Volumen 3D (nube de puntos) ──
    fig2 = plt.figure(figsize=(14, 10), facecolor='white')
    ax3 = fig2.add_subplot(111, projection='3d')

    ax3.scatter(shell_px, shell_py, shell_pz,
                s=0.8, alpha=0.22, c=shell_pz, cmap='viridis', linewidths=0)

    ax3.set_xlabel('X [mm] — Px', fontsize=11, fontweight='bold', color='#dc2626')
    ax3.set_ylabel('Y [mm] — Py', fontsize=11, fontweight='bold', color='#2563eb')
    ax3.set_zlabel('Z [mm] — Pz', fontsize=11, fontweight='bold', color='#059669')
    ax3.set_title(f'Frontera Real del Workspace — {N_total:,.0f} configuraciones\n'
                  f'Vol. real = {reachability_map["reachable_volume_cm3"]:,.2f} cm³  ({step_lin}mm/{step_ang}°)\n'
                  f'Vista de frontera: {len(shell_px):,} puntos del barrido total',
                  fontsize=13, fontweight='bold')
    ax3.view_init(elev=22, azim=-55)
    ax3.grid(True, alpha=0.2)

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_ROOT, 'volumen_3D.png'), dpi=200, bbox_inches='tight')
    plt.close()
    print(f"       → {os.path.join(OUTPUT_ROOT, 'volumen_3D.png')}")

    # ── Fig 3: Proyecciones ortogonales ──
    fig3, axes3 = plt.subplots(1, 3, figsize=(18, 5.5), facecolor='white')
    fig3.suptitle(f'Proyecciones de la Frontera Real — Vol = {reachability_map["reachable_volume_cm3"]:,.2f} cm³ — '
                  f'{N_total:,.0f} configs (vista: {len(shell_px):,})', fontsize=12, fontweight='bold')

    for ai, (xd, yd, xl, yl, tl) in enumerate([
        (shell_px, shell_pz, 'Px (d2)', 'Pz', 'Px–Pz'),
        (shell_px, shell_py, 'Px (d2)', 'Py', 'Px–Py'),
        (shell_pz, shell_py, 'Pz', 'Py', 'Pz–Py'),
    ]):
        ax = axes3[ai]
        ax.scatter(xd, yd, s=0.5, alpha=0.18, c='steelblue')
        ax.set_xlabel(xl, fontsize=10)
        ax.set_ylabel(yl, fontsize=10)
        ax.set_title(tl, fontsize=10, fontweight='bold')
        ax.grid(True, alpha=0.3)
        ax.set_aspect('equal')

    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_ROOT, 'volumen_proyecciones.png'), dpi=200, bbox_inches='tight')
    plt.close()
    print(f"       → {os.path.join(OUTPUT_ROOT, 'volumen_proyecciones.png')}")


# ═══════════════════════════════════════════════════════════════════
# ANIMACIÓN DEL MANIPULADOR
# ═══════════════════════════════════════════════════════════════════
def generar_animacion(n_frames=200, fps=20):
    """
    Genera una animación GIF del manipulador recorriendo el workspace.
    Muestra el robot moviéndose por diferentes configuraciones.
    """
    print("\n" + "=" * 65)
    print("  GENERANDO ANIMACIÓN DEL MANIPULADOR")
    print("=" * 65)

    sys.path.insert(0, os.path.dirname(__file__))
    from robot_visualizer import build_robot, add_floor_and_axes
    from manipulator_kinematics import pose_directa

    n_seg = 5
    frames_per_seg = n_frames // n_seg

    trajectory = []

    d1_c, d2_c, d3_c, sv_c = 95, 130, 60, 55

    # Segmento 1: barrer d1 (0 → 190)
    for d1v in np.linspace(0, D1_MAX, frames_per_seg):
        trajectory.append((d1v, d2_c, d3_c, sv_c))

    # Segmento 2: barrer d2 (0 → 265)
    for d2v in np.linspace(0, D2_MAX, frames_per_seg):
        trajectory.append((D1_MAX/2, d2v, d3_c, sv_c))

    # Segmento 3: barrer d3 (0 → 120)
    for d3v in np.linspace(0, D3_MAX, frames_per_seg):
        trajectory.append((D1_MAX/2, D2_MAX/2, d3v, sv_c))

    # Segmento 4: barrer servo (0 → 110)
    for svv in np.linspace(T4_MIN, T4_MAX, frames_per_seg):
        trajectory.append((D1_MAX/2, D2_MAX/2, D3_MAX/2, svv))

    # Segmento 5: todos juntos (diagonal)
    for t in np.linspace(0, 1, frames_per_seg):
        trajectory.append((
            D1_MAX * t,
            D2_MAX * t,
            D3_MAX * (1-t),
            T4_MIN + (T4_MAX-T4_MIN) * t,
        ))

    trajectory = trajectory[:n_frames]

    print(f"  Frames: {len(trajectory)}")
    print(f"  Segmentos: d1 → d2 → d3 → servo → diagonal")

    from matplotlib.animation import FuncAnimation, PillowWriter

    fig = plt.figure(figsize=(12, 9), facecolor='#f0f2f5')
    ax = fig.add_subplot(111, projection='3d', computed_zorder=False)

    ef_trail_x, ef_trail_y, ef_trail_z = [], [], []

    def update(frame_idx):
        ax.cla()
        ax.set_facecolor('#f0f2f5')

        d1v, d2v, d3v, svv = trajectory[frame_idx]

        add_floor_and_axes(ax)
        build_robot(ax, d1v, d2v, d3v, svv)

        Px, Py, Pz = pose_directa(d1v, d2v, d3v, svv)
        ef_trail_x.append(Px + 50)
        ef_trail_y.append(Pz + 50 + 190 + 50 - L1)
        ef_trail_z.append(Py + (190 + 50 + 50 + 10) - 9)

        if len(ef_trail_x) > 1:
            ax.plot(ef_trail_x, ef_trail_y, ef_trail_z,
                    color='#f59e0b', lw=1.5, alpha=0.7)

        seg = frame_idx // frames_per_seg
        seg_names = ['Barrido d1', 'Barrido d2', 'Barrido d3',
                     'Barrido servo', 'Diagonal']
        seg_name = seg_names[min(seg, len(seg_names)-1)]

        ax.set_title(
            f'Animación — {seg_name}\n'
            f'd1={d1v:.0f} d2={d2v:.0f} d3={d3v:.0f} '
            f'θ₄={svv:.0f}°\n'
            f'Frame {frame_idx+1}/{len(trajectory)}',
            fontsize=11, fontweight='bold')

        ax.set_xlim(-40, 350)
        ax.set_ylim(-30, 240)
        ax.set_zlim(0, 340)
        ax.grid(True, alpha=0.15)
        ax.view_init(elev=20, azim=-55 + frame_idx * 0.3)

        if frame_idx % 20 == 0:
            print(f"       Frame {frame_idx+1}/{len(trajectory)}...")

    print("  Renderizando frames...")
    t0 = time.time()

    anim = FuncAnimation(fig, update, frames=len(trajectory),
                         interval=1000//fps, blit=False)

    os.makedirs(OUTPUT_ROOT, exist_ok=True)
    gif_path = os.path.join(OUTPUT_ROOT, 'animacion_manipulador.gif')
    anim.save(gif_path, writer=PillowWriter(fps=fps))
    plt.close()

    gif_size = os.path.getsize(gif_path)
    print(f"  → {gif_path} ({gif_size/1e6:.1f} MB) — {time.time()-t0:.0f}s")
    print(f"  {len(trajectory)} frames @ {fps} fps = {len(trajectory)/fps:.1f}s de animación")


# ═══════════════════════════════════════════════════════════════════
# EJEMPLO: CARGAR Y RECONSTRUIR MTH
# ═══════════════════════════════════════════════════════════════════
def ejemplo_uso():
    """Muestra cómo cargar los datos guardados y reconstruir MTH."""
    print("\n" + "=" * 65)
    print("  EJEMPLO — CÓMO ACCEDER A LAS MTH GUARDADAS")
    print("=" * 65)

    data = np.load(os.path.join(DIRECT_ROOT, 'seccion_transversal.npz'))
    d2    = data['d2']
    d3    = data['d3']
    servo = data['servo']
    Px    = data['Px']
    d1_range = data['rango_d1']

    print(f"\n  Sección transversal: {len(d2):,} puntos")
    print(f"  Rango d1: {len(d1_range)} valores [{d1_range[0]:.0f}, {d1_range[-1]:.0f}]")

    print(f"\n  Ejemplo: reconstruir MTH para punto #1000, d1=50mm:")
    i = min(1000, len(d2) - 1)
    d1_val = 50.0
    M = reconstruir_mth(d1_val, d2[i], d3[i], servo[i])
    print(f"  q = (d1={d1_val}, d2={d2[i]:.0f}, d3={d3[i]:.0f}, servo={servo[i]:.0f}°)")
    print(f"  Px={M[0,3]:.2f}  Py={M[1,3]:.2f}  Pz={M[2,3]:.2f}")
    print(f"  MTH =")
    for row in M:
        print(f"    [{row[0]:8.4f} {row[1]:8.4f} {row[2]:8.4f} {row[3]:10.4f}]")

    print(f"\n  Ejemplo: cargar lote d1=100mm completo:")
    batch = np.load(_batch_path(100))
    mth_batch = batch['mth']
    print(f"  {mth_batch.shape[0]:,} matrices MTH 4×4 cargadas")
    print(f"  Memoria: {mth_batch.nbytes/1e6:.1f} MB")

    k = min(500, mth_batch.shape[0] - 1)
    print(f"\n  MTH #{k} del lote:")
    for row in mth_batch[k]:
        print(f"    [{row[0]:8.4f} {row[1]:8.4f} {row[2]:8.4f} {row[3]:10.4f}]")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Volumen de trabajo completo PPP+R')
    parser.add_argument('--step-lin', type=int, default=1,
                        help='Paso lineal en mm (default: 1)')
    parser.add_argument('--step-ang', type=int, default=1,
                        help='Paso angular en grados (default: 1)')
    parser.add_argument('--plot-max-points', type=int, default=DEFAULT_PLOT_MAX_POINTS,
                        help='Máximo de puntos a mostrar en la nube 3D/proyecciones (default: 250000, 0 = usar todos)')
    parser.add_argument('--voxel-mm', type=float, default=DEFAULT_VOXEL_MM,
                        help='Resolución del mapa cartesiano de alcanzabilidad en mm (default: 1.0)')
    parser.add_argument('--no-open-viewer', action='store_true',
                        help='No abrir automáticamente el visor 3D interactivo al terminar')
    parser.add_argument('--no-open-report', action='store_true',
                        help='No abrir automáticamente la infografía final al terminar')
    parser.add_argument('--no-ik', action='store_true',
                        help='Omitir validación por cinemática inversa')
    parser.add_argument('--no-anim', action='store_true',
                        help='Omitir generación de animación')
    parser.add_argument('--anim-only', action='store_true',
                        help='Solo generar animación (requiere MTH/ existente)')
    parser.add_argument('--anim-frames', type=int, default=200,
                        help='Número de frames de la animación')
    parser.add_argument('--anim-fps', type=int, default=15,
                        help='FPS de la animación')
    args = parser.parse_args()

    t_global = time.time()

    if not args.anim_only:
        result = calcular_volumen(
            args.step_lin,
            args.step_ang,
            plot_max_points=args.plot_max_points,
            voxel_mm=args.voxel_mm,
        )
        ik_summary = None
        if not args.no_ik:
            ik_summary = validar_inversa_guardada(result['rango_d1'])
        ejemplo_uso()
        hmi_json, hmi_txt = _write_hmi_diagnostics(
            args.step_lin,
            args.step_ang,
            args.voxel_mm,
            result,
            ik_summary=ik_summary,
        )
        print(f"  → {hmi_json}")
        print(f"  → {hmi_txt}")

    if not args.no_anim:
        generar_animacion(n_frames=args.anim_frames, fps=args.anim_fps)

    viewer_opened = False
    if not args.anim_only and not args.no_open_viewer:
        cloud_path = result.get('plot_cloud_path')
        map_path = result.get('reachability_map_path')
        if cloud_path or map_path:
            viewer_opened = _launch_interactive_viewer(cloud_path=cloud_path, map_path=map_path, mode='shell')
            if viewer_opened:
                print(f"\n  Visor 3D interactivo abierto: {map_path or cloud_path}")

    if not args.anim_only and not args.no_open_report and not viewer_opened:
        target = result.get('latest_report_path') or result.get('report_path')
        if target:
            opened = _open_file_default_app(target)
            if opened:
                print(f"\n  Reporte abierto automáticamente: {target}")

    print(f"\n  Tiempo total: {time.time()-t_global:.0f}s ({(time.time()-t_global)/60:.1f} min)")
    print("  ¡Terminado!")
