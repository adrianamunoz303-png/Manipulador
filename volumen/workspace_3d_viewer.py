#!/usr/bin/env python3
"""
Visor 3D interactivo de la nube de puntos del volumen de trabajo.

Uso:
  python3 workspace_3d_viewer.py
  python3 workspace_3d_viewer.py --cloud MTH/nube_puntos_preview.npz
  python3 workspace_3d_viewer.py --map MTH/alcance_voxelizado.npz --mode shell
  python3 workspace_3d_viewer.py --point-size 1.2 --alpha 0.35
"""

from __future__ import annotations

import argparse
import os

import numpy as np


def _load_pyplot(use_agg=False):
    import matplotlib
    if use_agg:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def _set_equal_box_aspect(ax, x, y, z):
    xr = max(float(np.ptp(x)), 1.0)
    yr = max(float(np.ptp(y)), 1.0)
    zr = max(float(np.ptp(z)), 1.0)
    ax.set_box_aspect((xr, yr, zr))


def _load_cloud_from_npz(path):
    data = np.load(path)
    return (
        np.asarray(data['Px'], dtype=np.float32),
        np.asarray(data['Py'], dtype=np.float32),
        np.asarray(data['Pz'], dtype=np.float32),
        os.path.basename(path),
    )


def _load_preview_from_map(path, mode):
    data = np.load(path)
    if mode == 'reachable':
        px = np.asarray(data['preview_reachable_Px'], dtype=np.float32)
        py = np.asarray(data['preview_reachable_Py'], dtype=np.float32)
        pz = np.asarray(data['preview_reachable_Pz'], dtype=np.float32)
    else:
        px = np.asarray(data['preview_shell_Px'], dtype=np.float32)
        py = np.asarray(data['preview_shell_Py'], dtype=np.float32)
        pz = np.asarray(data['preview_shell_Pz'], dtype=np.float32)
    return px, py, pz, os.path.basename(path)


def main():
    parser = argparse.ArgumentParser(description='Visor 3D interactivo del volumen de trabajo')
    parser.add_argument('--map', default='MTH/alcance_voxelizado.npz',
                        help='Mapa voxelizado NPZ (default: MTH/alcance_voxelizado.npz)')
    parser.add_argument('--cloud', default='MTH/nube_puntos_preview.npz',
                        help='Archivo NPZ con Px, Py, Pz (default: MTH/nube_puntos_preview.npz)')
    parser.add_argument('--mode', choices=['shell', 'reachable', 'cloud'], default='shell',
                        help='Qué visualizar: frontera real, mapa alcanzable o nube heredada')
    parser.add_argument('--point-size', type=float, default=1.0,
                        help='Tamaño de punto para la nube')
    parser.add_argument('--alpha', type=float, default=0.28,
                        help='Transparencia de la nube (0..1)')
    parser.add_argument('--save-png', default='',
                        help='Si se indica, guarda una captura PNG del visor')
    parser.add_argument('--no-show', action='store_true',
                        help='No abrir ventana; útil si solo quieres guardar PNG')
    args = parser.parse_args()

    plt = _load_pyplot(use_agg=bool(args.no_show))

    if args.mode == 'cloud':
        source_path = os.path.abspath(args.cloud)
        if not os.path.exists(source_path):
            raise FileNotFoundError(f'No existe la nube de puntos: {source_path}')
        px, py, pz, source_name = _load_cloud_from_npz(source_path)
        title = 'Volumen de Trabajo 3D'
    else:
        source_path = os.path.abspath(args.map)
        if not os.path.exists(source_path):
            raise FileNotFoundError(f'No existe el mapa voxelizado: {source_path}')
        px, py, pz, source_name = _load_preview_from_map(source_path, args.mode)
        title = 'Frontera Real del Workspace 3D' if args.mode == 'shell' else 'Workspace Alcanzable 3D'

    fig = plt.figure(figsize=(12, 9), facecolor='white')
    ax = fig.add_subplot(111, projection='3d')
    sc = ax.scatter(px, py, pz,
                    s=args.point_size,
                    c=pz,
                    cmap='viridis',
                    alpha=args.alpha,
                    linewidths=0,
                    depthshade=False)

    ax.set_title(f'{title}\n{len(px):,} puntos visibles',
                 fontsize=14, fontweight='bold')
    ax.set_xlabel('Px [mm]')
    ax.set_ylabel('Py [mm]')
    ax.set_zlabel('Pz [mm]')
    _set_equal_box_aspect(ax, px, py, pz)
    ax.view_init(elev=22, azim=-55)
    ax.grid(True, alpha=0.20)
    cbar = fig.colorbar(sc, ax=ax, pad=0.08, shrink=0.85)
    cbar.set_label('Pz [mm]')

    info = (
        f'Archivo: {source_name}\n'
        f'Modo: {args.mode}\n'
        f'Px: {px.min():.1f} .. {px.max():.1f} mm\n'
        f'Py: {py.min():.1f} .. {py.max():.1f} mm\n'
        f'Pz: {pz.min():.1f} .. {pz.max():.1f} mm'
    )
    fig.text(0.015, 0.02, info, fontsize=10, family='monospace', color='#334155')
    plt.tight_layout(rect=(0, 0.04, 1, 1))

    if args.save_png:
        out_png = os.path.abspath(args.save_png)
        fig.savefig(out_png, dpi=220, bbox_inches='tight')
        print(f'Captura guardada en {out_png}')

    if args.no_show:
        plt.close(fig)
    else:
        plt.show()


if __name__ == '__main__':
    main()
