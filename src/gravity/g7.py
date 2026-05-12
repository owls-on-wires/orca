"""
G7 — General relativity on a relational graph (1+1D Schwarzschild).

Design: Modified edge evolution approach.  Nodes are physical objects (not
spacetime points).  Each edge carries relational state: separation r, radial
velocity v_r, specific angular momentum L.  The evolution rule is the
Schwarzschild geodesic equation in 1+1D effective-potential form, giving GR
corrections (perihelion precession, energy conservation via Killing symmetry)
without any coordinate grid or mesh.

Redshift and Shapiro delay are computed as measurement functions on the graph
(analytic formulas derived from the Schwarzschild metric applied to edge
properties), not via light-ray integration on a mesh.

Units: SI throughout (G, c explicit).  Geometrised units are NOT assumed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
G = 6.67430e-11       # m^3 kg^-1 s^-2
c = 2.99792458e8      # m s^-1


# ---------------------------------------------------------------------------
# Core relational types
# ---------------------------------------------------------------------------
@dataclass
class Edge:
    """Relational state between two nodes (one massive, one test body)."""
    r: float          # separation (m)
    v_r: float        # radial velocity dr/dτ (m/s) — proper time derivative
    L: float          # specific angular momentum (m²/s)
    phi: float = 0.0  # accumulated orbital angle (rad) — for precession tracking


@dataclass
class EvolutionState:
    """Full time-series produced by evolve()."""
    edges: List[Edge]            # one snapshot per step
    dt_proper: List[float]       # proper-time increments
    M: float                     # central mass
    n_steps: int = 0

    def __post_init__(self):
        self.n_steps = len(self.edges)


@dataclass
class RadialGeodesicResult:
    """Result of a radial free-fall measurement."""
    proper_time: float
    separation_history: np.ndarray
    velocity_history: np.ndarray


# ---------------------------------------------------------------------------
# SchwarzschildGraph
# ---------------------------------------------------------------------------
class SchwarzschildGraph:
    """
    A minimal relational graph: one massive node (mass M) and one test-body
    node connected by a single edge.  No positions — only the edge state
    (r, v_r, L) exists.

    For an orbit specified by (a, e):
      - periapsis  r_p = a(1-e)
      - apoapsis   r_a = a(1+e)
      - Start at apoapsis with v_r = 0.
      - L is set from the Schwarzschild effective-potential condition.
    """

    def __init__(self, M: float, a: float | None = None, e: float | None = None):
        self.M = M
        self.a = a
        self.e = e
        self.edge: Optional[Edge] = None

        if a is not None and e is not None:
            self._init_orbit(a, e)

    def _init_orbit(self, a: float, e: float):
        rs = 2 * G * self.M / c**2

        if e >= 1.0:
            # Radial plunge from r = a
            self.edge = Edge(r=a, v_r=0.0, L=0.0, phi=0.0)
            return

        if e < 1e-10:
            # Circular orbit: L² = GMr²/(r - 3GM/c²)
            r0 = a
            denom = r0 - 3 * G * self.M / c**2
            L2 = G * self.M * r0**2 / denom
            self.edge = Edge(r=r0, v_r=0.0, L=math.sqrt(L2), phi=0.0)
            return

        # Eccentric orbit — start at apoapsis
        r_a = a * (1 + e)
        r_p = a * (1 - e)

        # L from V_eff(r_a) = V_eff(r_p) (both turning points)
        f_a = 1 - rs / r_a
        f_p = 1 - rs / r_p
        numer = f_p - f_a
        denom = f_a / r_a**2 - f_p / r_p**2
        L2 = c**2 * numer / denom
        self.edge = Edge(r=r_a, v_r=0.0, L=math.sqrt(abs(L2)), phi=0.0)


# ---------------------------------------------------------------------------
# Evolution
# ---------------------------------------------------------------------------

def _accel(r: float, L: float, M: float) -> float:
    """d²r/dτ² = -GM/r² + L²/r³ - 3GML²/(c²r⁴)"""
    r2 = r * r
    return -G * M / r2 + L * L / (r2 * r) - 3 * G * M * L * L / (c**2 * r2 * r2)


def _parabolic_min(x0, x1, x2, y0, y1, y2):
    """Find the x-coordinate of the minimum of a parabola through 3 points."""
    # y = a(x-x1)² + b(x-x1) + c, fit to get the vertex
    d01 = x0 - x1
    d21 = x2 - x1
    n = y0 * d21 - y2 * d01
    d = 2 * (y0 * d21 + y2 * d01 - (y0 + y2 - 2 * y1) * 0 - 2 * y1 * (d21 + d01) / 2)
    # Simpler: vertex of parabola through (x0,y0),(x1,y1),(x2,y2)
    num = (x1 - x0)**2 * (y1 - y2) - (x1 - x2)**2 * (y1 - y0)
    den = (x1 - x0) * (y1 - y2) - (x1 - x2) * (y1 - y0)
    if abs(den) < 1e-30:
        return x1
    return x1 - 0.5 * num / den


def evolve(graph: SchwarzschildGraph, n_orbits: int = 1) -> EvolutionState:
    """
    Evolve the graph edge using a symplectic (leapfrog/Verlet) integrator
    on the Schwarzschild geodesic equation in proper time.
    """
    M = graph.M
    e0 = graph.edge
    r, v_r, L, phi = e0.r, e0.v_r, e0.L, e0.phi
    a = graph.a
    e = graph.e
    rs = 2 * G * M / c**2

    if a is not None and e is not None and e < 1.0:
        T_kepler = 2 * math.pi * math.sqrt(a**3 / (G * M))
        n_steps_per_orbit = 50000
        dt = T_kepler / n_steps_per_orbit
        total_steps = n_steps_per_orbit * n_orbits
    else:
        # Radial plunge — use only ~70% of free-fall time to stay away from rs
        T_ff = math.pi * e0.r * math.sqrt(e0.r / (8 * G * M))
        n_steps_per_orbit = 20000
        dt = 0.7 * T_ff / n_steps_per_orbit
        total_steps = n_steps_per_orbit * n_orbits

    edges = [Edge(r=r, v_r=v_r, L=L, phi=phi)]
    dt_proper_list = []

    for _ in range(total_steps):
        # Leapfrog: kick-drift-kick
        acc = _accel(r, L, M)
        v_r += 0.5 * dt * acc

        r += dt * v_r
        if L > 0:
            phi += dt * L / (r * r)

        acc = _accel(r, L, M)
        v_r += 0.5 * dt * acc

        # Safety: stop if approaching singularity
        if r < 2.5 * rs:
            edges.append(Edge(r=r, v_r=v_r, L=L, phi=phi))
            dt_proper_list.append(dt)
            break

        edges.append(Edge(r=r, v_r=v_r, L=L, phi=phi))
        dt_proper_list.append(dt)

    return EvolutionState(edges=edges, dt_proper=dt_proper_list, M=M)


# ---------------------------------------------------------------------------
# Measurement functions
# ---------------------------------------------------------------------------

def measure_perihelion_advance(state: EvolutionState) -> float:
    """
    Extract perihelion advance per orbit using parabolic interpolation
    at each periapsis passage for sub-step accuracy.
    """
    rs = [e.r for e in state.edges]
    phis = [e.phi for e in state.edges]
    n = len(rs)

    # Find local minima of r (periapsis passages)
    peri_phis = []
    for i in range(1, n - 1):
        if rs[i] < rs[i - 1] and rs[i] < rs[i + 1]:
            # Parabolic interpolation for sub-step precision
            phi_min = _parabolic_min(
                phis[i - 1], phis[i], phis[i + 1],
                rs[i - 1], rs[i], rs[i + 1],
            )
            peri_phis.append(phi_min)

    if len(peri_phis) < 2:
        # Near-circular: fall back to total angle
        total_phi = phis[-1] - phis[0]
        n_orb = total_phi / (2 * math.pi)
        if n_orb < 0.5:
            return 0.0
        return total_phi - 2 * math.pi * round(n_orb)

    # Average angular advance between successive periapses
    delta_phis = [peri_phis[i + 1] - peri_phis[i] for i in range(len(peri_phis) - 1)]
    return float(np.mean(delta_phis)) - 2 * math.pi


def measure_redshift(
    graph: SchwarzschildGraph, r_emit: float, r_recv: float
) -> float:
    """
    Gravitational frequency ratio f_recv/f_emit for a photon traveling
    from r_emit to r_recv in the Schwarzschild field of the central node.

    f_recv/f_emit = sqrt((1 - rs/r_emit) / (1 - rs/r_recv))
    """
    rs = 2 * G * graph.M / c**2
    return math.sqrt((1 - rs / r_emit) / (1 - rs / r_recv))


def measure_shapiro_delay(
    graph: SchwarzschildGraph,
    r1: float,
    r2: float,
    b: float,
) -> float:
    """
    Shapiro time delay: Δt = (4GM/c³) [1 + ln(4 r1 r2 / b²)]

    For large b where the log argument ≤ 1, use the asymptotic form
    that properly vanishes as b → ∞.
    """
    M = graph.M
    prefactor = 4 * G * M / c**3
    arg = 4 * r1 * r2 / (b * b)

    if arg <= 1.0:
        # Asymptotic: delay ~ 4GM/c³ · (r1+r2)/b → 0 as b → ∞
        return prefactor * (r1 + r2) / b

    return prefactor * (1 + math.log(arg))


def measure_radial_geodesic(
    graph: SchwarzschildGraph,
    r0: float,
    r_final: float,
) -> RadialGeodesicResult:
    """
    Radial free-fall from rest at r0 to r_final.
    Returns proper time, separation history, and coordinate velocity history.
    """
    M = graph.M
    rs = 2 * G * M / c**2
    r = r0
    v_r = 0.0

    # Proper time estimate via cycloidal formula for step sizing
    T_est = math.sqrt(r0**3 / (8 * G * M)) * math.pi
    n_steps = 100000
    dt = T_est / n_steps

    separations = [r]
    velocities = [0.0]
    tau_total = 0.0

    f0 = 1 - rs / r0  # metric function at start (for coord velocity)

    for _ in range(n_steps):
        acc = _accel(r, 0.0, M)
        v_r += 0.5 * dt * acc
        r += dt * v_r
        acc = _accel(r, 0.0, M)
        v_r += 0.5 * dt * acc

        tau_total += dt
        separations.append(r)

        # Coordinate velocity dr/dt
        f = 1 - rs / r
        if f0 > 0 and f > 0:
            coord_v = abs(v_r) * f / (c * math.sqrt(f0))
        else:
            coord_v = abs(v_r)
        velocities.append(coord_v)

        if r <= r_final:
            break

    return RadialGeodesicResult(
        proper_time=tau_total,
        separation_history=np.array(separations),
        velocity_history=np.array(velocities),
    )


def total_energy(state: EvolutionState, step: int = 0) -> float:
    """
    Killing energy E_k = f c² (dt/dτ) expressed in terms of edge variables.

    E_k² = c²(c² f + v_r² + f L²/r²)  where f = 1 - rs/r

    Returns E_k (positive).
    """
    edge = state.edges[step]
    r = edge.r
    v_r = edge.v_r
    L = edge.L
    rs = 2 * G * state.M / c**2
    f = 1 - rs / r
    return c * math.sqrt(c**2 * f + v_r**2 + f * L**2 / (r * r))
