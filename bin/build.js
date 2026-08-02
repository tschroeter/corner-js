#!/usr/bin/env bun
// src/corner.js -> Google Closure Compiler -> build/corner.min.js
//
//   bun bin/build.js            writes corner.min.js
//   bun bin/build.js --check    compiles and reports only, writes nothing
//
// Any warning fails the build: Closure exits 0 on warnings, so the summary line is read.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(ROOT, 'src', 'corner.js')
const OUTPUT = join(ROOT, 'build', 'corner.min.js')
const COMPILER = join(ROOT, 'node_modules', '.bin', 'google-closure-compiler')

const source = readFileSync(SOURCE, 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declared = /^export const VERSION = '([^']+)'$/m.exec(source)?.[1]

if (declared !== manifest.version)
{
    console.error(`Version mismatch: src/corner.js says ${declared}, package.json says ${manifest.version}.`)
    process.exit(1)
}

// SIMPLE, not ADVANCED. Measured on this file: ADVANCED saves 100 bytes gzipped and renames
// every object-literal key -- including the ones that go through setAttribute, so
// `stdDeviation` became `U` and the shadow filter drew nothing. It would need every external
// key quoted and an externs file, for 3%.
const FLAGS = [
    '--js', SOURCE,
    '--compilation_level', 'SIMPLE',
    '--language_in', 'ECMASCRIPT_2021',
    '--language_out', 'ECMASCRIPT_2020',
    '--module_resolution', 'BROWSER',
    // Also what makes SIMPLE worth anything here: it turns the module's top-level names into
    // locals, and SIMPLE renames locals only. Without it the output stays 22 KB.
    '--isolation_mode', 'IIFE',
    '--rewrite_polyfills', 'false',
    '--warning_level', 'VERBOSE',
    '--summary_detail_level', '3'
]

const check_only = process.argv.includes('--check')

function kb (bytes)
{
    return (bytes / 1024).toFixed(1) + ' KB'
}

function run ()
{
    const flags = check_only
        ? [...FLAGS, '--checks_only']
        : [...FLAGS, '--js_output_file', OUTPUT]

    const result = spawnSync(COMPILER, flags, { encoding: 'utf8' })

    if (result.error)
    {
        console.error('Closure Compiler not found at ' + COMPILER + ' -- run `bun install` first.')
        process.exit(1)
    }

    const report = (result.stderr || '').trim()

    if (report) console.error(report)

    const warnings = Number(/(\d+) warning\(s\)/.exec(report)?.[1] ?? 0)

    if (result.status !== 0 || warnings > 0)
    {
        console.error('Build failed: ' + warnings + ' warning(s), exit ' + result.status + '.')
        process.exit(1)
    }
}

run()

if (check_only)
{
    console.log('lint: src/corner.js clean')
    process.exit(0)
}

// Prepended after the fact: --output_wrapper would do it, but it cannot be combined with
// --isolation_mode, and that flag is what makes the output small.
const banner = `/*! corner.js ${manifest.version} | ${manifest.homepage} | MIT */\n`

writeFileSync(OUTPUT, banner + readFileSync(OUTPUT, 'utf8'))

// ---- the page's own assets, stamped ----
//
// The page links page.css and the built module by plain name. Reloading index.html with a query
// string therefore refreshed the HTML and kept a stale stylesheet and a stale module -- which cost
// real debugging time: a badge whose text had been clipped away by a build that no longer existed.
// A content hash in the link means a build can never be half-applied in a browser.
function stamp_assets ()
{
    const page = join(ROOT, 'html', 'index.html')
    const digest = file => createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8)
    const css = digest(join(ROOT, 'html', 'page.css'))
    const js = digest(OUTPUT)
    const before = readFileSync(page, 'utf8')
    const after = before
        .replace(/href="page\.css(\?v=[^"]*)?"/, `href="page.css?v=${css}"`)
        .replace(/src="\.\.\/build\/corner\.min\.js(\?v=[^"]*)?"/, `src="../build/corner.min.js?v=${js}"`)

    if (after === before) return

    writeFileSync(page, after)
    console.log(`stamped  page.css?v=${css}  corner.min.js?v=${js}`)
}

// ---- the Svelte fixture ----
//
// Svelte compiles ahead of time, which is why its live check could not exist while the page had
// no build step for it. It has one now: the component in html/fixtures is compiled here, so the
// page mounts the SAME output a Svelte user would ship rather than a hand-written imitation.
// The generated code imports bare specifiers ('svelte/internal/client'); a static page has no
// resolver, so they are rewritten to the CDN the other checks already load from.
async function build_svelte ()
{
    const { compile } = await import('svelte/compiler')
    const svelte_version = JSON.parse(
        readFileSync(join(ROOT, 'node_modules', 'svelte', 'package.json'), 'utf8')
    ).version
    const fixture = join(ROOT, 'html', 'fixtures', 'Card.svelte')
    const { js, warnings } = compile(readFileSync(fixture, 'utf8'), {
        name: 'SvelteCard',
        generate: 'client',
        runes: true
    })

    if (warnings.length)
    {
        warnings.forEach(warning => console.error('svelte: ' + warning.message))
        process.exit(1)
    }

    // Both forms, or a side-effect import like `import 'svelte/internal/disclose-version'` stays
    // bare and the browser has nothing to resolve it against.
    const resolved = js.code.replace(
        /(from |import )['"](svelte(?:\/[^'"]+)?)['"]/g,
        (all, keyword, specifier) =>
            `${keyword}'https://esm.sh/${specifier.replace('svelte', 'svelte@' + svelte_version)}'`
    )
    const target = join(ROOT, 'build', 'svelte-card.js')

    writeFileSync(target, `// GENERATED by bin/build.js from html/fixtures/Card.svelte -- do not edit.\n${resolved}`)

    return { svelte_version, bytes: resolved.length }
}

const svelte = await build_svelte()

stamp_assets()

const minified = readFileSync(OUTPUT)

console.log('src/corner.js       ' + source.split('\n').length + ' lines, ' + kb(statSync(SOURCE).size))
console.log('build/corner.min.js ' + kb(minified.length) + ', ' + kb(gzipSync(minified).length) + ' gzipped')
console.log('build/svelte-card.js  ' + kb(svelte.bytes) + ', compiled with svelte ' + svelte.svelte_version)
