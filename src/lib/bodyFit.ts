/**
 * Body measurement + outfit fit helpers.
 *
 * Pure functions only (no React, no three.js) so the numbers are easy to tune.
 * Measurements come from MediaPipe *world* landmarks, which are in metres, so
 * they stay stable no matter how close or far the user stands from the camera.
 */

export type Point3 = {x: number; y: number; z: number};

export type BodyMeasurements = {
  /** shoulder joint (landmark 11) to shoulder joint (landmark 12), metres */
  shoulderWidth: number;
  /**
   * mid-shoulder to mid-hip, metres.
   * `null` when the hips are out of frame — only the length check is skipped.
   */
  torsoLength: number | null;
  /** hip (23) to hip (24), metres. `null` when the hips are out of frame. */
  hipWidth: number | null;
};

export type FitKind = "too-tight" | "too-loose" | "length" | "fits" | "unknown";

export type FitResult = {
  kind: FitKind;
  /** estimated clothing size, e.g. "M" */
  size: string | null;
  /** message for the toast banner, or null when there is nothing to warn about */
  toast: string | null;
  tone: "red" | "amber" | "green" | null;
};

/**
 * The outfit being tried on. Tune these two values to match your garment:
 *  - `sizes`: which sizes the model is made in (drives the fit warning)
 *  - `torsoLengthRange`: torso length (metres) the cut can cover
 */
export const OUTFIT = {
  name: "Classic Tee",
  sizes: ["S", "M", "L"] as const,
  /**
   * Torso length (metres) the cut can cover. Kept generous on purpose: tighten
   * it once you have watched real measurements come in.
   */
  torsoLengthRange: [0.4, 0.8] as const,
};

/** Standard body shoulder-width chart (metres). Ordered widest first. */
const SIZE_CHART: Array<{size: string; minShoulder: number}> = [
  {size: "XL", minShoulder: 0.49},
  {size: "L", minShoulder: 0.45},
  {size: "M", minShoulder: 0.41},
  {size: "S", minShoulder: 0.37},
  {size: "XS", minShoulder: 0},
];

export const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];

/**
 * Shoulder-width midpoint of each size (metres), used to scale the garment to
 * the size the user picked: a picked XL is rendered this much roomier than the
 * size the body actually measures.
 */
export const SIZE_MIDPOINT: Record<string, number> = {
  XS: 0.335,
  S: 0.39,
  M: 0.43,
  L: 0.47,
  XL: 0.53,
};

/**
 * How much roomier/tighter the garment should render for a picked size,
 * relative to the size the body measures. `1` = body fit (Auto).
 */
export function sizeScaleFactor(
  pickedSize: string | null | undefined,
  measuredSize: string | null | undefined,
): number {
  if (!pickedSize || !measuredSize) return 1;
  const picked = SIZE_MIDPOINT[pickedSize];
  const measured = SIZE_MIDPOINT[measuredSize];
  if (!picked || !measured || measured <= 0) return 1;
  return picked / measured;
}

/**
 * Deadband so a measurement sitting right on a size boundary does not make the
 * chip flicker between two letters.
 */
const SIZE_HYSTERESIS = 0.006;

function rawSize(shoulderWidth: number): string {
  for (const entry of SIZE_CHART) {
    if (shoulderWidth >= entry.minShoulder) return entry.size;
  }
  return "XS";
}

/** Lower/upper shoulder-width bounds of a size letter. */
function sizeBand(size: string): {lo: number; hi: number} {
  const lo = SIZE_CHART.find((entry) => entry.size === size)?.minShoulder ?? 0;
  const hi = SIZE_CHART.filter((entry) => entry.minShoulder > lo).reduce(
    (smallest, entry) => Math.min(smallest, entry.minShoulder),
    Number.POSITIVE_INFINITY,
  );
  return {lo, hi};
}

/**
 * Maps body shoulder width to a clothing size.
 * Pass the previously shown size to get a small deadband around boundaries.
 */
export function sizeFromShoulderWidth(
  shoulderWidth: number,
  previousSize?: string | null,
): string {
  const size = rawSize(shoulderWidth);
  if (!previousSize || previousSize === size) return size;
  if (Math.abs(SIZE_ORDER.indexOf(size) - SIZE_ORDER.indexOf(previousSize)) !== 1) {
    return size;
  }

  const band = sizeBand(previousSize);
  const goingUp = SIZE_ORDER.indexOf(size) > SIZE_ORDER.indexOf(previousSize);
  const clearlyPastEdge = goingUp
    ? shoulderWidth > band.hi + SIZE_HYSTERESIS
    : shoulderWidth < band.lo - SIZE_HYSTERESIS;

  return clearlyPastEdge ? size : previousSize;
}

/**
 * Decides how well the outfit fits.
 *
 * - **Auto** (`pickedSize` null): estimates the user's size and checks it
 *   against the sizes this outfit is cut in (`OUTFIT.sizes`).
 * - **Picked size**: judges the size the user chose against their body.
 *
 * Warnings are ordered by importance: too tight (red) > too loose / wrong
 * length (amber) > fits (green).
 */
export function evaluateFit(
  measurements: BodyMeasurements | null,
  previousSize?: string | null,
  pickedSize?: string | null,
): FitResult {
  if (
    !measurements ||
    !Number.isFinite(measurements.shoulderWidth) ||
    measurements.shoulderWidth <= 0
  ) {
    return {kind: "unknown", size: null, toast: null, tone: null};
  }

  const measuredSize = sizeFromShoulderWidth(
    measurements.shoulderWidth,
    previousSize,
  );
  const sizeIndex = SIZE_ORDER.indexOf(measuredSize);

  // The user picked a size: is THAT size right for this body?
  if (pickedSize) {
    const pickedIndex = SIZE_ORDER.indexOf(pickedSize);
    if (pickedIndex >= 0 && sizeIndex > pickedIndex) {
      return {
        kind: "too-tight",
        size: pickedSize,
        tone: "red",
        toast: `Size ${pickedSize} — your shoulders measure closer to ${measuredSize}, so this size may be too tight.`,
      };
    }
    if (pickedIndex >= 0 && sizeIndex < pickedIndex) {
      return {
        kind: "too-loose",
        size: pickedSize,
        tone: "amber",
        toast: `Size ${pickedSize} — your shoulders measure closer to ${measuredSize}, so it will look oversized on you.`,
      };
    }
  } else {
    // Auto: compare the measured size with the sizes this outfit is cut in.
    const sizeRange = `${OUTFIT.sizes[0]}-${OUTFIT.sizes[OUTFIT.sizes.length - 1]}`;
    const minIndex = SIZE_ORDER.indexOf(OUTFIT.sizes[0]);
    const maxIndex = SIZE_ORDER.indexOf(OUTFIT.sizes[OUTFIT.sizes.length - 1]);

    if (sizeIndex > maxIndex) {
      return {
        kind: "too-tight",
        size: measuredSize,
        tone: "red",
        toast: `Size ${measuredSize} — this outfit is cut ${sizeRange}. Your shoulders are wider than its fit range, so it may be too tight.`,
      };
    }

    if (sizeIndex < minIndex) {
      return {
        kind: "too-loose",
        size: measuredSize,
        tone: "amber",
        toast: `Size ${measuredSize} — this outfit is cut ${sizeRange}. It will look oversized on you.`,
      };
    }
  }

  // The size is right — is the length?
  const size = pickedSize ?? measuredSize;
  const torsoLength = measurements.torsoLength;
  if (torsoLength !== null) {
    const [minTorso, maxTorso] = OUTFIT.torsoLengthRange;
    if (torsoLength < minTorso) {
      return {
        kind: "length",
        size,
        tone: "amber",
        toast: `Size ${size} — your torso is shorter than this outfit's cut, so it may hang too long.`,
      };
    }
    if (torsoLength > maxTorso) {
      return {
        kind: "length",
        size,
        tone: "amber",
        toast: `Size ${size} — your torso is longer than this outfit's cut, so it may ride up.`,
      };
    }
  }

  return {kind: "fits", size, tone: "green", toast: null};
}

/** Short label for the always-on chip in the top-left corner. */
export function fitChipLabel(result: FitResult): string | null {
  if (!result.size || result.kind === "unknown") return null;
  switch (result.kind) {
    case "too-tight":
      return `Size ${result.size} · too tight`;
    case "too-loose":
      return `Size ${result.size} · too loose`;
    case "length":
      return `Size ${result.size} · length mismatch`;
    default:
      return `Size ${result.size} · fits`;
  }
}

const distance = (a: Point3, b: Point3) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const midpoint = (a: Point3, b: Point3): Point3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

/** Shoulder width alone — enough for the size estimate. */
export function measureShoulders(world: Point3[] | undefined): number | null {
  if (!world) return null;

  const leftShoulder = world[11];
  const rightShoulder = world[12];
  if (!leftShoulder || !rightShoulder) return null;

  const shoulderWidth = distance(leftShoulder, rightShoulder);
  // Sanity check: rejects collapsed or extrapolated skeletons.
  if (shoulderWidth < 0.1 || shoulderWidth > 0.8) return null;

  return shoulderWidth;
}

/** Full body dimensions. Returns null when the hips are not usable. */
export function measureBody(
  world: Point3[] | undefined,
): BodyMeasurements | null {
  const shoulderWidth = measureShoulders(world);
  if (shoulderWidth === null || !world) return null;

  const leftShoulder = world[11];
  const rightShoulder = world[12];
  const leftHip = world[23];
  const rightHip = world[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

  const hipWidth = distance(leftHip, rightHip);
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);
  const torsoLength = distance(shoulderMid, hipMid);

  // Sanity checks: a torso is never shorter than the shoulders are wide, and
  // shoulders/hips must be clearly separated vertically (the y axis points
  // differently in image vs world landmarks, so compare magnitudes only).
  if (hipWidth < 0.05 || hipWidth > 1.0) return null;
  if (torsoLength < shoulderWidth * 0.4) return null;
  if (Math.abs(hipMid.y - shoulderMid.y) < 0.1) return null;

  return {shoulderWidth, torsoLength, hipWidth};
}

/** Exponential moving average used to stop measurements from jittering. */
export function ema(previous: number | null, next: number, alpha = 0.15): number {
  if (previous === null || !Number.isFinite(previous)) return next;
  return previous + alpha * (next - previous);
}
