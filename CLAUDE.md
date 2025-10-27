# tasker-wrapped-services

Runtime-agnostic wrapped service implementations for tasker-sequential.

## Overview

This package contains HTTP service implementations that can run on **Deno, Node.js, or Bun**. It includes:

- **Core Services**: Task execution runtime and stack processor
- **External API Wrappers**: Google APIs, credential storage, database operations, OpenAI, web search
- **Service Discovery & CLI**: Automatically discovers and starts available services

## Architecture

```
services/
├── deno-executor/          # Task execution runtime with suspend/resume
├── simple-stack-processor/  # Processes pending stack runs (service calls)
├── task-executor/          # Task submission and lifecycle management
├── gapi/                   # Google Workspace APIs wrapper
├── keystore/               # Credential storage wrapper
├── supabase/               # Supabase database operations wrapper
├── openai/                 # OpenAI API wrapper
├── websearch/              # Web search integration wrapper
└── admin-debug/            # Debugging and administrative tools

shared/
└── core/                   # Shared utilities, logging, HTTP handlers
```

## Service Structure

Each service follows a standard structure:

```
services/{service-name}/
├── index.ts                # Service entry point
├── deno.json               # Deno configuration
├── deno.lock               # Deno lock file
└── [service-specific code]
```

### Service Interface

All services implement a standard HTTP interface:
- **Port**: Assigned dynamically by CLI (default base: 3100)
- **Handler**: Standard HTTP request/response format
- **Runtime**: Can run on Deno, Node.js, or Bun with same code

Example service structure:
```typescript
// services/{name}/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

export async function handler(req: Request): Promise<Response> {
  // Service implementation
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "3000");
  serve(handler, { port });
}
```

## Core Services

### deno-executor
- **Purpose**: Executes task code with automatic suspend/resume
- **Input**: Task code and execution context
- **Output**: Task results or suspension data
- **External calls**: Via `__callHostTool__` to other services

### simple-stack-processor
- **Purpose**: Processes pending service calls in FIFO order
- **Input**: Stack run ID and execution context
- **Output**: Service call results to parent tasks
- **Chain**: HTTP chaining to resume parent tasks

### task-executor
- **Purpose**: Task submission and lifecycle management
- **Input**: Task identifier and input parameters
- **Output**: Task execution results
- **Registry**: Task function storage and retrieval

## External API Wrappers

### gapi (Google APIs)
- Google Workspace APIs (Gmail, Admin Directory, etc.)
- Service account authentication
- Domain impersonation for admin APIs
- Credential caching via keystore

### keystore
- Credential storage and retrieval
- Supports: API keys, tokens, email addresses
- Encrypted storage (backend-dependent)
- Used by all other wrapped services

### supabase
- Database query proxy
- CRUD operations on task data
- Query chaining support
- Transaction handling

### openai
- OpenAI API integration
- Model selection and parameter tuning
- Streaming response support
- Token counting

### websearch
- Web search API integration
- Result parsing and filtering
- Snippet extraction

## CLI Usage

### Start all discovered services
```bash
npx tasker
```

### Start specific services
```bash
npx tasker --services gapi,keystore,task-executor
```

### Specify base port (services get sequential ports)
```bash
npx tasker --port 3100  # Services: 3100, 3101, 3102, ...
```

### Force runtime
```bash
npx tasker --deno
npx tasker --node
npx tasker --bun
```

### Debug mode
```bash
npx tasker --debug
```

## Service Discovery

The CLI automatically:
1. Scans `services/` directory
2. Identifies folders with `index.ts` or `index.js`
3. Assigns sequential ports starting from base port
4. Outputs service registry to `.service-registry.json`
5. Starts HTTP listeners for each service

Registry file example:
```json
{
  "timestamp": "2025-10-27T14:50:00.000Z",
  "services": [
    {"name": "deno-executor", "port": 3100, "url": "http://localhost:3100"},
    {"name": "simple-stack-processor", "port": 3101, "url": "http://localhost:3101"},
    {"name": "gapi", "port": 3102, "url": "http://localhost:3102"}
  ]
}
```

## Running Services

### Development (hot reload)
```bash
deno run --allow-all --allow-env services/deno-executor/index.ts --port 3100
```

### Production (all runtimes)
```bash
# Deno
deno run --allow-all services/deno-executor/index.ts

# Node.js
node --input-type=module services/deno-executor/index.ts

# Bun
bun services/deno-executor/index.ts
```

## Adding New Services

1. Create service directory: `services/{name}/`
2. Create entry point: `index.ts` with `handler` function
3. Implement HTTP service interface
4. CLI automatically discovers and starts it
5. Registry file updated with new service endpoint

## Deployment Scenarios

### Local Development
```bash
cd packages/tasker-wrapped-services
npx tasker --port 3100
```

### Supabase Edge Functions
```bash
# tasker-adaptor-supabase imports this code
# Wraps services as Supabase edge functions
# No changes needed to service implementation
```

### Docker/Kubernetes
```bash
# Each service runs in separate container
# Ports configured via environment variables
# Service discovery via registry file or mesh
```

## Environment Variables

Services respect these standard variables:
- `PORT` - HTTP port (overridden by CLI)
- `DEBUG` - Enable debug logging
- `SERVICE_NAME` - Service identifier
- Service-specific variables (SUPABASE_URL, OPENAI_KEY, etc.)

## Key Principles

- **Runtime-agnostic**: Same code runs on Deno, Node.js, Bun
- **Discovery-driven**: Services auto-discovered by CLI
- **Sequential ports**: Predictable port assignment
- **HTTP chaining**: Services call each other via HTTP
- **No Supabase coupling**: Can run anywhere
- **Production-ready**: No mocks or simulations

## Related Packages

- **tasker-sequential** - Core task execution engine
- **tasker-adaptor** - Storage adaptor interface
- **tasker-adaptor-supabase** - Imports this code for Supabase edge functions
- **tasker-adaptor-sqlite** - SQLite storage backend
