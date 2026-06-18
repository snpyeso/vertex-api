# Gemini OpenAI Proxy

This project exposes Vertex AI Gemini as an OpenAI Chat Completions compatible local proxy.

## Features

- SQLite-backed Vertex AI configuration. No YAML file is required.
- Multiple local config profiles. Enable, add, and delete profiles from the left rail.
- Admin login for the management UI. Default account: `admin` / `123456`.
- 30-day login session.
- API tokens can be bound to specific config profiles. If no API tokens exist, API access is open.
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

Install dependencies after cloning:

```bash
npm install
```

Start on Linux/macOS:

```bash
HOST=0.0.0.0 PORT=3100 npm run dev
```

Start on Windows PowerShell:

```powershell
npm.cmd install
$env:HOST='0.0.0.0'
$env:PORT='3100'
npm.cmd run dev
```

For OpenAI streaming, add `"stream": true` to the request body.

Open `http://localhost:3100`. The default profile is prefilled from the old `api.yaml` values.

Local data is stored in `data/app.db`.

## Vertex Rate Limits

Vertex AI can return `429 Resource has been exhausted` when requests are too frequent or quota is low. The proxy retries transient Vertex errors automatically. Optional tuning:

```bash
VERTEX_RETRY_ATTEMPTS=3
VERTEX_RETRY_DELAYS_MS=1000,5000,15000
```

If 429 errors continue after retries, reduce concurrency/request rate, use another model or region, or increase quota in Google Cloud.

## Login

Default management account:

```text
admin
123456
```

Use the top-right `Password` button to change the password. Changing the password clears sessions and requires login again.

## Minimal Profile Fields

- Profile name
- Project ID
- Location, for example `global` or `us-central1`
- Client email
- Private key
- Model list, one per line

Proxy handling and request preferences are automatic. They are not page-level settings.

## API Tokens

Open `Tokens` from the left rail. Each token row has:

- Token value
- Config profile selector

When at least one token exists, API calls must include:

```http
Authorization: Bearer <token>
```

Any listed token is accepted. The selected config profile for that token is used for the request. If the token list is empty, API calls do not require authorization.

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
