#!/usr/bin/env bun
// Rewrites the FAQPage block in html/index.html from the visible FAQ markup.
//
// Google requires the answer in the structured data to be the answer on the page. Keeping the two
// in step by hand failed four times in a row, so the JSON is generated from the markup instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PAGE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'html', 'index.html')
const ENTITIES = {
    '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
    '&ldquo;': '“', '&rdquo;': '”', '&deg;': '°', '&nbsp;': ' ',
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&'
}

function plain (fragment)
{
    let text = fragment.replace(/<sup>(\d+)<\/sup>/g, '^$1').replace(/<[^>]+>/g, '')

    for (const [entity, character] of Object.entries(ENTITIES))
    {
        text = text.split(entity).join(character)
    }

    return text.replace(/\s+/g, ' ').trim()
}

const page = readFileSync(PAGE, 'utf8')
const faq = /<div class="faq">([\s\S]*?)\n {8}<\/div>/.exec(page)

if (!faq) throw new Error('no <div class="faq"> block found')

const cards = [...faq[1].matchAll(/<details[^>]*>([\s\S]*?)<\/details>/g)]

if (!cards.length) throw new Error('no question/answer pairs found')

// EVERY paragraph of an answer, and no code block: a <pre> reads as noise in a search result.
const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: cards.map(([, card]) =>
    {
        const question = /<summary><span>([\s\S]*?)<\/span><\/summary>/.exec(card)

        if (!question) throw new Error('a details block has no <summary><span>')

        const answer = [...card.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => plain(match[1]))

        return {
            '@type': 'Question',
            name: plain(question[1]),
            acceptedAnswer: { '@type': 'Answer', text: answer.join(' ') }
        }
    })
}

const block = '<script type="application/ld+json">\n' + JSON.stringify(schema, null, 4) + '\n</script>'
const existing = /<script type="application\/ld\+json">\s*\{\s*"@context"[^]*?"@type": "FAQPage"[\s\S]*?<\/script>/

if (!existing.test(page)) throw new Error('no FAQPage block to replace')

writeFileSync(PAGE, page.replace(existing, block))
console.log('faq schema: ' + schema.mainEntity.length + ' questions written from the markup')
