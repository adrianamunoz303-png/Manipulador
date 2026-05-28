#!/usr/bin/env python3
"""
Export workspace cloud for manipulator.html v1.7.

Usa muestreo aleatorio uniforme en todo el espacio articular para evitar
el efecto de "láminas" que produce el muestreo por pasos.

La cinemática es exactamente la misma que usa el HMI:
  Px = d2  (motor X, eje rojo)
  Py = d1 + L2*(cos(tr) - 1)   (motor Y + brazo)
  Pz = Z_REF - d3 - L2*sin(tr) (altura desde el suelo)
  tr = (t4 - 36) * 90/38

Formato de salida JSON (columnar):
  { "meta": {...}, "d1": [...], "d2": [...], "d3": [...], "t4": [...] }
  NOTA: d1=motorY(0-190), d2=motorX(0-265) — igual que manipulator_kinematics.py

Uso:
  python3 workspace_export.py                      # 1mm/1° referencia, 60k pts
  python3 workspace_export.py --max-pts 100000     # más densidad
  python3 workspace_export.py --max-pts 0          # sin límite (todos los pts del grid)
  python3 workspace_export.py --out /ruta/out.json
"""

import json
import os
import argparse
import numpy as np

from manipulator_kinematics import (
    D1_MAX, D2_MAX, D3_MAX, L2, Z_REF,
    SERVO_MIN, SERVO_MAX,
    theta_real_rad,
)

DEFAULT_MAX_PTS = 60_000


def export_workspace(max_pts=DEFAULT_MAX_PTS, out='public/workspace_cloud.json'):
    """
    Genera max_pts configuraciones aleatorias uniformes en el espacio articular.
    El 'step' de referencia es 1mm/1° solo para calcular n_total en los metadatos.
    """
    step_ref = 1.0
    n1 = int(D1_MAX / step_ref) + 1   # 191
    n2 = int(D2_MAX / step_ref) + 1   # 266
    n3 = int(D3_MAX / step_ref) + 1   # 121
    n4 = int((SERVO_MAX - SERVO_MIN) / step_ref) + 1  # 75
    n_total = n1 * n2 * n3 * n4       # ~460M configuraciones

    n_pts = max_pts if (max_pts and max_pts > 0) else DEFAULT_MAX_PTS

    # Muestreo aleatorio uniforme — evita el efecto de láminas
    rng = np.random.default_rng(42)   # semilla fija → reproducible
    d1 = rng.uniform(0.0, D1_MAX,  n_pts).astype(np.float32)  # motor Y
    d2 = rng.uniform(0.0, D2_MAX,  n_pts).astype(np.float32)  # motor X
    d3 = rng.uniform(0.0, D3_MAX,  n_pts).astype(np.float32)  # motor Z
    t4 = rng.uniform(SERVO_MIN, SERVO_MAX, n_pts).astype(np.float32)  # servo

    # Pz para los bounds (el HMI usa fkClosed, aquí solo para estadísticas)
    tr  = theta_real_rad(t4)
    pz  = (Z_REF - d3 - L2 * np.sin(tr)).astype(np.float32)
    py  = (d1 + L2 * (np.cos(tr) - 1.0)).astype(np.float32)
    px  = d2.copy()

    def r1(arr):
        return np.round(arr, 1).tolist()

    data = {
        "meta": {
            "n_total": int(n_total),
            "n_preview": int(n_pts),
            "sampling": "random_uniform",
            "ref_step_mm_deg": float(step_ref),
            "formula": (
                "Px=d2, Py=d1+L2*(cos(tr)-1), "
                "Pz=Z_REF-d3-L2*sin(tr), tr=(t4-36)*90/38"
            ),
            "Z_REF": float(Z_REF),
            "L2": float(L2),
            "bounds": {
                "Px": [round(float(px.min()), 1), round(float(px.max()), 1)],
                "Py": [round(float(py.min()), 1), round(float(py.max()), 1)],
                "Pz": [round(float(pz.min()), 1), round(float(pz.max()), 1)],
            },
        },
        # d1 = motor Y (0-190 mm)  → HTML q2
        # d2 = motor X (0-265 mm)  → HTML q1
        "d1": r1(d1),
        "d2": r1(d2),
        "d3": r1(d3),
        "t4": r1(t4),
    }

    out_dir = os.path.dirname(os.path.abspath(out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))

    size_kb = os.path.getsize(out) // 1024
    print(
        f"OK: {n_pts:,} pts aleatorios "
        f"(ref. total 1mm/1°: {n_total:,}) → {out} ({size_kb} KB)"
    )
    return data


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Exportar nube workspace para HMI')
    p.add_argument('--max-pts', type=int, default=DEFAULT_MAX_PTS,
                   help='Número de puntos aleatorios (0 = 60 000) (default: 60 000)')
    p.add_argument('--out', default='public/workspace_cloud.json',
                   help='Ruta de salida JSON (default: public/workspace_cloud.json)')
    a = p.parse_args()
    export_workspace(a.max_pts, a.out)
