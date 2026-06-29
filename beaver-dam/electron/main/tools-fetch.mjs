'use strict'

import * as http from 'http'
import * as https from 'https'

// Strip HTML tags and decode common entities to produce readable plain text.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Conservative estimate: 1 token ≈ 4 characters of English text.
export function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[content truncated to fit context window]'
}

// Returns true if the given URL's origin is in the allowed list.
function isAllowed(url, allowedBaseUrls) {
  try {
    const target = new URL(url)
    return allowedBaseUrls.some(base => {
      try { return target.origin === new URL(base).origin } catch { return false }
    })
  } catch { return false }
}

// Fetches a URL with up to 3 redirect follows. Returns:
//   { ok: true, url, content, estimatedTokens }  on success
//   { ok: false, error }                          on failure
export function fetchUrl(url, allowedBaseUrls, maxTokens = 2000, redirectsLeft = 3) {
  return new Promise((resolve) => {
    if (!isAllowed(url, allowedBaseUrls)) {
      resolve({ ok: false, error: `URL not in allowed list: ${url}` })
      return
    }

    let parsed
    try { parsed = new URL(url) } catch {
      resolve({ ok: false, error: `Invalid URL: ${url}` })
      return
    }

    const lib = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'BeaverDam/1.0 (AI research assistant; contact beaver@example.com)',
        'Accept': 'text/html,text/plain,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000,
    }

    const req = lib.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        // Resolve relative redirects
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.origin}${res.headers.location}`
        fetchUrl(next, allowedBaseUrls, maxTokens, redirectsLeft - 1).then(resolve)
        return
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        resolve({ ok: false, error: `HTTP ${res.statusCode} from ${url}` })
        return
      }

      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        const contentType = res.headers['content-type'] || ''
        const text = contentType.includes('text/html') ? htmlToText(body) : body
        const truncated = truncateToTokens(text, maxTokens)
        resolve({
          ok: true,
          url,
          content: truncated,
          estimatedTokens: estimateTokens(truncated),
        })
      })
    })

    req.on('error', err => resolve({ ok: false, error: `Network error: ${err.message}` }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `Timeout fetching ${url}` }) })
    req.end()
  })
}
