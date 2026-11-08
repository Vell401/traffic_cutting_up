// PROJECT CHRONO - https://projectchrono.org
// Copyright (c) 2023 projectchrono.org. All rights reserved.
// Original author: Rainer Gericke. TypeScript adaptation of ChTMeasyTire.cpp/.h,
// revision bdfd07c2edee80361acffbe01df392c36c6d8ef6.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
// 3. Neither the name of the copyright holder nor the names of its contributors
//    may be used to endorse or promote products derived from this software
//    without specific prior written permission.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

/**
 * Stateless port of Chrono's steady-state TMeasy handling-force subset:
 * tmxy_combined, InterpL/Q, resultant parameters, AlignmentTorque, and the
 * normalized GuessPassCar70Par coefficients. This is not the Chrono engine:
 * collision, vertical suspension, Dahl bristles, low-speed blending, camber,
 * rolling resistance and startup transitions remain outside this module.
 *
 * The caller supplies slip (not slip velocity). In R34 coordinates use
 * sx = (R * omega - u) / max(abs(u), 3), sy = -v / max(abs(u), 3).
 * These signs match Chrono's force signs, but that velocity denominator is an
 * integration choice, not Chrono's R_eff * abs(omega) + 0.01 denominator.
 */
export const TMEASY_UPSTREAM_COMMIT = 'bdfd07c2edee80361acffbe01df392c36c6d8ef6'

export interface TMeasyAxis {
  /** Initial force/slip stiffness [N]. */
  df0: number
  /** Peak slip and force [N]. */
  sm: number
  fm: number
  /** Full-sliding slip and force [N]. */
  ss: number
  fs: number
}

export interface TMeasyCurveResult {
  force: number
  forceOverSlip: number
  derivative: number
}

export interface TMeasyOptions {
  /** Road friction; Chrono's reference mu_0 is 0.8. Default 0.8. */
  mu?: number
  /** Ellipse x-radius: evaluate sx / scale and multiply Fx by scale. Default 1. */
  longitudinalScale?: number
  /** Multiply longitudinal peak/full-sliding slips, not initial stiffness. */
  longitudinalSlipScale?: number
  /** Multiply lateral peak/full-sliding slips, not initial stiffness. */
  lateralSlipScale?: number
  /** Multiply both initial stiffnesses; Chrono still enforces df0 >= 2 fm/sm. */
  stiffnessScale?: number
  /** Patch length [m], normally 2 sqrt(unloadedRadius * penetrationDepth).
   * Default 0: no geometry is invented, so Mz is zero until supplied. */
  contactPatchLength?: number
}

export interface TMeasyResult {
  fx: number
  fy: number
  mz: number
  /** Partial derivative of Fx with respect to caller sx, holding sy fixed. */
  dfxDsx: number
}

/** Chrono InterpL; q is actual / nominal load (dimensionless). */
export function loadInterpL(q: number, w1: number, w2: number): number {
  return w1 + (w2 - w1) * (q - 1)
}

/** Chrono InterpQ; w1/w2 are dimensional values at pn/2pn, not normalized. */
export function loadInterpQ(q: number, w1: number, w2: number): number {
  return q * (2 * w1 - 0.5 * w2 - (w1 - 0.5 * w2) * q)
}

export interface TMeasyLoadParameters {
  x: TMeasyAxis
  y: TMeasyAxis
  nL0: number
  sq0: number
  sqe: number
}

/** Exact normalized GuessPassCar70Par data; handling load capped at 3.5 pn. */
export function guessPassCar70(normalLoad: number, nominalLoad: number): TMeasyLoadParameters {
  const pn = Number.isFinite(nominalLoad) && nominalLoad > 0 ? nominalLoad : 0
  const q = pn > 0 && Number.isFinite(normalLoad)
    ? Math.min(Math.max(normalLoad / pn, 0), 3.5) : 0
  return {
    x: {
      df0: loadInterpQ(q, 18.3741 * pn, 19.4669 * 2 * pn),
      fm: loadInterpQ(q, 1.1292 * pn, 1.0896 * 2 * pn),
      fs: loadInterpQ(q, 0.80149 * pn, 0.76917 * 2 * pn),
      sm: loadInterpL(q, 0.13913, 0.13913),
      ss: loadInterpL(q, 0.66667, 0.66667),
    },
    y: {
      df0: loadInterpQ(q, 15.9826 * pn, 12.8509 * 2 * pn),
      fm: loadInterpQ(q, 1.0009 * pn, 0.91367 * 2 * pn),
      fs: loadInterpQ(q, 0.8336 * pn, 0.77336 * 2 * pn),
      sm: loadInterpL(q, 0.14852, 0.18504),
      ss: loadInterpL(q, 0.96524, 1.0714),
    },
    nL0: loadInterpL(q, 0.178, 0.19),
    sq0: loadInterpL(q, 0.16337, 0.20355),
    sqe: loadInterpL(q, 0.96524, 1.0714),
  }
}

// Ordinary handling values need no scaled-hypotenuse machinery. Preserve
// Math.hypot's overflow/underflow protection for exceptional magnitudes.
function hypot2(a: number, b: number): number {
  const squared = a * a + b * b
  return squared >= 2.2250738585072014e-308 && Number.isFinite(squared)
    ? Math.sqrt(squared) : Math.hypot(a, b)
}

interface CurveForce { force: number; derivative: number }

/** Upstream tmxy_combined and its scalar analytic directional derivative.
 * d-prefixed inputs are derivatives with respect to the caller's sx. Keeping
 * these in scalar locals avoids allocating an object per arithmetic operation.
 */
function tmxy(
  s: number, ds: number, df0: number, ddf0: number,
  sm: number, dsm: number, fm: number, dfm: number,
  ss: number, dss: number, fs: number, dfs: number,
): CurveForce {
  if (!(sm > 0 && fm > 0 && ss > sm && fs >= 0)) return { force: 0, derivative: 0 }
  const minimumSlope = 2 * fm / sm
  if (minimumSlope > df0) {
    df0 = minimumSlope
    ddf0 = (2 * dfm - minimumSlope * dsm) / sm
  }
  if (!(df0 > 0)) return { force: 0, derivative: 0 }
  if (s === 0) return { force: 0, derivative: df0 * ds }
  if (s > ss) return { force: fs, derivative: dfs } // full sliding
  if (s < sm) { // rational adhesion
    const product = df0 * sm
    const dproduct = ddf0 * sm + df0 * dsm
    const ratio = product / fm
    const p = ratio - 2
    const dp = (dproduct - ratio * dfm) / fm
    const sn = s / sm
    const dsn = (ds - sn * dsm) / sm
    const dn = 1 + (sn + p) * sn
    const ddn = (dsn + dp) * sn + (sn + p) * dsn
    const force = product * sn / dn
    return { force, derivative: (dproduct * sn + product * dsn - force * ddn) / dn }
  }
  const ratio = fm / sm
  const dratio = (dfm - ratio * dsm) / sm
  const denominator = df0 * sm
  const a = ratio * ratio / denominator
  const da = (2 * ratio * dratio - a * (ddf0 * sm + df0 * dsm)) / denominator
  const gap = ss - sm
  const dgap = dss - dsm
  const drop = fm - fs
  const ddrop = dfm - dfs
  const starOffset = drop / (a * gap)
  const dstarOffset = (ddrop - starOffset * (da * gap + a * dgap)) / (a * gap)
  const sstar = sm + starOffset
  const dstar = dsm + dstarOffset
  if (sstar <= ss) { // two parabolas, joined at sstar
    if (s <= sstar) {
      const offset = s - sm
      const doffset = ds - dsm
      return {
        force: fm - a * (offset * offset),
        derivative: dfm - da * (offset * offset) - a * (2 * offset * doffset),
      }
    }
    const b = a * (sstar - sm) / (ss - sstar)
    const db = (da * (sstar - sm) + a * (dstar - dsm) - b * (dss - dstar)) / (ss - sstar)
    const tail = ss - s
    const dtail = dss - ds
    return {
      force: fs + b * (tail * tail),
      derivative: dfs + db * (tail * tail) + b * (2 * tail * dtail),
    }
  }
  // Cubic fallback when the parabola connecting point is beyond full sliding.
  const sn = (s - sm) / gap
  const dsn = (ds - dsm - sn * dgap) / gap
  const square = sn * sn
  const factor = 3 - 2 * sn
  return {
    force: fm - drop * square * factor,
    derivative: dfm - (ddrop * square + drop * (2 * sn * dsn)) * factor + drop * square * 2 * dsn,
  }
}

/** Odd extension of Chrono's nonnegative-slip curve, without a post-peak clamp.
 * At zero, forceOverSlip and derivative return the analytic limiting stiffness
 * (upstream's unused fos output is zero at exactly zero instead). */
export function tmeasyCurve(s: number, axis: TMeasyAxis): TMeasyCurveResult {
  if (!Number.isFinite(s) || !Number.isFinite(axis.df0) || !Number.isFinite(axis.sm)
    || !Number.isFinite(axis.fm) || !Number.isFinite(axis.ss) || !Number.isFinite(axis.fs)) {
    return { force: 0, forceOverSlip: 0, derivative: 0 }
  }
  const f = tmxy(Math.abs(s), 1, axis.df0, 0, axis.sm, 0, axis.fm, 0, axis.ss, 0, axis.fs, 0)
  return {
    force: s < 0 ? -f.force : f.force,
    forceOverSlip: s === 0 ? f.derivative : f.force / Math.abs(s),
    derivative: f.derivative,
  }
}

/** Chrono AlignmentTorque, including the negative-trail region after sq0. */
export function alignmentTorque(
  fy: number, sy: number, patchLength: number, nL0: number, sq0: number, sqe: number,
): number {
  const syA = Math.abs(sy)
  const end = Math.max(sqe, sq0)
  if (!(patchLength > 0 && sq0 > 0 && end > 0) || syA >= end) return 0
  const wf = sq0 / end
  let nto: number
  if (syA <= sq0) {
    const sn = syA / sq0
    const nto1 = nL0 * (1 - sn)
    const nto2 = nL0 * (1 - (3 - 2 * sn) * sn * sn)
    nto = (1 - wf) * nto1 + wf * nto2
  } else {
    const sn = (end - syA) / (end - sq0)
    nto = -nL0 * (1 - wf) * (syA - sq0) / sq0 * sn * sn
  }
  return -fy * patchLength * nto
}

const DEFAULT_OPTIONS: Readonly<TMeasyOptions> = Object.freeze({})

/** Steady-state resultant force, using Advance's direction-dependent parameters.
 * Friction scales force AND peak/sliding slips, but not initial stiffness.
 * Optional ellipse/slip/stiffness calibration is outside the upstream model;
 * all defaults preserve the original normalized passenger-car force curves.
 * Zero friction is supported explicitly (unlike upstream's terrain mu clamp).
 */
export function evaluateTMeasy(
  sx: number, sy: number, normalLoad: number, nominalLoad: number,
  options: TMeasyOptions = DEFAULT_OPTIONS,
): TMeasyResult {
  const mu = options.mu ?? 0.8
  const ellipse = options.longitudinalScale ?? 1
  const xSlip = options.longitudinalSlipScale ?? 1
  const ySlip = options.lateralSlipScale ?? 1
  const stiffness = options.stiffnessScale ?? 1
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(normalLoad)
    || !Number.isFinite(nominalLoad) || !Number.isFinite(mu) || !Number.isFinite(ellipse)
    || !Number.isFinite(xSlip) || !Number.isFinite(ySlip) || !Number.isFinite(stiffness)
    || normalLoad <= 0 || nominalLoad <= 0 || mu <= 0 || ellipse <= 0
    || xSlip <= 0 || ySlip <= 0 || stiffness < 0) {
    return { fx: 0, fy: 0, mz: 0, dfxDsx: 0 }
  }
  // Same InterpQ/L inputs as guessPassCar70, without constructing three
  // temporary parameter objects. No memoization or mutable shared scratch.
  const pn = nominalLoad
  const q = Math.min(normalLoad / pn, 3.5)
  const dfx0 = stiffness * loadInterpQ(q, 18.3741 * pn, 19.4669 * 2 * pn)
  const fxm = loadInterpQ(q, 1.1292 * pn, 1.0896 * 2 * pn)
  const sxm = 0.13913 * xSlip
  const muscale = mu / 0.8
  const x = sx / ellipse
  const sc = hypot2(x, sy)
  if (sc === 0) {
    return {
      fx: 0, fy: 0, mz: 0,
      dfxDsx: Math.max(dfx0, 2 * fxm / sxm),
    }
  }
  const c = x / sc
  const sn = sy / sc
  const ds = c / ellipse
  const dc = sn * sn / sc / ellipse
  const dsn = -c * sn / sc / ellipse
  const dfy0 = stiffness * loadInterpQ(q, 15.9826 * pn, 12.8509 * 2 * pn)
  const fym = loadInterpQ(q, 1.0009 * pn, 0.91367 * 2 * pn)
  const sym = loadInterpL(q, 0.14852, 0.18504) * ySlip
  const fxs = loadInterpQ(q, 0.80149 * pn, 0.76917 * 2 * pn)
  const fys = loadInterpQ(q, 0.8336 * pn, 0.77336 * 2 * pn)
  const sxs = 0.66667 * xSlip
  const sys = loadInterpL(q, 0.96524, 1.0714) * ySlip
  const df0 = hypot2(dfx0 * c, dfy0 * sn)
  const fm = hypot2(fxm * c, fym * sn)
  const sm = hypot2(sxm * c, sym * sn)
  const fs = hypot2(fxs * c, fys * sn)
  const ss = hypot2(sxs * c, sys * sn)
  const cdc = c * dc
  const sds = sn * dsn
  const ddf0 = df0 > 0 ? (dfx0 * dfx0 * cdc + dfy0 * dfy0 * sds) / df0 : 0
  const dfm = fm > 0 ? (fxm * fxm * cdc + fym * fym * sds) / fm : 0
  const dsm = sm > 0 ? (sxm * sxm * cdc + sym * sym * sds) / sm : 0
  const dfs = fs > 0 ? (fxs * fxs * cdc + fys * fys * sds) / fs : 0
  const dss = ss > 0 ? (sxs * sxs * cdc + sys * sys * sds) / ss : 0
  const f = tmxy(sc, ds, df0, ddf0, muscale * sm, muscale * dsm,
    muscale * fm, muscale * dfm, muscale * ss, muscale * dss, muscale * fs, muscale * dfs)
  const fx = ellipse * f.force * c
  const fy = f.force * sn
  const patch = options.contactPatchLength ?? 0
  return {
    fx, fy,
    mz: Number.isFinite(patch) ? alignmentTorque(fy, sy, patch,
      loadInterpL(q, 0.178, 0.19), loadInterpL(q, 0.16337, 0.20355), loadInterpL(q, 0.96524, 1.0714)) : 0,
    dfxDsx: ellipse * (f.derivative * c + f.force * dc),
  }
}
