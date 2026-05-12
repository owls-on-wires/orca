"""
G7 — General relativity on a relational graph (1+1D Schwarzschild).

Tests verify that the graph evolution rule reproduces known GR predictions
without any coordinate embedding or spacetime discretisation.  The graph
has one node per physical body (minimal philosophy); GR effects live in
the edge-update rule.

All formulas use geometrised units unless noted.  `c` and `G` are kept
explicit so the tests double as dimensional-analysis checks.
"""

import math
import pytest
import numpy as np

from src.gravity.g7 import (
    SchwarzschildGraph,
    evolve,
    measure_perihelion_advance,
    measure_redshift,
    measure_shapiro_delay,
    measure_radial_geodesic,
    total_energy,
)

# ---------------------------------------------------------------------------
# Physical constants
# ---------------------------------------------------------------------------
G = 6.67430e-11        # m^3 kg^-1 s^-2
c = 2.99792458e8       # m s^-1
M_sun = 1.98892e30     # kg


# ===================================================================
# 1. Schwarzschild perihelion precession
# ===================================================================
class TestPerihelionPrecession:
    """
    Mercury-like orbit around a solar-mass body.
    Expected advance per orbit:
        δφ = 6πGM / [a c² (1 − e²)]
    """

    @pytest.fixture()
    def mercury_params(self):
        a = 5.791e10        # semi-major axis  (m)
        e = 0.2056          # eccentricity
        M = M_sun
        return dict(M=M, a=a, e=e)

    def analytic_advance(self, M, a, e):
        return 6 * math.pi * G * M / (a * c**2 * (1 - e**2))

    def test_precession_sign(self, mercury_params):
        """Precession must be prograde (positive δφ)."""
        graph = SchwarzschildGraph(
            M=mercury_params["M"],
            a=mercury_params["a"],
            e=mercury_params["e"],
        )
        state = evolve(graph, n_orbits=3)
        delta_phi = measure_perihelion_advance(state)
        assert delta_phi > 0

    def test_precession_value(self, mercury_params):
        """Numerical δφ within 2 % of the exact 1PN result."""
        expected = self.analytic_advance(**mercury_params)
        graph = SchwarzschildGraph(**mercury_params)
        state = evolve(graph, n_orbits=5)
        delta_phi = measure_perihelion_advance(state)
        assert delta_phi == pytest.approx(expected, rel=0.02)

    def test_precession_scales_with_mass(self, mercury_params):
        """Doubling M doubles the advance (linear in M)."""
        graph_1 = SchwarzschildGraph(**mercury_params)
        s1 = evolve(graph_1, n_orbits=5)
        dp1 = measure_perihelion_advance(s1)

        params2 = {**mercury_params, "M": 2 * mercury_params["M"]}
        graph_2 = SchwarzschildGraph(**params2)
        s2 = evolve(graph_2, n_orbits=5)
        dp2 = measure_perihelion_advance(s2)

        assert dp2 == pytest.approx(2 * dp1, rel=0.02)

    def test_precession_circular_limit(self, mercury_params):
        """For e → 0 the advance → 6πGM/(a c²)."""
        params = {**mercury_params, "e": 1e-6}
        expected = 6 * math.pi * G * params["M"] / (params["a"] * c**2)
        graph = SchwarzschildGraph(**params)
        state = evolve(graph, n_orbits=3)
        delta_phi = measure_perihelion_advance(state)
        assert delta_phi == pytest.approx(expected, rel=0.01)


# ===================================================================
# 2. Gravitational redshift
# ===================================================================
class TestGravitationalRedshift:
    """
    Two static observers at radii r1, r2 in a Schwarzschild field.
    Frequency ratio:
        f1/f2 = sqrt( (1 − 2GM/(r2 c²)) / (1 − 2GM/(r1 c²)) )
    """

    @pytest.fixture()
    def redshift_setup(self):
        M = M_sun
        r1 = 1e7    # inner observer  (10 000 km)
        r2 = 1e10   # outer observer  (10 000 000 km)
        return dict(M=M, r1=r1, r2=r2)

    def analytic_ratio(self, M, r1, r2):
        rs1 = 2 * G * M / (r1 * c**2)
        rs2 = 2 * G * M / (r2 * c**2)
        return math.sqrt((1 - rs2) / (1 - rs1))

    def test_redshift_direction(self, redshift_setup):
        """Light climbing out of a gravity well is redshifted (ratio < 1)."""
        graph = SchwarzschildGraph(M=redshift_setup["M"])
        ratio = measure_redshift(
            graph,
            r_emit=redshift_setup["r1"],
            r_recv=redshift_setup["r2"],
        )
        assert ratio < 1.0

    def test_redshift_value(self, redshift_setup):
        """Numerical ratio within 0.1 % of analytic value."""
        expected = self.analytic_ratio(**redshift_setup)
        graph = SchwarzschildGraph(M=redshift_setup["M"])
        ratio = measure_redshift(
            graph,
            r_emit=redshift_setup["r1"],
            r_recv=redshift_setup["r2"],
        )
        assert ratio == pytest.approx(expected, rel=1e-3)

    def test_redshift_symmetric(self, redshift_setup):
        """Swapping emitter ↔ receiver inverts the ratio."""
        M = redshift_setup["M"]
        r1, r2 = redshift_setup["r1"], redshift_setup["r2"]
        graph = SchwarzschildGraph(M=M)
        ratio_up = measure_redshift(graph, r_emit=r1, r_recv=r2)
        ratio_down = measure_redshift(graph, r_emit=r2, r_recv=r1)
        assert ratio_up * ratio_down == pytest.approx(1.0, rel=1e-6)

    def test_no_redshift_at_equal_radii(self, redshift_setup):
        """No shift when both observers sit at the same radius."""
        graph = SchwarzschildGraph(M=redshift_setup["M"])
        ratio = measure_redshift(graph, r_emit=1e8, r_recv=1e8)
        assert ratio == pytest.approx(1.0, abs=1e-12)


# ===================================================================
# 3. Shapiro time delay
# ===================================================================
class TestShapiroDelay:
    """
    Round-trip time excess for a signal grazing a massive body.
    Leading-order delay:
        Δt ≈ (4GM/c³) [1 + ln(4 r1 r2 / b²)]
    where b is the impact parameter (closest approach).
    """

    @pytest.fixture()
    def shapiro_setup(self):
        M = M_sun
        r1 = 1.5e11     # ≈ 1 AU
        r2 = 1.5e11
        b = 7e8          # just outside the Sun's surface
        return dict(M=M, r1=r1, r2=r2, b=b)

    def analytic_delay(self, M, r1, r2, b):
        prefactor = 4 * G * M / c**3
        return prefactor * (1 + math.log(4 * r1 * r2 / b**2))

    def test_delay_positive(self, shapiro_setup):
        """The GR correction is always a delay (positive)."""
        graph = SchwarzschildGraph(M=shapiro_setup["M"])
        dt = measure_shapiro_delay(
            graph,
            r1=shapiro_setup["r1"],
            r2=shapiro_setup["r2"],
            b=shapiro_setup["b"],
        )
        assert dt > 0

    def test_delay_value(self, shapiro_setup):
        """Numerical delay within 2 % of the leading-order analytic value."""
        expected = self.analytic_delay(**shapiro_setup)
        graph = SchwarzschildGraph(M=shapiro_setup["M"])
        dt = measure_shapiro_delay(
            graph,
            r1=shapiro_setup["r1"],
            r2=shapiro_setup["r2"],
            b=shapiro_setup["b"],
        )
        assert dt == pytest.approx(expected, rel=0.02)

    def test_delay_scales_with_mass(self, shapiro_setup):
        """Delay is linear in M to leading order."""
        graph_1 = SchwarzschildGraph(M=shapiro_setup["M"])
        dt1 = measure_shapiro_delay(
            graph_1,
            r1=shapiro_setup["r1"],
            r2=shapiro_setup["r2"],
            b=shapiro_setup["b"],
        )
        graph_2 = SchwarzschildGraph(M=3 * shapiro_setup["M"])
        dt2 = measure_shapiro_delay(
            graph_2,
            r1=shapiro_setup["r1"],
            r2=shapiro_setup["r2"],
            b=shapiro_setup["b"],
        )
        # Not exactly 3× because of the log term, but close
        assert dt2 / dt1 == pytest.approx(3.0, rel=0.05)

    def test_delay_vanishes_far_from_mass(self, shapiro_setup):
        """As b → ∞ the delay → 0 (flat-space limit)."""
        graph = SchwarzschildGraph(M=shapiro_setup["M"])
        dt = measure_shapiro_delay(
            graph,
            r1=shapiro_setup["r1"],
            r2=shapiro_setup["r2"],
            b=1e15,  # enormous impact parameter
        )
        flat_time = 2 * shapiro_setup["r1"] / c
        assert dt / flat_time < 1e-6


# ===================================================================
# 4. Radial geodesic (free-fall from rest)
# ===================================================================
class TestRadialGeodesic:
    """
    A test body dropped from rest at coordinate radius r0 in a
    Schwarzschild field.  Proper time to reach radius r < r0 must
    agree with the analytic integral (parametric cycloid solution).

    For radial geodesic from rest at r0 the proper time satisfies:
        τ(r) = (r0/c) √(r0/(2GM)) · [arccos(√(r/r0)) + √(r/r0(1−r/r0))]
    (using the cycloidal parameterisation).
    """

    @pytest.fixture()
    def geodesic_setup(self):
        M = M_sun
        r0 = 1e8        # initial radius (100 000 km)
        r_final = 5e7   # fall to half the starting radius
        return dict(M=M, r0=r0, r_final=r_final)

    def analytic_proper_time(self, M, r0, r_final):
        """Proper time via cycloidal parameterisation."""
        xi0 = math.acos(math.sqrt(r_final / r0))
        tau = math.sqrt(r0**3 / (2 * G * M)) * (
            xi0 + 0.5 * math.sin(2 * xi0)
        )
        return tau

    def test_proper_time_value(self, geodesic_setup):
        """Graph-evolved proper time within 1 % of analytic."""
        expected = self.analytic_proper_time(**geodesic_setup)
        graph = SchwarzschildGraph(M=geodesic_setup["M"])
        result = measure_radial_geodesic(
            graph,
            r0=geodesic_setup["r0"],
            r_final=geodesic_setup["r_final"],
        )
        assert result.proper_time == pytest.approx(expected, rel=0.01)

    def test_monotonic_infall(self, geodesic_setup):
        """Separation must decrease monotonically during infall."""
        graph = SchwarzschildGraph(M=geodesic_setup["M"])
        result = measure_radial_geodesic(
            graph,
            r0=geodesic_setup["r0"],
            r_final=geodesic_setup["r_final"],
        )
        separations = result.separation_history
        assert len(separations) > 2
        diffs = np.diff(separations)
        assert np.all(diffs < 0), "separation must decrease at every step"

    def test_velocity_bounded_by_c(self, geodesic_setup):
        """Coordinate velocity dr/dt must stay below c."""
        graph = SchwarzschildGraph(M=geodesic_setup["M"])
        result = measure_radial_geodesic(
            graph,
            r0=geodesic_setup["r0"],
            r_final=geodesic_setup["r_final"],
        )
        velocities = np.abs(result.velocity_history)
        assert np.all(velocities < c), "no superluminal motion"


# ===================================================================
# 5. Energy conservation in the GR regime
# ===================================================================
class TestEnergyConservation:
    """
    The Schwarzschild metric admits a time-like Killing vector, so
    the specific energy E/m = (1 − rs/r) dt/dτ  is conserved along
    geodesics.  On the graph this becomes a conserved quantity on
    edges; verify it is preserved by the evolution rule.
    """

    @pytest.fixture()
    def orbit_setup(self):
        M = 1e6 * M_sun   # intermediate-mass BH
        a = 1e10
        e = 0.5
        return dict(M=M, a=a, e=e)

    def test_energy_conserved_elliptic(self, orbit_setup):
        """Relative energy drift < 1e-4 over 10 orbits (bound orbit)."""
        graph = SchwarzschildGraph(**orbit_setup)
        state = evolve(graph, n_orbits=10)
        E_initial = total_energy(state, step=0)
        E_final = total_energy(state, step=-1)
        assert E_initial != 0.0
        drift = abs((E_final - E_initial) / E_initial)
        assert drift < 1e-4

    def test_energy_conserved_radial(self, orbit_setup):
        """Energy conserved during radial plunge (e=1 limit)."""
        params = {**orbit_setup, "e": 1.0}
        graph = SchwarzschildGraph(**params)
        state = evolve(graph, n_orbits=1)
        E_initial = total_energy(state, step=0)
        E_final = total_energy(state, step=-1)
        drift = abs((E_final - E_initial) / max(abs(E_initial), 1e-30))
        assert drift < 1e-4

    def test_energy_conserved_circular(self, orbit_setup):
        """Circular orbit: energy constant to machine-level over 50 orbits."""
        params = {**orbit_setup, "e": 0.0}
        graph = SchwarzschildGraph(**params)
        state = evolve(graph, n_orbits=50)
        energies = [total_energy(state, step=i) for i in range(state.n_steps)]
        energies = np.array(energies)
        assert energies.std() / abs(energies.mean()) < 1e-6

    def test_energy_step_to_step(self, orbit_setup):
        """Max single-step energy jump < 1e-6 (symplectic-quality)."""
        graph = SchwarzschildGraph(**orbit_setup)
        state = evolve(graph, n_orbits=5)
        energies = np.array(
            [total_energy(state, step=i) for i in range(state.n_steps)]
        )
        jumps = np.abs(np.diff(energies)) / abs(energies[0])
        assert jumps.max() < 1e-6
