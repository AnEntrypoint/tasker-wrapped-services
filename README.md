# tasker-wrapped-services

Runtime-agnostic HTTP service implementations for tasker-sequential. Run on Deno, Node.js, or Bun.

## Overview

This package contains HTTP service implementations that wrap external APIs and core task execution:

- **deno-executor** - Task execution runtime with automatic suspend/resume
- **simple-stack-processor** - Processes pending service calls in FIFO order
- **task-executor** - Task submission and lifecycle management
- **gapi** - Google Workspace APIs (Gmail, Admin, etc.)
- **keystore** - Secure credential storage
- **supabase** - Database operation proxy
- **openai** - OpenAI API integration
- **websearch** - Web search integration
- **admin-debug** - Debugging and administrative tools

## Quick Start

### Installation

```bash
npm install
# or
bun install
```

### Start All Services

```bash
npm start
# Discovers and starts all available services automatically
```

### Start Specific Services

```bash
npm start -- --services deno-executor,gapi,keystore
```

### Custom Port

```bash
npm start -- --port 3100
# Services: 3100, 3101, 3102, ...
```

### Force Runtime

```bash
npm start -- --deno
npm start -- --node
npm start -- --bun
```

## Architecture

Each service implements a standard HTTP handler interface:

```typescript
export async function handler(req: Request): Promise<Response> {
  // Handle incoming request
  // Call other services via HTTP
  // Return result
}
```

Services communicate via HTTP (no direct imports):
```
task-executor → deno-executor → gapi/keystore/supabase
     ↓              ↓
   HTTP         HTTP chains
```

## Service Discovery

The CLI automatically:
1. Scans `services/` directory
2. Finds folders with `index.ts` or `index.js`
3. Assigns sequential ports starting from base port
4. Creates `.service-registry.json` with service endpoints

Registry example:
```json
{
  "timestamp": "2025-10-27T15:00:00Z",
  "services": [
    {"name": "deno-executor", "port": 3100, "url": "http://localhost:3100"},
    {"name": "gapi", "port": 3101, "url": "http://localhost:3101"}
  ]
}
```

## Adding a New Service

1. Create `services/{name}/` directory
2. Add `index.ts` with HTTP handler:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

export async function handler(req: Request): Promise<Response> {
  return new Response(JSON.stringify({success: true}), {
    headers: {"Content-Type": "application/json"}
  });
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "3000");
  serve(handler, { port });
}
```

3. CLI automatically discovers and starts it

## Deployment

### Local Development

```bash
npm start
```

### Supabase Edge Functions

Services can be wrapped as Supabase edge functions:

```bash
# Copy service code to Supabase functions directory
cp -r services/deno-executor supabase/functions/
supabase functions deploy deno-executor
```

### Docker

```dockerfile
FROM denoland/deno:latest
COPY . /app
WORKDIR /app
CMD ["deno", "run", "--allow-all", "services/deno-executor/index.ts"]
```

### Kubernetes

Each service as separate deployment with environment-based port assignment.

## Configuration

Services respect standard environment variables:

```bash
PORT=3100                    # HTTP port (overridden by CLI)
DEBUG=true                   # Enable debug logging
SERVICE_NAME=deno-executor   # Service identifier
SUPABASE_URL=...            # Supabase project URL
OPENAI_API_KEY=...          # OpenAI API key
GAPI_KEY=...                # Google API credentials
```

## Development

### Hot Reload with Deno

```bash
deno run --allow-all --allow-env --watch services/deno-executor/index.ts
```

### Debug Mode

```bash
npm start -- --debug
```

### Test Individual Service

```bash
curl http://localhost:3100/health
```

## Service Registry API

All services expose:

- **GET /health** - Health check
- **POST /call** - Service call (varies by service)

## Integration with tasker-sequential

Services are used by tasker-sequential core:

1. Task submitted to task-executor
2. task-executor calls deno-executor to run task code
3. deno-executor calls wrapped services via HTTP
4. Results returned and task continues

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Detailed architecture and configuration
- [tasker-sequential docs](https://github.com/AnEntrypoint/tasker-sequential) - Core task execution
- [tasker-ecosystem](https://github.com/AnEntrypoint/sequential-ecosystem) - Main ecosystem

## Requirements

- **Deno** 1.40+ (for Deno runtime)
- **Node.js** 18+ (for Node runtime)
- **Bun** 1.0+ (for Bun runtime)

## License

MIT

## Contributing

Issues and PRs welcome on GitHub: https://github.com/AnEntrypoint/tasker-wrapped-services
