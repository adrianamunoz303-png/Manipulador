#!/usr/bin/env python3
"""
Cinématica compensada del manipulador PPP+R.

Convención operativa:
  X = d2
  Y = d1 + L2 * (cos(theta_real) - 1)
  Z = Z_REF - d3 - L2 * sin(theta_real)

MTH cerrada:
  [ 1    0      0      X ]
  [ 0   cos   -sin     Y ]
  [ 0   sin    cos     Z ]
  [ 0    0      0      1 ]

La entrada articular del servo es el ángulo REAL que se manda al servo
en el rango [0, 74] grados. Para entrar a cos/sin se compensa con:

  theta_real = (servo_deg - SERVO_HOME) * SERVO_REAL_SCALE
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


L2 = 56.0
Z_REF = 295.0

D1_MAX = 190.0
D2_MAX = 265.0
D3_MAX = 120.0

SERVO_MIN = 0.0
SERVO_MAX = 74.0
SERVO_HOME = 36.0
SERVO_REAL_SCALE = 90.0 / (SERVO_MAX - SERVO_HOME)

FLOAT_TOL = 1e-6


@dataclass(frozen=True)
class Limits:
    d1: tuple[float, float] = (0.0, D1_MAX)
    d2: tuple[float, float] = (0.0, D2_MAX)
    d3: tuple[float, float] = (0.0, D3_MAX)
    servo: tuple[float, float] = (SERVO_MIN, SERVO_MAX)


LIMITS = Limits()


def _as_f64(value):
    return np.asarray(value, dtype=np.float64)


def theta_real_deg(servo_deg):
    servo = _as_f64(servo_deg)
    return (servo - SERVO_HOME) * SERVO_REAL_SCALE


def theta_real_rad(servo_deg):
    return np.deg2rad(theta_real_deg(servo_deg))


def servo_from_theta_real_deg(theta_deg):
    theta = _as_f64(theta_deg)
    return theta / SERVO_REAL_SCALE + SERVO_HOME


def is_within_limits(d1, d2, d3, servo_deg, tol=FLOAT_TOL):
    d1a = _as_f64(d1)
    d2a = _as_f64(d2)
    d3a = _as_f64(d3)
    sa = _as_f64(servo_deg)
    return (
        (d1a >= LIMITS.d1[0] - tol) & (d1a <= LIMITS.d1[1] + tol) &
        (d2a >= LIMITS.d2[0] - tol) & (d2a <= LIMITS.d2[1] + tol) &
        (d3a >= LIMITS.d3[0] - tol) & (d3a <= LIMITS.d3[1] + tol) &
        (sa >= LIMITS.servo[0] - tol) & (sa <= LIMITS.servo[1] + tol)
    )


def fk_components(d1, d2, d3, servo_deg):
    d1a = _as_f64(d1)
    d2a = _as_f64(d2)
    d3a = _as_f64(d3)
    servo = _as_f64(servo_deg)

    tr = theta_real_rad(servo)
    c = np.cos(tr)
    s = np.sin(tr)

    px = d2a
    py_base = d1a
    pz_base = Z_REF - d3a
    dpy = L2 * (c - 1.0)
    dpz = -L2 * s

    return {
        "servo_deg": servo,
        "theta_real_deg": np.rad2deg(tr),
        "theta_real_rad": tr,
        "c": c,
        "s": s,
        "px": px,
        "py": py_base + dpy,
        "pz": pz_base + dpz,
        "py_base": py_base,
        "pz_base": pz_base,
        "dpy": dpy,
        "dpz": dpz,
    }


def pose_directa(d1, d2, d3, servo_deg):
    fk = fk_components(d1, d2, d3, servo_deg)
    return fk["px"], fk["py"], fk["pz"]


def mth_directa(d1, d2, d3, servo_deg):
    fk = fk_components(d1, d2, d3, servo_deg)
    return np.array([
        [1.0,     0.0,      0.0,      fk["px"]],
        [0.0, fk["c"], -fk["s"],      fk["py"]],
        [0.0, fk["s"],  fk["c"],      fk["pz"]],
        [0.0,     0.0,      0.0,          1.0],
    ], dtype=np.float32)


def mth_batch(d1_arr, d2_arr, d3_arr, servo_arr):
    fk = fk_components(d1_arr, d2_arr, d3_arr, servo_arr)
    px = np.asarray(fk["px"], dtype=np.float32)
    py = np.asarray(fk["py"], dtype=np.float32)
    pz = np.asarray(fk["pz"], dtype=np.float32)
    c = np.asarray(fk["c"], dtype=np.float32)
    s = np.asarray(fk["s"], dtype=np.float32)

    n = len(px)
    mth = np.zeros((n, 4, 4), dtype=np.float32)
    mth[:, 0, 0] = 1.0
    mth[:, 1, 1] = c
    mth[:, 1, 2] = -s
    mth[:, 2, 1] = s
    mth[:, 2, 2] = c
    mth[:, 3, 3] = 1.0
    mth[:, 0, 3] = px
    mth[:, 1, 3] = py
    mth[:, 2, 3] = pz
    return mth


def target_mth(px, py, pz, servo_deg):
    tr = theta_real_rad(servo_deg)
    c = float(np.cos(tr))
    s = float(np.sin(tr))
    return np.array([
        [1.0, 0.0, 0.0, float(px)],
        [0.0, c,  -s,  float(py)],
        [0.0, s,   c,  float(pz)],
        [0.0, 0.0, 0.0, 1.0],
    ], dtype=np.float32)


def ik_from_pose(px, py, pz, servo_deg):
    tr = theta_real_rad(servo_deg)
    c = np.cos(tr)
    s = np.sin(tr)

    d2 = float(px)
    d1 = float(py - L2 * (c - 1.0))
    d3 = float(Z_REF - pz - L2 * s)
    servo = float(servo_deg)
    return d1, d2, d3, servo, mth_directa(d1, d2, d3, servo)


def ik_from_mth(mth):
    m = np.asarray(mth, dtype=np.float64)
    px = float(m[0, 3])
    py = float(m[1, 3])
    pz = float(m[2, 3])
    tr = math.atan2(float(m[2, 1]), float(m[2, 2]))
    c = math.cos(tr)
    s = math.sin(tr)
    d2 = px
    d1 = py - L2 * (c - 1.0)
    d3 = Z_REF - pz - L2 * s
    servo = float(servo_from_theta_real_deg(math.degrees(tr)))
    return d1, d2, d3, servo, mth_directa(d1, d2, d3, servo)


def ik_batch_from_mth(mth_all):
    m = np.asarray(mth_all, dtype=np.float64)
    px = m[:, 0, 3]
    py = m[:, 1, 3]
    pz = m[:, 2, 3]
    tr = np.arctan2(m[:, 2, 1], m[:, 2, 2])
    c = np.cos(tr)
    s = np.sin(tr)
    d2 = px
    d1 = py - L2 * (c - 1.0)
    d3 = Z_REF - pz - L2 * s
    servo = servo_from_theta_real_deg(np.rad2deg(tr))
    return d1, d2, d3, servo


def servo_grid(step_ang=1.0):
    return np.arange(SERVO_MIN, SERVO_MAX + 0.01, step_ang, dtype=np.float32)


def linear_grid(max_value, step_lin=1.0):
    return np.arange(0.0, max_value + 0.01, step_lin, dtype=np.float32)


def enumerate_ik_solutions(px, py, pz, step_ang=1.0, tol=FLOAT_TOL):
    servos = servo_grid(step_ang=step_ang)
    tr = theta_real_rad(servos)
    c = np.cos(tr)
    s = np.sin(tr)

    d2 = np.full_like(servos, float(px), dtype=np.float64)
    d1 = float(py) - L2 * (c - 1.0)
    d3 = Z_REF - float(pz) - L2 * s

    valid = is_within_limits(d1, d2, d3, servos, tol=tol)
    if not np.any(valid):
        return []

    solutions = []
    for i in np.where(valid)[0]:
        srv = float(servos[i])
        q1 = float(d1[i])
        q2 = float(d2[i])
        q3 = float(d3[i])
        solutions.append({
            "d1": q1,
            "d2": q2,
            "d3": q3,
            "servo": srv,
            "theta_real_deg": float(theta_real_deg(srv)),
            "mth": mth_directa(q1, q2, q3, srv),
        })
    return solutions


def quantize_to_step(value, step):
    return round(float(value) / float(step)) * float(step)
