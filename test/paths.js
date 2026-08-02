// bun test/paths.js            checks geometry invariants and the committed snapshot
// bun test/paths.js --update    rewrites the snapshot from the current source
//
// corner.js exports only apply() and refresh(); the path builders stay private. The test
// evaluates the source with DOM stubs to reach them, so nothing has to be exported for
// testing alone.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', 'src', 'corner.js')
const SNAPSHOT = join(HERE, 'paths.snapshot.json')
const UPDATE = process.argv.includes('--update')

const INTERNALS = ['build_superellipse_path', 'build_continuous_path', 'parse_box_shadow', 'shadow_reach', 'mode_for', 'mode_from_shape']

function load ()
{
    const source = readFileSync(SOURCE, 'utf8')
        // `export default x` is a statement, not a declaration, so stripping the keyword alone
        // leaves `default cornerjs` behind -- it goes entirely.
        .replace(/^export default .*$/gm, '')
        .replace(/^export /gm, '')
        .replace(/^[ \t]*scan\(document\);?[ \t]*$/m, '')
        .replace(/^[ \t]*observe\(\);?[ \t]*$/m, '')

    const body = source + '\nreturn {' + INTERNALS.join(',') + '}'
    const stub_style = () => ({ getPropertyValue: () => '' })

    return new Function('window', 'document', 'getComputedStyle', body)({}, {}, stub_style)
}

const corner = load()

let checks = 0
const failures = []

function check (label, condition)
{
    checks += 1

    if (!condition) failures.push(label)
}

function equal (label, actual, expected)
{
    check(label + '\n  expected ' + JSON.stringify(expected) + '\n  actual   ' + JSON.stringify(actual),
        JSON.stringify(actual) === JSON.stringify(expected))
}

// Only M and L carry absolute coordinates; c and a carry deltas.
function absolute_points (path)
{
    return [...path.matchAll(/[ML] (-?[\d.e+-]+) (-?[\d.e+-]+)/g)].map(match => [Number(match[1]), Number(match[2])])
}

function check_shape (label, path, width, height)
{
    check(label + ': starts with M', path.startsWith('M '))
    check(label + ': closed', path.endsWith('Z'))
    check(label + ': no NaN', !/NaN|Infinity/.test(path))

    const slack = 0.5

    absolute_points(path).forEach(([x, y], index) =>
    {
        check(label + ': point ' + index + ' (' + x + ',' + y + ') inside the box',
            x >= -slack && x <= width + slack && y >= -slack && y <= height + slack)
    })
}

const SIZES = [[320, 200], [240, 240], [500, 80], [80, 500], [1, 1], [37.5, 91.25]]
const RADII = [[0, 0, 0, 0], [12, 12, 12, 12], [80, 80, 80, 80], [8, 24, 48, 96], [999, 0, 4, 40]]

for (const [width, height] of SIZES)
{
    for (const radii of RADII)
    {
        const label = width + 'x' + height + ' r=' + radii

        check_shape('superellipse ' + label, corner.build_superellipse_path(width, height, radii, 4), width, height)
        check_shape('continuous ' + label, corner.build_continuous_path(width, height, radii, 0.6), width, height)
    }
}

for (const [width, height] of SIZES)
{
    /* The budget clamp: an oversized radius must not push the first point past the
       midpoint of the top edge, or the path runs backwards and notches the long edges. */
    const path = corner.build_continuous_path(width, height, [999, 999, 999, 999], 0.6)
    const [[x]] = absolute_points(path)

    check('continuous ' + width + 'x' + height + ': first point at or after the midpoint', x >= width / 2 - 0.001)
}

// Four corners of 20 points each, plus the four straight edges.
const dense = corner.build_superellipse_path(200, 120, [24, 24, 24, 24], 4)

equal('superellipse L command count', (dense.match(/L /g) ?? []).length, 84)

const SHADOWS = {
    'none': [],
    'rgba(0, 0, 0, 0.5) 0px 0px 0px 1px inset': [],
    'black 2px 2px': [{ color: 'black', dx: 2, dy: 2, blur: 0, spread: 0 }],
    'rgba(0, 0, 0, 0.25) 0px 2px 4px -1px': [{ color: 'rgba(0, 0, 0, 0.25)', dx: 0, dy: 2, blur: 4, spread: -1 }],
    'lch(0 0 0 / 0.088) 0px 1px 2px 0px': [{ color: 'lch(0 0 0 / 0.088)', dx: 0, dy: 1, blur: 2, spread: 0 }],
    'color-mix(in srgb, red 20%, transparent) 0px 0px 8px': [{ color: 'color-mix(in srgb, red 20%, transparent)', dx: 0, dy: 0, blur: 8, spread: 0 }]
}

for (const [value, expected] of Object.entries(SHADOWS))
{
    equal('shadow ' + value, corner.parse_box_shadow(value), expected)
}

// 1.5 * blur + max(|dx|,|dy|) + spread, floored at the 32px minimum viewport.
equal('reach of a 30px blur', corner.shadow_reach(corner.parse_box_shadow('black 0px 0px 30px')), 45)
equal('reach floor', corner.shadow_reach(corner.parse_box_shadow('black 0px 1px 2px')), 32)

function element (attributes = {})
{
    return { getAttribute: name => attributes[name] ?? null }
}

// Three states only. A bare attribute, an explicit 'auto' and anything unrecognised all defer to
// CSS; the two explicit values force a curve.
equal('mode: bare attribute defers to CSS', corner.mode_for(element({ 'data-corner-js': '' })), 'auto')
equal('mode: explicit auto', corner.mode_for(element({ 'data-corner-js': 'auto' })), 'auto')
equal('mode: unrecognised value defers too', corner.mode_for(element({ 'data-corner-js': 'squircle' })), 'auto')
equal('mode: continuous', corner.mode_for(element({ 'data-corner-js': 'continuous' })), 'continuous')
equal('mode: exponent', corner.mode_for(element({ 'data-corner-js': 'superellipse-7.5' })), 7.5)
// 1 is not clamped any more: it is the straight chord, the same corner CSS calls `bevel`.
equal('mode: exponent 1 is the bevel, not a floor', corner.mode_for(element({ 'data-corner-js': 'superellipse-1' })), 1)
equal('mode: exponent clamped low', corner.mode_for(element({ 'data-corner-js': 'superellipse-0.001' })), 0.05)
equal('mode: exponent clamped high', corner.mode_for(element({ 'data-corner-js': 'superellipse-99' })), 20)
equal('mode: nonsense', corner.mode_for(element({ 'data-corner-js': 'nonsense' })), 'auto')

// THE CONVENTION, resolved: --corner-shape carries the words, and this maps them onto a curve.
// 'continuous' has no real CSS value, which is exactly why it can only be read here.
equal('shape: nothing declared', corner.mode_from_shape(''), 'continuous')
equal('shape: continuous', corner.mode_from_shape('continuous'), 'continuous')
equal('shape: round is border-radius own job', corner.mode_from_shape('round'), 'none')
equal('shape: squircle is exponent 4', corner.mode_from_shape('squircle'), 4)
// The property takes log2 of the exponent, so superellipse(2) is 4 and superellipse(1) is 2.
equal('shape: superellipse(2)', corner.mode_from_shape('superellipse(2)'), 4)
equal('shape: superellipse(1)', corner.mode_from_shape('superellipse(1)'), 2)
equal('shape: superellipse(3)', corner.mode_from_shape('superellipse(3)'), 8)
equal('shape: superellipse clamped high', corner.mode_from_shape('superellipse(9)'), 20)

// THE SIX KEYWORDS CSS DEFINES, each an alias for one parameter -- read back out of the property in
// Chrome 150, not out of the prose. k = 0 is exponent 1, where the curve is a straight chord.
equal('shape: bevel is the straight chord', corner.mode_from_shape('bevel'), 1)
equal('shape: superellipse(0) is bevel too', corner.mode_from_shape('superellipse(0)'), 1)
equal('shape: scoop is concave', corner.mode_from_shape('scoop'), 0.5)
equal('shape: superellipse(-1) is scoop', corner.mode_from_shape('superellipse(-1)'), 0.5)
equal('shape: notch is the concave extreme', corner.mode_from_shape('notch'), 0.05)
equal('shape: superellipse(-infinity) is notch', corner.mode_from_shape('superellipse(-infinity)'), 0.05)
equal('shape: square is the convex extreme', corner.mode_from_shape('square'), 20)
equal('shape: superellipse(infinity) is square', corner.mode_from_shape('superellipse(infinity)'), 20)
equal('shape: unrecognised still draws', corner.mode_from_shape('wobbly'), 'continuous')
equal('shape: a mix of constructions draws nothing', corner.mode_from_shape('mixed'), 'none')

// Math.pow and Math.sin differ in the last bit between engines -- V8 and
// JavaScriptCore disagree on e.g. 10.588253284096519 vs 10.58825328409652 -- so the
// snapshot compares 6 decimals. Well below a device pixel, and still exact enough to
// catch any real change to the curve.
function rounded (path)
{
    return path.replace(/-?\d+\.\d+(e[+-]\d+)?/g, match => String(Number(Number(match).toFixed(6))))
}

const cases = {
    'continuous 200x120 r24 s0.6': corner.build_continuous_path(200, 120, [24, 24, 24, 24], 0.6),
    'continuous 100x100 r50 s0.6 (capsule)': corner.build_continuous_path(100, 100, [50, 50, 50, 50], 0.6),
    'continuous 320x200 mixed radii s0.6': corner.build_continuous_path(320, 200, [8, 24, 48, 96], 0.6),
    'superellipse 200x120 r24 n4': corner.build_superellipse_path(200, 120, [24, 24, 24, 24], 4),
    'superellipse 200x120 r24 n5': corner.build_superellipse_path(200, 120, [24, 24, 24, 24], 5)
}

const paths = Object.fromEntries(Object.entries(cases).map(([label, path]) => [label, rounded(path)]))

if (UPDATE)
{
    writeFileSync(SNAPSHOT, JSON.stringify(paths, null, 4) + '\n')
    console.log('snapshot written: ' + Object.keys(paths).length + ' paths')
    process.exit(0)
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))

for (const [label, path] of Object.entries(paths))
{
    equal('snapshot ' + label, path, snapshot[label])
}

if (failures.length)
{
    failures.forEach(failure => console.error('FAIL ' + failure))
    console.error(failures.length + ' of ' + checks + ' checks failed')
    process.exit(1)
}

console.log(checks + ' checks passed')
