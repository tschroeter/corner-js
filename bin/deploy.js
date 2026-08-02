#!/usr/bin/env bun

// Assembles the documentation page into dist/ and rsyncs it to a static host.
//
// The page loads its module as ../build/corner.min.js, which is right in the repo and wrong under a
// docroot: one level up from index.html would escape the site. So the assets are copied into the
// deployed tree and the two references rewritten -- nothing else about the page changes.
//
// The target is NOT hardcoded. This repository is public, and a server address in it would be
// infrastructure detail nobody needs:
//
//     CORNERJS_DEPLOY=user@host:/path/to/corner-js bun run deploy
//     CORNERJS_DEPLOY=... bun run deploy --dry-run

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const target = process.env.CORNERJS_DEPLOY
const dry_run = process.argv.includes('--dry-run')

if (!target)
{
    console.error('Set CORNERJS_DEPLOY to user@host:/path -- see the comment in bin/deploy.js.')
    process.exit(1)
}

function assemble ()
{
    rmSync(DIST, { recursive: true, force: true })
    mkdirSync(DIST, { recursive: true })

    // FLAT, and every reference explicitly relative. The repo keeps the artifact in build/, a docroot
    // has no level above it, and `./` is required rather than tidy: the page imports the Svelte
    // fixture dynamically, and `import('svelte-card.js')` is a BARE specifier -- the browser looks
    // for a package of that name and throws. It also makes the page's own snippet literally true,
    // since that shows `<script async src="corner.min.js">`.
    const page = readFileSync(join(ROOT, 'html', 'index.html'), 'utf8')
        .replaceAll('../build/', './')

    writeFileSync(join(DIST, 'index.html'), page)
    copyFileSync(join(ROOT, 'html', 'page.css'), join(DIST, 'page.css'))
    copyFileSync(join(ROOT, 'build', 'corner.min.js'), join(DIST, 'corner.min.js'))
    copyFileSync(join(ROOT, 'build', 'svelte-card.js'), join(DIST, 'svelte-card.js'))

    // A reference the rewrite missed would 404 on a live host and nowhere else. The snippets shown
    // to the reader contain markup as text -- `src="corner.min.js"` is documentation, not a load --
    // so they come out before anything is scanned.
    const markup = page.replace(/<pre[\s\S]*?<\/pre>/g, '')
    const missed = [...markup.matchAll(/(?:href|src)="((?!https?:|#|mailto:)[^"]+)"/g)]
        .map(match => match[1].split('?')[0])
        .filter(path => !['page.css', './corner.min.js'].includes(path))

    if (missed.length)
    {
        console.error('Unresolved relative references: ' + [...new Set(missed)].join(', '))
        process.exit(1)
    }
}

function run (command, args)
{
    const result = spawnSync(command, args, { stdio: 'inherit' })

    if (result.status !== 0) process.exit(result.status ?? 1)
}

assemble()

const [host, path] = target.split(':')

// The directory has to exist before rsync writes into it.
if (!dry_run) run('ssh', [host, 'mkdir -p ' + JSON.stringify(path)])

run('rsync', [
    '-avz',
    '--delete',
    ...(dry_run ? ['--dry-run', '--itemize-changes'] : []),
    DIST + '/',
    target + '/'
])

console.log(dry_run ? '\ndry run only -- nothing was written.' : '\ndeployed ' + target)
