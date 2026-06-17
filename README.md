# Gemini OpenAI Proxy

This project exposes Vertex AI Gemini as an OpenAI Chat Completions compatible local proxy.

## Features

- Browser-based Vertex AI configuration. No YAML file is required.
- Multiple local config profiles. Enable, add, and delete profiles from the left rail.
- `GET /health`
- `GET /config`
- `POST /config`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- Multi-turn `messages`
- OpenAI `tools` / `tool_calls` mapping to Gemini function calling
- Anthropic `tools` / `tool_use` / `tool_result` mapping to Gemini function calling
- `temperature`, `top_p`, `max_tokens`, `stop`

Streaming is supported for both OpenAI and Anthropic compatible endpoints with `stream: true`.

## Start

```powershell
npm.cmd install
$env:PORT='3100'
npm.cmd run dev
```

For OpenAI streaming, add `"stream": true` to the request body.

Open `http://localhost:3100`. The default profile is prefilled from the old `api.yaml` values.

## Minimal Profile Fields

- Profile name
- Project ID
- Location, for example `global` or `us-central1`
- Client email
- Private key
- Model list, one per line

Proxy handling and request preferences are automatic. They are not page-level settings.

## Base URLs

- OpenAI SDK base URL: `http://localhost:3100/v1`
- Anthropic SDK base URL: `http://localhost:3100`

## OpenAI-compatible request

After enabling a profile in the web UI:

```bash
curl http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      {"role": "user", "content": "Reply exactly: hello"}
    ]
  }'
```

For Anthropic streaming, add `"stream": true` to the request body.

## Anthropic-compatible request

After enabling a profile in the web UI:

```bash
curl http://localhost:3100/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "gemini-2.5-pro",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Reply exactly: hello"}
    ]
  }'
```
