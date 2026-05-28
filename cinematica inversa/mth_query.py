#!/usr/bin/env python3
"""
Consulta MTH guardadas en MTH/.

Modos:
  1. Por articulaciones:
     python3 mth_query.py --d1 80 --d2 120 --d3 40 --servo 50

  2. Por punto objetivo y servo:
     python3 mth_query.py --px 120 --py 40 --pz 210 --servo 50

  3. Por punto objetivo sin servo:
     python3 mth_query.py --px 120 --py 40 --pz 210 --top-k 10
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time

import numpy as np

from manipulator_kinematics import (
    D1_MAX,
    D2_MAX,
    D3_MAX,
    SERVO_MAX,
    SERVO_MIN,
    enumerate_ik_solutions,
    fk_components,
    ik_from_pose,
    is_within_limits,
    mth_directa,
    quantize_to_step,
)


def load_metadata(root):
    meta_path = os.path.join(root, 'metadata.json')
    if not os.path.exists(meta_path):
        raise FileNotFoundError(f'No existe {meta_path}. Ejecuta primero volumen_completo.py.')
    with open(meta_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def batch_path(root, d1_value):
    return os.path.join(root, 'directa', f'batch_d1_{int(d1_value):03d}mm.npz')


def is_on_grid(value, step, tol=1e-6):
    q = quantize_to_step(value, step)
    return abs(value - q) <= tol, q


def local_index_for_config(meta, d2, d3, servo):
    step_lin = float(meta['steps']['linear_mm'])
    step_ang = float(meta['steps']['angular_deg'])
    n3 = int(meta['counts']['d3'])
    n4 = int(meta['counts']['servo'])
    i2 = int(round(d2 / step_lin))
    i3 = int(round(d3 / step_lin))
    i4 = int(round((servo - SERVO_MIN) / step_ang))
    return i2 * (n3 * n4) + i3 * n4 + i4


def pretty_matrix(m):
    return '\n'.join(
        '  [' + ' '.join(f'{float(v):10.4f}' for v in row) + ']'
        for row in np.asarray(m)
    )


def query_by_joints(meta, d1, d2, d3, servo):
    valid = bool(is_within_limits(d1, d2, d3, servo))
    mth = mth_directa(d1, d2, d3, servo)
    fk = fk_components(d1, d2, d3, servo)

    step_lin = float(meta['steps']['linear_mm'])
    step_ang = float(meta['steps']['angular_deg'])
    on_d1, d1_q = is_on_grid(d1, step_lin)
    on_d2, d2_q = is_on_grid(d2, step_lin)
    on_d3, d3_q = is_on_grid(d3, step_lin)
    on_s, s_q = is_on_grid(servo - SERVO_MIN, step_ang)
    on_grid = on_d1 and on_d2 and on_d3 and on_s

    result = {
        'mode': 'joints',
        'valid_limits': valid,
        'grid_aligned': on_grid,
        'joints': {
            'd1': float(d1),
            'd2': float(d2),
            'd3': float(d3),
            'servo': float(servo),
        },
        'theta_real_deg': float(fk['theta_real_deg']),
        'pose': {
            'Px': float(fk['px']),
            'Py': float(fk['py']),
            'Pz': float(fk['pz']),
        },
        'mth': np.asarray(mth, dtype=float).tolist(),
    }

    if on_grid:
        d1_grid = quantize_to_step(d1_q, step_lin)
        result['storage'] = {
            'batch_file': batch_path(meta['paths']['root'], d1_grid),
            'local_index': local_index_for_config(meta, d2_q, d3_q, quantize_to_step(servo, step_ang)),
        }
    return result


def _candidate_from_solution(meta, sol, target_pose):
    step_lin = float(meta['steps']['linear_mm'])
    step_ang = float(meta['steps']['angular_deg'])
    d1_q = quantize_to_step(sol['d1'], step_lin)
    d2_q = quantize_to_step(sol['d2'], step_lin)
    d3_q = quantize_to_step(sol['d3'], step_lin)
    s_q = quantize_to_step(sol['servo'], step_ang)

    fk = fk_components(d1_q, d2_q, d3_q, s_q)
    err = math.sqrt(
        (float(fk['px']) - target_pose[0]) ** 2 +
        (float(fk['py']) - target_pose[1]) ** 2 +
        (float(fk['pz']) - target_pose[2]) ** 2
    )
    return {
        'joints': {
            'd1': float(d1_q),
            'd2': float(d2_q),
            'd3': float(d3_q),
            'servo': float(s_q),
        },
        'theta_real_deg': float(fk['theta_real_deg']),
        'pose': {
            'Px': float(fk['px']),
            'Py': float(fk['py']),
            'Pz': float(fk['pz']),
        },
        'pose_error_mm': float(err),
        'mth': np.asarray(mth_directa(d1_q, d2_q, d3_q, s_q), dtype=float).tolist(),
        'storage': {
            'batch_file': batch_path(meta['paths']['root'], d1_q),
            'local_index': local_index_for_config(meta, d2_q, d3_q, s_q),
        },
    }


def query_by_pose(meta, px, py, pz, servo=None, top_k=10):
    if servo is not None:
        d1, d2, d3, servo_out, mth = ik_from_pose(px, py, pz, servo)
        valid = bool(is_within_limits(d1, d2, d3, servo_out))
        fk = fk_components(d1, d2, d3, servo_out)
        result = {
            'mode': 'pose+servo',
            'valid_limits': valid,
            'target_pose': {'Px': float(px), 'Py': float(py), 'Pz': float(pz)},
            'joints': {'d1': float(d1), 'd2': float(d2), 'd3': float(d3), 'servo': float(servo_out)},
            'theta_real_deg': float(fk['theta_real_deg']),
            'mth': np.asarray(mth, dtype=float).tolist(),
        }
        step_lin = float(meta['steps']['linear_mm'])
        step_ang = float(meta['steps']['angular_deg'])
        on_grid = (
            is_on_grid(d1, step_lin)[0] and
            is_on_grid(d2, step_lin)[0] and
            is_on_grid(d3, step_lin)[0] and
            is_on_grid(servo_out - SERVO_MIN, step_ang)[0]
        )
        if on_grid:
            d1_q = quantize_to_step(d1, step_lin)
            d2_q = quantize_to_step(d2, step_lin)
            d3_q = quantize_to_step(d3, step_lin)
            s_q = quantize_to_step(servo_out, step_ang)
            result['storage'] = {
                'batch_file': batch_path(meta['paths']['root'], d1_q),
                'local_index': local_index_for_config(meta, d2_q, d3_q, s_q),
            }
        return result

    step_ang = float(meta['steps']['angular_deg'])
    sols = enumerate_ik_solutions(px, py, pz, step_ang=step_ang)
    candidates = [_candidate_from_solution(meta, sol, (px, py, pz)) for sol in sols]
    candidates.sort(key=lambda item: item['pose_error_mm'])
    return {
        'mode': 'pose',
        'target_pose': {'Px': float(px), 'Py': float(py), 'Pz': float(pz)},
        'num_candidates': len(candidates),
        'candidates': candidates[:top_k],
    }


def save_query(root, result):
    os.makedirs(os.path.join(root, 'consultas'), exist_ok=True)
    stamp = time.strftime('%Y%m%d_%H%M%S')
    path = os.path.join(root, 'consultas', f'query_{stamp}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    return path


def main():
    parser = argparse.ArgumentParser(description='Consultar MTH guardadas en MTH/')
    parser.add_argument('--root', default='MTH', help='Carpeta raíz de resultados (default: MTH)')
    parser.add_argument('--d1', type=float)
    parser.add_argument('--d2', type=float)
    parser.add_argument('--d3', type=float)
    parser.add_argument('--servo', type=float)
    parser.add_argument('--px', type=float)
    parser.add_argument('--py', type=float)
    parser.add_argument('--pz', type=float)
    parser.add_argument('--top-k', type=int, default=10)
    parser.add_argument('--save-json', action='store_true', help='Guardar también la consulta en MTH/consultas/')
    args = parser.parse_args()

    meta = load_metadata(args.root)
    by_joints = args.d1 is not None and args.d2 is not None and args.d3 is not None and args.servo is not None
    by_pose = args.px is not None and args.py is not None and args.pz is not None

    if by_joints:
        result = query_by_joints(meta, args.d1, args.d2, args.d3, args.servo)
        print("Consulta por articulaciones")
        print(f"d1={args.d1:.3f}  d2={args.d2:.3f}  d3={args.d3:.3f}  servo={args.servo:.3f}")
        print(f"Pose: Px={result['pose']['Px']:.3f}  Py={result['pose']['Py']:.3f}  Pz={result['pose']['Pz']:.3f}")
        print(f"theta_real={result['theta_real_deg']:.3f}°")
        print("MTH:")
        print(pretty_matrix(result['mth']))
        if 'storage' in result:
            print(f"Lote: {result['storage']['batch_file']}")
            print(f"Índice local: {result['storage']['local_index']}")
    elif by_pose:
        result = query_by_pose(meta, args.px, args.py, args.pz, args.servo, args.top_k)
        print("Consulta por pose")
        print(f"Objetivo: Px={args.px:.3f}  Py={args.py:.3f}  Pz={args.pz:.3f}")
        if args.servo is not None:
            print(f"Servo fijado: {args.servo:.3f}°")
            print(f"Solución: d1={result['joints']['d1']:.3f}  d2={result['joints']['d2']:.3f}  "
                  f"d3={result['joints']['d3']:.3f}  servo={result['joints']['servo']:.3f}")
            print("MTH:")
            print(pretty_matrix(result['mth']))
            if 'storage' in result:
                print(f"Lote: {result['storage']['batch_file']}")
                print(f"Índice local: {result['storage']['local_index']}")
        else:
            print(f"Candidatos encontrados: {result['num_candidates']}")
            for i, cand in enumerate(result['candidates'], 1):
                print(f"[{i}] d1={cand['joints']['d1']:.3f}  d2={cand['joints']['d2']:.3f}  "
                      f"d3={cand['joints']['d3']:.3f}  servo={cand['joints']['servo']:.3f}  "
                      f"err={cand['pose_error_mm']:.4f} mm")
                print(f"    lote={cand['storage']['batch_file']}  idx={cand['storage']['local_index']}")
    else:
        parser.error('Debes indicar una consulta por articulaciones o por pose.')

    if args.save_json:
        out = save_query(args.root, result)
        print(f"Consulta guardada en {out}")


if __name__ == '__main__':
    main()
