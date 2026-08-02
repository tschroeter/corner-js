# Continues corners for the web - corner.js

Corner shapes CSS `border-radius` cannot draw: the **continuous** corner — Figma's
construction, an Apple-like shape — and true **superellipses**, as a `clip-path`, with the
`box-shadow` and the `border` along the same curve.

One file, no dependencies, 9.0 KB minified and 3.8 KB gzipped. MIT.

CSS is getting `corner-shape`, and where it exists corner.js steps aside for the
superellipse values. The continuous curve is an arc with Bézier shoulders, which no
`corner-shape` value expresses, so that one always draws.

## Install

```html
<script async src="corner.min.js"></script>
```

```
npm install corner.js
```

```js
import 'corner.js'
```

## Use

Mark the element and give it a `border-radius`. There is nothing to call.

```html
<div class="card" data-corner-js>…</div>
```

```css
.card {
    border-radius: 20px;
    box-shadow: 0 15px 30px rgba(0, 0, 0, 0.08);
}
```

`border-radius` is the construction's input, not a fallback, and `box-shadow` and `border`
are read from your CSS and redrawn along the curve.

| `data-corner-js` | Curve |
|---|---|
| *no value*, or `auto` | takes it from CSS: where the browser has `corner-shape` it has already drawn what you declared and this stays out of the way; where it has not, the continuous corner |
| `continuous` | arc with Bézier shoulders, smoothing `0.6` — always drawn, since no `corner-shape` value expresses it |
| `superellipse-<n>` | superellipse, exponent `n`, from 2 to 20. Native `corner-shape` draws it where that exists |

The per-corner longhands are read too. If `corner-top-left-shape` and its three siblings agree, that
shape is used; if they disagree, the corners are left to CSS — one path is drawn per element, so a
genuine mix cannot be honoured and drawing the wrong thing would be worse than drawing nothing.

Anything else is read as `auto`. The attribute is a request to draw, not a switch, so a typo still
gets a corner.

`auto` cannot read a `corner-shape` declaration in a browser that lacks the property: an unknown
declaration is dropped at parse time and reaches neither the computed style nor the CSSOM. That is
why the fallback is the continuous curve rather than a guess — set `continuous` or
`superellipse-<n>` explicitly when the shape has to be the same everywhere.

Smoothing comes from CSS and inherits, so one declaration can govern a whole subtree:

```css
.card { --corner-smoothing: 0.6; }
```

`0` is a plain arc, `1` leaves no arc at all.

## API

corner.js starts itself: it scans the document and watches for elements that appear or get
marked later. Both functions are for the cases that need more than that.

```js
import cornerjs from 'corner.js'                    // the frozen object
import { apply, refresh, VERSION } from 'corner.js' // or the functions
// or, from a <script> tag: nothing — window.cornerjs
```

The same object either way: `cornerjs === window.cornerjs`, and `cornerjs.apply === apply`. It is
frozen, because reassigning `apply` would break every element on the page. Any of the three
imports evaluates the module, so it starts itself — there is no separate `import 'corner.js'`.

**`apply(root)`** — draws every unstarted target under `root` *synchronously* and returns
how many it started. The observer delivers on a microtask, so only code that inserts a node
and measures it in the same tick needs this.

**`refresh(root, options)`** — redraws after a **style** change, which no `ResizeObserver`
sees. `refresh(root, { reread: true })` also re-reads `box-shadow` and `border` from CSS —
pass it when an element gains or loses either.

Size changes need neither: every element is watched by its own `ResizeObserver`.

## Browser support

`clip-path: path()`, `ResizeObserver`, `MutationObserver` and SVG filters — Chrome 88,
Safari 14, Firefox 79. Three engines: Edge, Opera, Brave and Vivaldi are Blink like Chrome,
and every browser on iOS is WebKit like Safari. Without them the declared `border-radius` stands, which is
the point of reading the shape out of CSS. The page under `html/` measures the browser it is
running in and derives the minimum from the features it actually uses.

## Limitations

- Elliptical radii (`border-radius: 20px / 40px`) use the horizontal radius. A percentage radius
  is elliptical by definition and gets the same treatment: resolved against the width. A `calc()`
  that mixes a percentage with a length never resolves in the computed value and reads as `0` —
  the one form of `border-radius` this does not understand.
- `inset` shadows are skipped: there is no outer silhouette to draw.
- **A shadow on the drawn element becomes an SVG filter, always.** That is only true of a shadow
  on *that* element: `clip-path` removes it, so it has to be rebuilt. Declare the shadow on the
  wrapper — or any unclipped ancestor — and it stays a plain `box-shadow`, which is what you want
  if the element is **animated**: an `feGaussianBlur` re-runs its convolution whenever a
  composited layer changes scale, a `box-shadow` does not. The cost is that its silhouette is a
  rounded rectangle rather than the curve, which under a soft blur is not visible anyway.
- **A shadow or a border puts the element in a wrapper `<div>`**, because the SVGs that replace
  them need a sibling and an unclipped parent. An element with neither is left where it is. A
  stylesheet that reaches a drawn element through `.parent > .child` has to know about the wrapper;
  the element keeps its own box either way.
- The observer is document-wide. On a page with very heavy DOM churn, call `apply()`
  yourself instead.

## Integration

Nothing to integrate with a framework: the element is marked in markup, so whatever renders
that markup is enough. There are no bindings, and none are needed.

**React, Vue, Svelte, Angular, Solid, Turbo** — the attribute is enough to get the corner
*drawn*: a node the framework mounts later is picked up by the observer on its own. The
documentation page mounts React, Vue, Solid and Turbo for real and reports what it measured;
Svelte and Angular compile ahead of time, so they are documented rather than exercised.

```jsx
<div className="card" data-corner-js="">…</div>
```

But corner.js moves every drawn element into a wrapper `<div>`, and the reconciler still
holds the parent it rendered into. Measured in Chrome, `removeChild` and `insertBefore` then
both throw `NotFoundError`. Inside a framework-owned subtree, render the wrapper yourself —
it is reused, not replaced — and call `apply` after mount:

```jsx
<div data-corner-shadow-wrap style={{ position: 'relative' }}>
    <div className="card" data-corner-js="">…</div>
</div>
```

```js
useEffect(() => { cornerjs.apply(ref.current) }, [])
```

Positioned, because the shadow SVG anchors to the nearest positioned ancestor. The element keeps
whatever size its own CSS gives it — corner.js does not resize it.

**Same tick as an insertion** — `apply(container)` draws synchronously. Only necessary when
the code measures the node it just inserted before the microtask queue runs.

```js
container.append(card)
cornerjs.apply(container)     // returns how many it started
card.getBoundingClientRect()  // already clipped
```

**After a style change** — `refresh(root)`, or `refresh(root, { reread: true })` when
`box-shadow` or `border` changed too. Changing `data-corner-js` itself needs neither: the
observer sees the new value and redraws the element in the new curve.

**Turbo, htmx, any HTML-over-the-wire swap** — nothing to hook. A replaced fragment is a DOM
insertion like any other, and the observer sees it.

## Development

```
bun install
bun run lint     # Closure Compiler, checks only, VERBOSE
bun run test     # geometry invariants plus a path snapshot
bun run build    # src/corner.js -> build/corner.min.js
bun run faq      # rewrites the page's FAQPage JSON-LD from the visible FAQ
```

`bin/build.js` is executable and runs on its own (`./bin/build.js`, `./bin/build.js --check`).
It uses nothing bun-specific, so `node bin/build.js` works too.

```
src/corner.js          the ES module, and the only file to edit
build/corner.min.js    the artifact every demo loads
bin/build.js           lint and build
bin/faq-schema.js      regenerates the page's FAQ structured data from its markup
test/paths.js          geometry invariants and the path snapshot
docs/algorithm.md      the construction, the budget clamp, the filter chain
html/                  the documentation page
```

Google Closure Compiler in `SIMPLE` mode — measured here, `ADVANCED` saves 100 bytes gzipped
and renames the object-literal keys that go through `setAttribute`, so `stdDeviation` becomes
`U` and the shadow filter draws nothing. The build fails on any warning, and on a version
mismatch between `src/corner.js` and `package.json`.

## Credits

The photographs in the component examples are by Yusuf Evli, Ellen Qin and Nicolas Lafargue on
[Unsplash](https://unsplash.com), hotlinked from their CDN as the licence prefers.


The continuous corner follows Figma's
[Desperately seeking squircles](https://www.figma.com/blog/desperately-seeking-squircles/),
by way of [phamfoo/figma-squircle](https://github.com/phamfoo/figma-squircle) — its port of
that derivation is what the geometry here was checked against, term by term.

Neither the shape nor the mathematics belongs to anyone recent: Piet Hein's superellipse
predates all of it.
