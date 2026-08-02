// corner.js -- draws continuous and superellipse corners as a clip-path where CSS
// corner-shape cannot. The construction is derived in docs/algorithm.md.

// The build fails if this and package.json disagree.
export const VERSION = '0.2.0'

const CORNER_ATTRIBUTE = 'data-corner-js'
const TARGET_SELECTOR = '[data-corner-js]'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_STYLE = 'position:absolute;pointer-events:none;overflow:visible'
const ELEMENT_NODE = 1

// A superellipse needs roughly double a circular border-radius to read as equally round.
const RADIUS_MULTIPLIER = 2

const CORNER_SHAPE_PROPERTIES = [
    'corner-top-left-shape', 'corner-top-right-shape',
    'corner-bottom-right-shape', 'corner-bottom-left-shape'
]

// 2 is the circle; past 20 it is a rectangle with a rounding error.
const MIN_EXPONENT = 2
const MAX_EXPONENT = 20
// What `squircle` means, in CSS and here: the Lame curve of exponent 4.
const DEFAULT_EXPONENT = 4

const POINTS_PER_CORNER = 20
const QUARTER_TURN = Math.PI / 2
const RIGHT_ANGLE = 90
const CORNER_STEPS = Array.from(
    { length: POINTS_PER_CORNER },
    (_, index) => (index + 1) / POINTS_PER_CORNER
)

// Figma's value for the Apple-like corner.
const CONTINUOUS_SMOOTHING = 0.6
const MIN_SMOOTHING = 0
const MAX_SMOOTHING = 1
// Below this the arc is a rounding error, and drawing it leaves a visible nick.
const ARC_EPSILON = 0.01

// The shadow SVG is absolutely positioned, so its bleed can extend a scrolling ancestor's
// scrollable area. Hence a floor rather than a generous constant.
const SHADOW_SVG_MARGIN = 32
// A CSS blur radius is two standard deviations, and a Gaussian is visually done by three.
const BLUR_REACH_FACTOR = 1.5
const BLUR_STDDEV_RATIO = 2

const RESIZE_FALLBACK_DELAY = 100

// Per load, not per document: two copies of this file on one page would otherwise both start
// their filter ids at 1, and the first `corner-shape-shadow-1` in the document wins for both.
// Math.random over crypto.randomUUID because the latter needs a secure context.
const FILTER_PREFIX = `corner-shape-shadow-${Math.random().toString(36).slice(2, 8)}`

const CACHE_KEYS = [
    '_cornerShapeSignature',
    '_cornerShapeOriginal', '_cornerShapeShadowCss', '_cornerShapeShadowSvg',
    '_cornerShapeShadowPath', '_cornerShapeShadowFilter', '_cornerShapeBorderSvg',
    '_cornerShapeBorderPath'
]

let shadow_filter_counter = 0
let observing = false

function clamp (value, min, max)
{
    return Math.max(min, Math.min(max, value))
}

function to_radians (degrees)
{
    return degrees * Math.PI / 180
}

function is_element (node)
{
    return node?.nodeType === ELEMENT_NODE
}

function set_attributes (node, attributes)
{
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)))

    return node
}

function svg_element (name, attributes)
{
    return set_attributes(document.createElementNS(SVG_NS, name), attributes)
}

function remove_node (node)
{
    node?.parentNode?.removeChild(node)
}

// A comma-separated CSS list, without breaking rgba(...) apart.
function split_top_level (value)
{
    const parts = []
    let depth = 0
    let current = ''

    for (const character of value)
    {
        if (character === '(') depth += 1
        if (character === ')') depth -= 1

        if (character === ',' && depth === 0)
        {
            parts.push(current)
            current = ''
            continue
        }

        current += character
    }

    if (current.trim()) parts.push(current)

    return parts
}

// One quarter of |x|^n + |1-y|^n = 1, in border-radius's own corner-box parametrisation.
function superellipse_point (t, n)
{
    return [
        Math.pow(Math.sin(t), 2 / n),
        1 - Math.pow(Math.cos(t), 2 / n)
    ]
}

function rotate90 (point, times)
{
    const [x, y] = point

    switch (((times % 4) + 4) % 4)
    {
        case 0: return [x, y]
        case 1: return [y, -x]
        case 2: return [-x, -y]
        default: return [-y, x]
    }
}

function superellipse_corner (origin_x, origin_y, radius, rotation, n)
{
    if (radius <= 0) return ''

    return CORNER_STEPS.map(step =>
    {
        const [x, y] = rotate90(superellipse_point(QUARTER_TURN * step, n), rotation)

        return `L ${origin_x + x * radius} ${origin_y + y * radius} `
    }).join('')
}

// radii = [top-left, top-right, bottom-right, bottom-left].
function build_superellipse_path (width, height, radii, n)
{
    // The authored radius, not the browser's clamped one, so it clamps per spec itself.
    const limit = Math.min(width / 2, height / 2)
    const [tl, tr, br, bl] = radii.map(radius => clamp(radius, 0, limit))

    return [
        `M 0 ${height - bl} `,
        `L 0 ${tl} `,
        superellipse_corner(0, tl, tl, 1, n),
        `L ${width - tr} 0 `,
        superellipse_corner(width - tr, 0, tr, 0, n),
        `L ${width} ${height - br} `,
        superellipse_corner(width, height - br, br, 3, n),
        `L ${bl} ${height} `,
        superellipse_corner(bl, height, bl, 2, n),
        'Z'
    ].join('')
}

function smoothing_from (style)
{
    const raw = parseFloat(style.getPropertyValue('--corner-smoothing'))

    if (isNaN(raw)) return CONTINUOUS_SMOOTHING

    return clamp(raw, MIN_SMOOTHING, MAX_SMOOTHING)
}

function continuous_budget (width, height)
{
    return Math.min(width, height) / 2
}

// Both the radius and the reach need the budget: clamping the radius alone is too generous by
// exactly (1 + smoothing), and an overrunning reach makes the path run backwards.
function continuous_corner_params (radius, requested_smoothing, budget)
{
    if (radius <= 0) return null

    const smoothing = Math.min(requested_smoothing, budget / radius - 1)
    const reach = Math.min((1 + requested_smoothing) * radius, budget)
    const arc_measure = RIGHT_ANGLE * (1 - smoothing)
    const arc = Math.sin(to_radians(arc_measure / 2)) * radius * Math.sqrt(2)
    const angle_alpha = (RIGHT_ANGLE - arc_measure) / 2
    const angle_beta = RIGHT_ANGLE / 2 * smoothing
    const c = radius * Math.tan(to_radians(angle_alpha / 2)) * Math.cos(to_radians(angle_beta))
    const d = c * Math.tan(to_radians(angle_beta))
    const b = (reach - arc - c - d) / 3

    return { a: 2 * b, b, c, d, arc, radius, reach }
}

// Clockwise from the top edge. Relative deltas, so the same a/b/c/d lengths serve all four
// corners -- derivation in docs/algorithm.md.
const CONTINUOUS_CORNERS = {
    top_right: ({ a, b, c, d, arc }) => [
        [a, 0, a + b, 0, a + b + c, d],
        [arc, arc],
        [d, c, d, b + c, d, a + b + c]
    ],
    bottom_right: ({ a, b, c, d, arc }) => [
        [0, a, 0, a + b, -d, a + b + c],
        [-arc, arc],
        [-c, d, -b - c, d, -a - b - c, d]
    ],
    bottom_left: ({ a, b, c, d, arc }) => [
        [-a, 0, -a - b, 0, -a - b - c, -d],
        [-arc, -arc],
        [-d, -c, -d, -b - c, -d, -a - b - c]
    ],
    top_left: ({ a, b, c, d, arc }) => [
        [0, -a, 0, -a - b, d, -a - b - c],
        [arc, -arc],
        [c, -d, b + c, -d, a + b + c, -d]
    ]
}

function continuous_corner (params, corner)
{
    if (!params) return ''

    const { arc, radius } = params
    const [entry, sweep, exit] = CONTINUOUS_CORNERS[corner](params)

    return [
        `c ${entry.join(' ')} `,
        arc > ARC_EPSILON ? `a ${radius} ${radius} 0 0 1 ${sweep.join(' ')} ` : '',
        `c ${exit.join(' ')} `
    ].join('')
}

function build_continuous_path (width, height, radii, smoothing = CONTINUOUS_SMOOTHING)
{
    const budget = continuous_budget(width, height)
    const [tl, tr, br, bl] = radii.map(
        radius => continuous_corner_params(clamp(radius, 0, budget), smoothing, budget)
    )
    const reach_of = params => params?.reach ?? 0

    return [
        `M ${width - reach_of(tr)} 0 `,
        continuous_corner(tr, 'top_right'),
        `L ${width} ${height - reach_of(br)} `,
        continuous_corner(br, 'bottom_right'),
        `L ${reach_of(bl)} ${height} `,
        continuous_corner(bl, 'bottom_left'),
        `L 0 ${reach_of(tl)} `,
        continuous_corner(tl, 'top_left'),
        'Z'
    ].join('')
}

function build_path ({ mode, rect, radii, smoothing })
{
    const { width, height } = rect

    if (mode === 'continuous') return build_continuous_path(width, height, radii, smoothing)

    return build_superellipse_path(width, height, radii, mode)
}

function extract_color (text)
{
    const match = text.match(/[a-zA-Z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/)
        ?? text.match(/#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,}/)

    if (!match) return { color: null, rest: text }

    return { color: match[0], rest: text.replace(match[0], ' ') }
}

function parse_shadow_layer (part)
{
    const text = part.trim()

    if (/\binset\b/.test(text)) return null

    const { color, rest } = extract_color(text)
    const lengths = (rest.match(/-?[\d.]+px/g) ?? []).map(parseFloat)

    if (lengths.length < 2) return null

    return {
        color: color ?? 'currentColor',
        dx: lengths[0],
        dy: lengths[1],
        blur: lengths[2] ?? 0,
        spread: lengths[3] ?? 0
    }
}

function parse_box_shadow (value)
{
    if (!value || value === 'none') return []

    return split_top_level(value).map(parse_shadow_layer).filter(Boolean)
}

function layer_reach (layer)
{
    return BLUR_REACH_FACTOR * layer.blur
        + Math.max(Math.abs(layer.dx), Math.abs(layer.dy))
        + Math.max(layer.spread, 0)
}

function shadow_reach (layers)
{
    return Math.max(SHADOW_SVG_MARGIN, Math.ceil(Math.max(0, ...layers.map(layer_reach))))
}

function append_spread (filter, layer, index)
{
    if (!layer.spread) return 'SourceAlpha'

    filter.appendChild(svg_element('feMorphology', {
        in: 'SourceAlpha',
        operator: layer.spread > 0 ? 'dilate' : 'erode',
        radius: Math.abs(layer.spread),
        result: `spread${index}`
    }))

    return `spread${index}`
}

function append_layer_chain (filter, layer, index)
{
    filter.appendChild(svg_element('feGaussianBlur', {
        in: append_spread(filter, layer, index),
        stdDeviation: layer.blur / BLUR_STDDEV_RATIO,
        result: `blur${index}`
    }))

    filter.appendChild(svg_element('feOffset', {
        in: `blur${index}`,
        dx: layer.dx,
        dy: layer.dy,
        result: `offset${index}`
    }))

    filter.appendChild(svg_element('feFlood', {
        'flood-color': layer.color,
        result: `flood${index}`
    }))

    filter.appendChild(svg_element('feComposite', {
        in: `flood${index}`,
        in2: `offset${index}`,
        operator: 'in',
        result: `color${index}`
    }))

    return `color${index}`
}

function fill_shadow_filter (filter, layers)
{
    filter.replaceChildren()
    // Safari interprets percentage filter regions asymmetrically.
    filter.setAttribute('filterUnits', 'userSpaceOnUse')
    filter.setAttribute('color-interpolation-filters', 'sRGB')

    const results = layers.map((layer, index) => append_layer_chain(filter, layer, index))
    const merge = svg_element('feMerge', {})

    // box-shadow paints the first layer on top, feMerge the last node.
    results.reverse().forEach(result => merge.appendChild(svg_element('feMergeNode', { in: result })))

    filter.appendChild(merge)
}

// Before el, so it paints behind it.
function create_shadow_svg (el, wrapper)
{
    shadow_filter_counter += 1

    const filter_id = `${FILTER_PREFIX}-${shadow_filter_counter}`
    const filter = svg_element('filter', { id: filter_id })
    const defs = svg_element('defs', {})
    const path = svg_element('path', { fill: '#000', filter: `url(#${filter_id})` })
    const svg = svg_element('svg', { 'aria-hidden': 'true' })

    defs.appendChild(filter)
    svg.append(defs, path)
    wrapper.insertBefore(svg, el)

    el._cornerShapeShadowSvg = svg
    el._cornerShapeShadowPath = path
    el._cornerShapeShadowFilter = filter
}

function place_svg (svg, left, top, width, height)
{
    svg.style.cssText = `${SVG_STYLE};left:${left}px;top:${top}px;width:${width}px;height:${height}px`

    set_attributes(svg, { viewBox: `0 0 ${width} ${height}` })
}

function place_shadow_svg (svg, filter, rect, margin)
{
    const width = rect.width + margin * 2
    const height = rect.height + margin * 2

    place_svg(svg, -margin, -margin, width, height)
    // userSpaceOnUse resolves before the path's transform, so the region is in the path's
    // own space and starts at -margin.
    set_attributes(filter, { x: -margin, y: -margin, width, height })
}

function update_shadow_svg (context, shadow_css)
{
    const layers = parse_box_shadow(shadow_css)

    if (!layers.length) return

    const { el, wrapper, rect } = context

    if (!el._cornerShapeShadowSvg) create_shadow_svg(el, wrapper)

    if (el._cornerShapeShadowCss !== shadow_css)
    {
        fill_shadow_filter(el._cornerShapeShadowFilter, layers)
        el._cornerShapeShadowCss = shadow_css
    }

    const margin = shadow_reach(layers)

    place_shadow_svg(el._cornerShapeShadowSvg, el._cornerShapeShadowFilter, rect, margin)
    set_attributes(el._cornerShapeShadowPath, {
        transform: `translate(${margin},${margin})`,
        d: build_path(context)
    })
}

// After el, so it paints over it.
function create_border_svg (el, wrapper)
{
    const path = svg_element('path', { fill: 'none' })
    const svg = svg_element('svg', { 'aria-hidden': 'true' })

    svg.appendChild(path)
    wrapper.insertBefore(svg, el.nextSibling)

    el._cornerShapeBorderSvg = svg
    el._cornerShapeBorderPath = path
}

// clip-path cuts the outer half off the element's own border, so it is stroked instead.
function update_border_svg (context, color, width)
{
    const { el, wrapper, rect } = context

    if (!el._cornerShapeBorderSvg) create_border_svg(el, wrapper)

    place_svg(el._cornerShapeBorderSvg, 0, 0, rect.width, rect.height)
    set_attributes(el._cornerShapeBorderPath, {
        d: build_path(context),
        stroke: color,
        'stroke-width': width
    })
}

// clip-path removes box-shadow on the same element, so the shadow needs an unclipped ancestor.
// Called only when a shadow or a border has to be redrawn: those need siblings, and a sibling needs
// a parent that is not clipped. An element with neither keeps its own place in the DOM.
function ensure_wrapper (el)
{
    const parent = el.parentElement

    if (parent.hasAttribute('data-corner-shadow-wrap')) return parent

    const before = { width: el.offsetWidth, height: el.offsetHeight }
    const display = getComputedStyle(el).display
    const wrapper = document.createElement('div')

    wrapper.setAttribute('data-corner-shadow-wrap', '')
    wrapper.style.position = 'relative'
    // A div is display: block, and the wrapper takes the element's place in the flow -- so an
    // inline button or link would be pulled onto a line of its own. Only the OUTER role has to
    // match; what the element does inside itself is unchanged.
    if (display.startsWith('inline')) wrapper.style.display = 'inline-block'
    // The element now inherits from THIS, not from the parent it was written against, so
    // `border-radius: inherit` on the target resolved to 0 and drew a square corner. The wrapper
    // paints nothing, so passing the value through costs nothing.
    wrapper.style.borderRadius = 'inherit'
    parent.insertBefore(wrapper, el)
    wrapper.appendChild(el)

    // THE BOX MUST SURVIVE THE MOVE, and the safest way is to leave it alone. If the element still
    // measures what it did before, nothing else is needed.
    //
    // The SVGs are placed at the WRAPPER's origin, which assumes the element sits there. It does,
    // for everything that is not centred by an auto margin -- and reading the real offset instead
    // was worse: it is measured once at boot, a later move does not resize anything, so nothing
    // redraws and the shadow stays where it was. An auto margin on a shadowed element offsets its
    // shadow by that margin; put the margin on a parent.
    if (el.offsetWidth !== before.width || el.offsetHeight !== before.height)
    {
        wrapper.style.width = before.width + 'px'
        wrapper.style.height = before.height + 'px'
    }

    return wrapper
}

// Never getBoundingClientRect: the drawing sits in the same subtree, so a scaled rect would
// apply the scale twice.
function measure_layout_box (el, box_size)
{
    if (box_size?.inlineSize > 0)
    {
        return { width: box_size.inlineSize, height: box_size.blockSize }
    }

    return { width: el.offsetWidth, height: el.offsetHeight }
}

// A percentage stays a percentage in the computed value, so it has to be resolved here or it
// reads as that many pixels: 25% on a 200px box drew a 25px corner. Against the WIDTH, matching
// the elliptical case, where the horizontal radius is the one used. A calc() mixing a percentage
// does not resolve at all in the computed value and still reads as 0.
function radius_length (value, width)
{
    const percentage = /^([\d.]+)%/.exec(value)

    if (percentage) return Number(percentage[1]) / 100 * width

    return parseFloat(value) || 0
}

function radii_for (style, multiplier, width)
{
    return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius
    ].map(value => radius_length(value, width) * multiplier)
}

// Cached: by the second run these are the module's own inline values.
function original_decoration (el, style)
{
    if (!el._cornerShapeOriginal)
    {
        const border_width = parseFloat(style.borderTopWidth) || 0

        el._cornerShapeOriginal = {
            shadow: style.boxShadow,
            has_shadow: Boolean(style.boxShadow) && style.boxShadow !== 'none',
            has_border: border_width > 0 && style.borderTopStyle !== 'none',
            border_width,
            border_color: style.borderTopColor,
            // Read before the caller overwrites them, so a reset can hand them back.
            inline_shadow: el.style.boxShadow,
            inline_border_color: el.style.borderColor
        }
    }

    return el._cornerShapeOriginal
}

function apply_once (el, mode, box_size)
{
    const rect = measure_layout_box(el, box_size)

    if (rect.width <= 0 || rect.height <= 0) return

    const style = getComputedStyle(el)

    // AN INLINE ELEMENT HAS NO SINGLE BOX TO CLIP. Its reference box is the union of its line
    // fragments, while offsetWidth/offsetHeight report the padding box -- so a path measured from
    // those is applied against a shorter line box and cuts the text away. inline-block gives it one
    // box and leaves it in the line; a <span> badge wants that anyway. Checked here rather than once
    // at boot, because a stylesheet that lands later changes the answer.
    if (style.display === 'inline')
    {
        el.style.display = 'inline-block'

        return apply_once(el, mode, box_size)
    }

    // The continuous construction scales itself; only superellipses double.
    const multiplier = mode === 'continuous' ? 1 : RADIUS_MULTIPLIER
    const radii = radii_for(style, multiplier, rect.width)
    const smoothing = mode === 'continuous' ? smoothing_from(style) : 0
    const original = original_decoration(el, style)
    // Everything the drawing depends on. An observer fires on transitions, on scroll-driven
    // layout and after every refresh, and those often arrive with nothing changed -- without
    // this the path is rebuilt and written back identically each time.
    const signature = `${mode}|${rect.width}x${rect.height}|${radii}|${smoothing}|${original.shadow}`

    if (el._cornerShapeSignature === signature) return

    el._cornerShapeSignature = signature

    const context = { el, mode, rect, radii, smoothing }

    el.style.clipPath = `path("${build_path(context)}")`

    if (!original.has_shadow && !original.has_border) return

    // Only now: the wrapper exists for the sibling SVGs, and nothing else needs it.
    context.wrapper = ensure_wrapper(el)

    if (original.has_shadow)
    {
        el.style.boxShadow = 'none'
        update_shadow_svg(context, original.shadow)
    }

    if (original.has_border)
    {
        el.style.borderColor = 'transparent'
        update_border_svg(context, original.border_color, original.border_width)
    }
}

function observe_size (el, redraw)
{
    // ResizeObserver does not exist in older browsers.
    if (typeof ResizeObserver === 'undefined')
    {
        let timer = null
        const schedule = () =>
        {
            clearTimeout(timer)
            timer = setTimeout(redraw, RESIZE_FALLBACK_DELAY)
        }

        window.addEventListener('resize', schedule)
        el._cornerShapeUnwatch = () => window.removeEventListener('resize', schedule)

        return
    }

    const observer = new ResizeObserver(entries => redraw(entries[0]?.borderBoxSize?.[0]))

    observer.observe(el)
    // Exposed so an animation driver can disconnect during a transform-based animation.
    el._cornerShapeObserver = observer
    el._cornerShapeUnwatch = () => observer.disconnect()
}

function watch_and_apply (el, mode)
{
    const redraw = (box_size = null) => apply_once(el, mode, box_size)

    el._cornerShapeRefresh = () => redraw()
    redraw()
    observe_size(el, redraw)
}

// So the next apply starts from the stylesheet again.
function reset_element (el)
{
    const original = el._cornerShapeOriginal

    // Only undo what was actually written. Without the cache nothing was overwritten, and
    // blanking anyway deletes declarations belonging to whoever set them.
    if (original)
    {
        el.style.clipPath = ''
        el.style.boxShadow = original.inline_shadow
        el.style.borderColor = original.inline_border_color
    }

    remove_node(el._cornerShapeShadowSvg)
    remove_node(el._cornerShapeBorderSvg)

    CACHE_KEYS.forEach(key => delete el[key])
}

// A new attribute value on an element that already drew. The mode is captured when the element
// starts and its size observer holds that capture, so the observer has to go with it -- leaving
// it attached would keep redrawing the old curve alongside the new one.
function restart (el)
{
    el._cornerShapeUnwatch?.()
    reset_element(el)

    delete el._cornerShapeUnwatch
    delete el._cornerShapeObserver
    delete el._cornerShapeRefresh
    delete el._cornerBooted

    start(el)
}

function corner_attribute (el)
{
    return el.getAttribute(CORNER_ATTRIBUTE)?.trim() ?? ''
}

// Two explicit values and a default. Anything unrecognised is 'auto' rather than an error: the
// attribute is a request to draw, not a switch, and a typo should still get a corner.
function mode_for (el)
{
    const attribute = corner_attribute(el)

    if (attribute === 'continuous') return 'continuous'

    const exponent = /^superellipse-(\d+(?:\.\d+)?)$/.exec(attribute)

    if (exponent) return clamp(parseFloat(exponent[1]), MIN_EXPONENT, MAX_EXPONENT)

    return 'auto'
}

// THE CONVENTION. `corner-shape` itself is unreadable in a browser that lacks the property -- an
// unknown declaration is dropped at parse time and reaches neither the computed style nor the
// CSSOM. A custom property is kept whatever its value, so one declaration can feed both:
//
//   .card { --corner-shape: squircle; corner-shape: var(--corner-shape); }
//
// The browser draws it where it can, this reads the same words where it cannot. `continuous` is
// only ever seen here: it is invalid for the real property, so CSS falls back to a plain arc and
// the module draws the curve no corner-shape value expresses.
function declared_shape (el, style)
{
    const custom = style.getPropertyValue('--corner-shape').trim()

    if (custom) return custom

    const corners = CORNER_SHAPE_PROPERTIES.map(name => style.getPropertyValue(name).trim())
    const named = corners.filter(Boolean)

    // FOUR CORNERS, ONE CONSTRUCTION. The longhands are read so that a per-corner declaration is
    // not silently ignored -- it used to leave the shorthand at `round`, which read as "nothing
    // asked for" and drew four continuous corners over one squircle corner the author wanted. One
    // path is emitted per element, so a genuine mix is handed back to CSS rather than approximated.
    if (named.length === 4 && named.some(shape => shape !== named[0])) return 'mixed'

    const shape = named[0] || style.cornerShape?.trim()

    return shape && shape !== 'round' ? shape : ''
}

function mode_from_shape (shape)
{
    // More than one construction on one element: nothing here can draw that, and drawing the wrong
    // thing is worse than leaving the corners to border-radius.
    if (shape === 'mixed') return 'none'
    if (shape === 'continuous') return 'continuous'
    if (shape === 'round') return 'none'
    if (shape === 'squircle') return DEFAULT_EXPONENT

    const power = /^superellipse\(\s*(-?[\d.]+)\s*\)$/.exec(shape)

    if (power) return clamp(2 ** parseFloat(power[1]), MIN_EXPONENT, MAX_EXPONENT)

    return 'continuous'
}

function init (el)
{
    const mode = mode_for(el)

    if (mode === 'auto')
    {
        const declared = declared_shape(el, getComputedStyle(el))

        // Nothing declared: the continuous curve, which CSS has no value for.
        if (!declared)
        {
            watch_and_apply(el, 'continuous')
            return
        }

        const wanted = mode_from_shape(declared)

        // A plain arc is border-radius' own job, and a superellipse belongs to the browser wherever
        // the property exists -- in both cases there is nothing here to draw.
        if (wanted === 'none') return
        if (wanted !== 'continuous' && window.CSS?.supports?.('corner-shape', 'squircle')) return

        watch_and_apply(el, wanted)
        return
    }

    // Before the support test: an arc with Bezier shoulders has no corner-shape value, so an
    // explicit continuous always draws.
    if (mode === 'continuous')
    {
        watch_and_apply(el, 'continuous')
        return
    }

    if (window.CSS?.supports?.('corner-shape', 'squircle')) return

    watch_and_apply(el, mode)
}

// Returns whether it started, so apply() can count what it actually drew.
function start (el)
{
    if (el._cornerBooted) return false

    // A parentless element has nowhere to put the wrapper and no box to measure. Deliberately
    // NOT marked as booted: once it is inserted, the observer sees the insertion and draws it.
    if (!el.parentElement) return false

    el._cornerBooted = true
    init(el)

    return true
}

/**
 * Redraws every corner under `root`. For a style change, which no ResizeObserver sees --
 * a size change needs nothing.
 *
 * @param {(Document|Element)=} root Defaults to `document`.
 * @param {{reread: (boolean|undefined)}=} options `reread` also re-reads box-shadow and
 *     border from CSS, which an element that gains or loses either needs.
 * @return {void}
 */
export function refresh (root, options)
{
    const scope = root || document
    const targets = [...scope.querySelectorAll('*')]

    if (is_element(scope)) targets.unshift(scope)

    targets
        .filter(el => typeof el._cornerShapeRefresh === 'function')
        .forEach(el =>
        {
            if (options?.reread) reset_element(el)

            el._cornerShapeRefresh()
        })
}

/**
 * Draws every unstarted target under `root` synchronously. Only needed for work in the same
 * tick as an insertion: the observer below delivers on a microtask, so code that inserts a
 * node and measures it immediately would measure it unclipped.
 *
 * @param {(Document|Element)=} root Defaults to `document`. Counts as a target itself only
 *     if it carries `data-corner-js`.
 * @return {number} How many elements were started.
 */
export function apply (root)
{
    const scope = root || document
    const targets = [...scope.querySelectorAll(TARGET_SELECTOR)]

    // The root counts only if it marks itself, or passing a container would clip it.
    if (is_element(scope) && scope.matches?.(TARGET_SELECTOR)) targets.unshift(scope)

    return targets.filter(start).length
}

function scan (root)
{
    if (!root?.querySelectorAll) return

    if (is_element(root) && root.matches?.(TARGET_SELECTOR)) start(root)

    root.querySelectorAll(TARGET_SELECTOR).forEach(start)
}

function handle_mutation (record)
{
    if (record.type === 'attributes')
    {
        if (record.target._cornerBooted) restart(record.target)
        else start(record.target)

        return
    }

    // Nodes without querySelectorAll drop out in scan.
    record.addedNodes.forEach(scan)
}

// Document-wide, so a consumer writes markup and nothing else. The cost is a callback on
// every DOM mutation on the page.
function observe ()
{
    if (observing || typeof MutationObserver === 'undefined') return

    observing = true

    const observer = new MutationObserver(records => records.forEach(handle_mutation))

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [CORNER_ATTRIBUTE]
    })
}

// ONE OBJECT, THREE WAYS TO REACH IT: the default export, the named exports above, and the global
// for a plain <script> tag. Frozen, because a consumer that reassigns cornerjs.apply breaks every
// element on the page.
const cornerjs = Object.freeze({ VERSION, apply, refresh })

window.cornerjs = cornerjs

export default cornerjs

// No boot call and no DOMContentLoaded, so the built file can be loaded async.
scan(document)
observe()
