# The construction

Two different curves, and they are not interchangeable.

| | superellipse | continuous |
|---|---|---|
| Definition | `\|x\|^n + \|y\|^n = 1`, a Lamé curve | circular arc plus a cubic Bézier shoulder either side |
| Parameter | the exponent `n` | smoothing, `0..1` |
| Native CSS | `corner-shape: superellipse(log₂ n)` | none |
| Drawn by corner.js | only without native `corner-shape` | always |

`superellipse(1)` computes to `round` and `superellipse(2)` to `squircle`, so the CSS
parameter is log₂ of the exponent used here.

## Superellipse

One quarter of the curve, parametrised so `t = 0` sits where the straight edge hands off
into the corner and `t = π/2` at the corner's far tangent point — which is
`border-radius`'s own corner-box convention:

```
x(t) = sin(t)^(2/n)
y(t) = 1 - cos(t)^(2/n)
```

Sampled at `POINTS_PER_CORNER` points and rotated by 90° per corner. Generic in `n`, so no
exponent is a fitted approximation of another.

`n = 4` is the squircle proper (Lamé's quartic). `n = 5` is the closest single exponent to
Apple's corner and still systematically off — which is why Figma derived a construction
instead of raising the exponent.

## Continuous

Ported from [phamfoo/figma-squircle](https://github.com/phamfoo/figma-squircle)'s
`getPathParamsForCorner`, default branch (`preserveSmoothing: false`), which follows
Figma's [Desperately seeking squircles](https://www.figma.com/blog/desperately-seeking-squircles/).

Each corner is three segments — shoulder, arc, shoulder — built from four lengths:

```
reach      = (1 + smoothing) * radius      how far from the apex the corner starts
arc sweep  = 90 * (1 - smoothing)          degrees left as a circular arc
a, b       = the shoulder's straight run
c, d       = the shoulder's turn into the arc
```

At `smoothing = 0` the arc is the whole 90° and the result is `border-radius`. At `1` there
is no arc left and the corner is pure Bézier. `0.6` is Figma's value for the Apple-like
shape.

### The budget

`budget = min(width, height) / 2`, and **both** the radius and the reach are clamped
against it.

Clamping the radius alone is too generous by exactly `(1 + smoothing)`: at
`smoothing = 0.6` two corners of one side want 1.6× that side between them. Measured on a
320×200 box, radius 62 fits inside 200 while radius 80 asks for 256 — the path then runs
backwards (`M 192 0 … L 320 72`) and renders as a notch in each long edge at half height.

The reference's default branch spends the budget on roundness first and gives up smoothing
as it runs out, so `radius == budget` yields a plain circular arc and a clean capsule end.
Its `preserveSmoothing` branch, which squeezes `a` and `b` instead, is not ported. Neither
is its per-side budget distribution for mixed radii — every corner is capped against the
uniform `min(w, h) / 2`, which is what the reference itself does when the four radii are
equal.

### The four corners

`CONTINUOUS_CORNERS` is one construction rotated four times. The path is drawn clockwise
from the top edge, so it meets the corners in the order top-right, bottom-right,
bottom-left, top-left, and each entry returns its three segments as **relative** deltas:

```
[entry shoulder]  c  a 0  a+b 0  a+b+c d
[arc sweep]       a  radius radius 0 0 1  arc arc
[exit shoulder]   c  d c  d b+c  d a+b+c
```

The other three corners are the same numbers with the axes swapped and the signs flipped —
that is all the apparent asymmetry in the table is.

# Why the SVGs

`clip-path` on an element removes its `box-shadow` and its `filter: drop-shadow`, and
halves the width of its `border` — the outer half falls outside the clip. So both are
redrawn as siblings inside a `[data-corner-shadow-wrap]` wrapper:

- **shadow**, inserted *before* the element so it paints behind it,
- **border**, inserted *after* so it paints over it.

A plain `box-shadow` on the wrapper was tried first: its corners are a rounded rectangle
and visibly miss the curve.

## The shadow filter

One chain per `box-shadow` layer:

```
feMorphology (spread) → feGaussianBlur (blur / 2) → feOffset (dx, dy)
                      → feFlood + feComposite operator="in" (color)
```

- A CSS blur radius is **two** standard deviations. Passing the radius straight to
  `stdDeviation` makes every layer twice as soft as declared.
- Spread is `feMorphology`, `dilate` for positive and `erode` for negative.
- The color is handed to `feFlood` as a **string** and never decomposed, so
  `lch()`, `oklch()`, `color-mix()` and anything else the browser parses arrive intact.
- `feMerge` inputs are reversed: `box-shadow` paints the first layer on top, `feMerge` the
  last node.
- `filterUnits="userSpaceOnUse"` with explicit pixel bounds, because Safari interprets the
  default percentage region asymmetrically.
- The region is expressed in the *path's* own space, starting at `-margin`:
  `userSpaceOnUse` resolves before the path's `transform` places it.

`inset` shadows are skipped — there is no outer silhouette to draw.

# Measuring

The **layout** box, from `ResizeObserver`'s `borderBoxSize` or `offsetWidth`, never
`getBoundingClientRect`. Everything drawn lives inside the same transformed subtree, so a
scaled rect applies the scale twice: a 500px box at `scale(0.97)` produced a 485px shadow,
and since the SVG is anchored left the whole error landed on one side.

`borderBoxSize` is subpixel; `offsetWidth` covers the very first call and the observer's
guaranteed initial fire corrects the rounding.

The original `box-shadow` and `border` are read **once** and cached on the element: by the
time the observer fires again, `box-shadow: none` and `border-color: transparent` are the
element's own inline values. `refresh(root, { reread: true })` throws that reading away,
which is what an element that gains or loses a shadow needs.

# Not supported

- Elliptical radii (`border-radius: 20px / 40px`) — the horizontal radius is used.
- `inset` shadows.
- A per-side budget for strongly mixed radii, as noted above.
