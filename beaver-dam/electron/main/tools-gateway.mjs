'use strict'

// =============================================================================
// Beaver Dam — Tool Gateway
// =============================================================================
// A lightweight HTTP proxy that sits between Beaver Log (or any client) and
// llama-server. When tool sources are configured in the active profile, it
// intercepts /v1/chat/completions, injects the web_fetch tool definition, runs
// the agentic loop (fetch → inject result → re-query), and returns the final
// response. All other requests are passed straight through to llama-server.
//
// Runs on llamaPort + 1. The beacon advertises this port so clients connect
// here instead of llama-server directly. When no tools are enabled the gateway
// is a pure transparent proxy — zero overhead other than a localhost hop.
// =============================================================================

import * as http from 'http'
import { fetchUrl } from './tools-fetch.mjs'

let gatewayServer = null

// Active tool config: set when the gateway starts, updated when profile changes.
// { allowedBaseUrls: string[], maxFetchTokens: number }
let activeConfig = null

// ---------------------------------------------------------------------------
// Tool definition injected into completions requests
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description:
      'Fetch and read the text content of a web page. ' +
      'Use this when you need up-to-date information not in your training data, ' +
      'or when the user asks you to look something up. ' +
      'Only use URLs from the approved sources listed below. ' +
      'Do not guess or invent URLs — use real, specific URLs from the approved domains.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch. Must be from an approved domain.',
        },
      },
      required: ['url'],
    },
  },
}

// ---------------------------------------------------------------------------
// Llama-server call (non-streaming, for tool loop iterations)
// ---------------------------------------------------------------------------

function callLlama(port, body) {
  return new Promise((resolve) => {
    // Force non-streaming inside the tool loop — we need to inspect the full
    // response to see whether the model made a tool call.
    const payload = JSON.stringify({ ...body, stream: false })

    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 180000,
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ ok: true, statusCode: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ ok: false, error: 'llama-server returned invalid JSON' }) }
      })
    })

    req.on('error', err => resolve({ ok: false, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'llama-server timeout' }) })
    req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// SSE helper — sends a non-streaming response as SSE for clients that
// requested stream:true (so the chat-ui receives data in the expected format).
// ---------------------------------------------------------------------------

function sendAsSse(res, completionData) {
  const choice = completionData.choices?.[0]
  const content = choice?.message?.content || ''

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  const chunk = {
    id: completionData.id || `chatcmpl-tool-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: completionData.created || Math.floor(Date.now() / 1000),
    model: completionData.model || '',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content },
      finish_reason: choice?.finish_reason || 'stop',
    }],
  }

  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

// ---------------------------------------------------------------------------
// Agentic loop handler
// ---------------------------------------------------------------------------

async function handleCompletion(req, res, llamaPort, config) {
  // Collect the full request body
  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  let parsed
  try { parsed = JSON.parse(rawBody) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Bad request: invalid JSON', type: 'invalid_request_error' } }))
    return
  }

  const clientWantsStream = !!parsed.stream

  // Build the request we send to llama-server, with tool definitions injected.
  const messages = [...(parsed.messages || [])]
  const request = {
    ...parsed,
    stream: false,         // we always force non-streaming in the loop
    tools: [WEB_FETCH_TOOL],
    tool_choice: 'auto',
    messages,
  }

  // Agentic loop — cap at 5 iterations to prevent runaway tool calls
  for (let turn = 0; turn < 5; turn++) {
    const result = await callLlama(llamaPort, request)

    if (!result.ok) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: { message: result.error, type: 'gateway_error' } }))
      return
    }

    const choice = result.data?.choices?.[0]
    const toolCalls = choice?.message?.tool_calls

    // No tool call → model has a final answer
    if (!toolCalls || toolCalls.length === 0) {
      if (clientWantsStream) {
        sendAsSse(res, result.data)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(result.data))
      }
      return
    }

    // Execute each tool call and collect results
    const assistantMsg = {
      role: 'assistant',
      content: choice.message.content || null,
      tool_calls: toolCalls,
    }
    const toolResultMsgs = []

    for (const call of toolCalls) {
      if (call.function?.name !== 'web_fetch') continue

      let url = ''
      try { url = JSON.parse(call.function.arguments || '{}').url || '' } catch {}

      const fetchResult = await fetchUrl(url, config.allowedBaseUrls, config.maxFetchTokens)
      toolResultMsgs.push({
        role: 'tool',
        tool_call_id: call.id,
        content: fetchResult.ok
          ? `Source: ${fetchResult.url}\n\n${fetchResult.content}`
          : `Could not fetch ${url}: ${fetchResult.error}`,
      })
    }

    // Append assistant message + tool results, then loop
    request.messages = [...request.messages, assistantMsg, ...toolResultMsgs]
  }

  // Loop limit reached — ask model to respond without more tool calls
  request.tool_choice = 'none'
  const finalResult = await callLlama(llamaPort, request)
  if (finalResult.ok) {
    if (clientWantsStream) {
      sendAsSse(res, finalResult.data)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(finalResult.data))
    }
  } else {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Tool loop exhausted', type: 'gateway_error' } }))
  }
}

// ---------------------------------------------------------------------------
// Passthrough proxy for non-tool paths
// ---------------------------------------------------------------------------

function passthrough(req, res, llamaPort) {
  const options = {
    hostname: '127.0.0.1',
    port: llamaPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${llamaPort}` },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
    })
    proxyRes.pipe(res)
  })

  req.pipe(proxyReq)
  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Gateway error: ${err.message}`)
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGateway(llamaPort, config) {
  stopGateway()
  activeConfig = config
  const gatewayPort = llamaPort + 1

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        })
        res.end()
        return
      }

      // Intercept completions only when tools are actually configured
      const hasTools = activeConfig?.allowedBaseUrls?.length > 0
      if (hasTools && req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        try {
          await handleCompletion(req, res, llamaPort, activeConfig)
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: err.message, type: 'internal_error' } }))
          }
        }
        return
      }

      // Everything else → passthrough
      passthrough(req, res, llamaPort)
    })

    server.listen(gatewayPort, '0.0.0.0', () => {
      gatewayServer = server
      resolve(gatewayPort)
    })
    server.on('error', err => {
      // If port is taken (e.g. another app on llamaPort+1), log and fall back
      console.warn(`Tool gateway could not start on port ${gatewayPort}: ${err.message}`)
      gatewayServer = null
      reject(err)
    })
  })
}

export function stopGateway() {
  if (gatewayServer) { gatewayServer.close(); gatewayServer = null }
  activeConfig = null
}

// Call this when the user switches profiles or toggles tools without restarting
// the server. The next request picks up the new config.
export function updateGatewayConfig(config) {
  activeConfig = config
}

export function getGatewayPort(llamaPort) {
  return gatewayServer ? llamaPort + 1 : null
}
