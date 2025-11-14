# tasker-wrapped-services

Runtime-agnostic HTTP service implementations for distributed task execution with automatic suspend/resume.

## Quick Start

```bash
# Start all services with auto-discovery
npx tasker

# Start specific services on custom port
npx tasker --services deno-executor,keystore,gapi --port 3100

# Force runtime and enable debug logging
npx tasker --deno --debug
```

Services auto-discover and bind to sequential ports (3100, 3101, 3102...). Registry written to `.service-registry.json`.

## Overview

**Purpose**: HTTP-wrapped microservices enabling distributed task execution with FlowState integration for automatic pause/resume on external calls.

**Runtime Support**: Deno, Node.js, Bun (same code, zero modifications)

**Key Features**:
- Task execution in secure sandboxes with VM state serialization
- Automatic suspend/resume on external service calls
- Database-backed stack run processing with FIFO ordering
- Enterprise patterns: structured logging, health checks, retry logic, connection pooling
- Service registry with discovery, health tracking, and failover

## Architecture

```
services/                                    shared/core/
├── deno-executor/         [3100]           ├── base-service.ts        # Abstract service class
├── simple-stack-processor/ [3101]          ├── http-handler.ts        # Unified HTTP handling
├── task-executor/         [3102]           ├── service-registry.ts    # Service discovery
├── gapi/                  [3103]           ├── logging-service.ts     # Structured logging
├── keystore/              [3104]           ├── config-service.ts      # Configuration mgmt
├── supabase/              [3105]           ├── database-service.ts    # Connection pooling
├── openai/                [3106]           ├── http-client.ts         # FlowState-aware HTTP
├── websearch/             [3107]           ├── utils.ts               # Common utilities
└── admin-debug/           [3108]           └── cors.ts                # CORS headers
```

**Service Interface**: All services expose HTTP endpoints with standard request/response format:
```typescript
// Request
POST http://localhost:3100/
{ "chain": [...], "method": "...", "args": [...] }

// Response
{
  "success": boolean,
  "data": T,
  "error": string,
  "metadata": { "duration": number, "timestamp": string, "requestId": string }
}
```

## Services Reference

### Core Execution Services

#### deno-executor (Port 3100)
**Purpose**: Execute task code in secure sandbox with automatic suspend/resume

**Endpoints**:
- `POST /` - Execute task code with input parameters
- `POST /resume` - Resume suspended task with external call result
- `GET /health` - Health check

**Features**:
- Secure sandbox with isolated global scope and whitelisted builtins
- FlowState integration for pause/resume on `__callHostTool__` calls
- VM state serialization for resumable executions
- Creates child stack runs for suspended external calls
- MinimalServiceRegistry for service discovery

**Request Format**:
```typescript
{
  taskCode: string;           // Stringified task function
  input: Record<string, any>; // Task parameters
  vmState?: any;              // Resume state (for /resume)
  externalResult?: any;       // External call result (for /resume)
}
```

#### simple-stack-processor (Port 3101)
**Purpose**: Process pending service calls in FIFO order with database locking

**Endpoints**:
- `POST /` - Process single stack run or trigger next via `{ trigger: 'process-next' }`
- `GET /health` - Health check

**Features**:
- Pure HTTP chaining (no setInterval polling)
- Database-based locking for concurrent execution safety
- Respects serial execution order
- Handles chain suspension and resumption
- Automatic next-cycle trigger via fire-and-forget HTTP
- Stale lock cleanup and timeout handling

**Request Format**:
```typescript
{ stackRunId: number } | { trigger: 'process-next' }
```

**Processing Flow**:
1. Fetch oldest pending stack run
2. Acquire database lock
3. Execute service call
4. Update parent task with result
5. Trigger next processing cycle via HTTP

#### task-executor (Port 3102)
**Purpose**: Task submission, lifecycle management, and registry

**Endpoints**:
- `POST /execute` - Submit task for execution
- `GET /list` - List registered tasks
- `GET /schema` - Get task schema with JSDoc
- `GET /status` - Get task execution status
- `GET /logs` - Retrieve execution logs

**Structure**:
```
task-executor/
├── handlers/    # HTTP request handlers
├── registry/    # Task function storage
├── services/    # Business logic
├── types/       # TypeScript definitions
├── utils/       # Response formatting, JSDoc parsing
└── config/      # Supabase configuration
```

**Features**:
- Task registration and retrieval
- Schema generation from task definitions
- JSDoc parsing for documentation
- Status tracking across execution lifecycle

### External API Wrappers

#### gapi (Port 3103)
**Purpose**: Google Workspace APIs (Gmail, Admin Directory, etc.)

**Features**:
- Service account authentication with JWT generation
- Domain impersonation for admin APIs
- In-memory token caching with 5-minute refresh buffer
- Credential caching via keystore service
- Automatic token renewal before expiry

**Integration**: `serviceRegistry.call('keystore', ...)` for credential retrieval

#### keystore (Port 3104)
**Purpose**: Secure key-value credential storage

**Operations**: `getKey`, `setKey`, `listKeys`, `hasKey`, `listNamespaces`, `getServerTime`

**Features**:
- Namespace support (scopes: 'default', 'global')
- Supabase-backed persistence via wrappedsupabase proxy
- Health checks and performance logging
- Retry logic (3 attempts) with 30s timeout
- Extends `BaseService` for consistent error handling

#### supabase (Port 3105)
**Purpose**: Database query proxy with chain-style API

**Features**:
- Fluent query building: `{ property: 'from', args: ['table'] } → { property: 'select', args: [...] }`
- Direct Supabase client integration
- Chain processing for complex queries
- Health checks with database validation
- Extends `BaseService`

**Request Format**:
```typescript
{
  chain: [
    { property: 'from', args: ['table_name'] },
    { property: 'select', args: ['*'] },
    { property: 'eq', args: ['column', 'value'] }
  ]
}
```

#### openai (Port 3106)
**Purpose**: OpenAI API integration wrapper

**Supported Actions**:
- `chat.completions.create` - Chat completions
- `embeddings.create` - Text embeddings
- `models.list` - List available models
- `models.retrieve` - Get model details

**Features**:
- Cached API key retrieval from keystore
- Action-based request routing
- Chain-style to action conversion
- Direct HTTP forwarding to OpenAI endpoints

#### websearch (Port 3107)
**Purpose**: Web search integration wrapper

**Features**:
- Chain-style and method-based request handling
- Result parsing and filtering
- Snippet extraction
- Delegates to `websearch-service.ts`

#### admin-debug (Port 3108)
**Purpose**: Debugging and administrative tools

**Test Actions**:
- `test-direct-gapi` - Direct GAPI call testing
- `test-stack-processor` - Stack processor workflow validation

## Shared Infrastructure

### base-service.ts (16KB)
**Abstract Base Class**: All services extend `BaseService`

**Provides**:
- `ServiceError` custom error class with typed errors (10 error types)
- `@ServiceOperation` decorator for automatic logging
- Standardized error handling and normalization
- Health checks (config + database validation)
- Performance monitoring hooks
- Context-aware logging
- Graceful cleanup/shutdown

**Interfaces**: `IServiceConfig`, `IServiceContext`, `IServiceResponse`, `IHealthCheckResult`

### http-handler.ts (7KB)
**Abstract HTTP Handler**: Unified HTTP handling for all services

**Provides**:
- `BaseHttpHandler` abstract class
- CORS handling with preflight support
- Success/error response formatting
- Pagination support
- Query parameter parsing
- Validation helpers
- HTTP status codes enum

### service-registry.ts (28KB)
**Service Discovery & Communication**: Singleton registry for service-to-service calls

**Key Features**:
- Service registration and discovery
- Health status tracking per service
- Service caching with TTL
- Fallback service support
- Retry logic with exponential backoff
- FlowState integration for suspend/resume
- Request context propagation

**Methods**: `getInstance()`, `register()`, `call()`, `getService()`, `getHealth()`

### logging-service.ts (14KB)
**Structured Logging**: Comprehensive logging framework

**Provides**:
- Multi-level logging (debug < info < warn < error)
- JSON and text format support
- Request ID and correlation ID tracking
- Performance timing helpers (`perf` utility)
- Context-aware logging
- Sensitive data redaction
- Request context management

**Exports**: `logger`, `log`, `perf`, `context`

### config-service.ts (10KB)
**Configuration Management**: Centralized config with environment loading

**Config Types**:
- `DatabaseConfig` - Supabase credentials and connection
- `ServiceConfig` - Service metadata
- `GoogleApiConfig` - GAPI credentials and options

**Features**: Environment variable loading (dotenv), service registration, validation

### database-service.ts (20KB)
**Database Operations**: Unified database layer with connection pooling

**Provides**:
- Connection pooling
- Transaction support via `transaction(callback)`
- Retry logic with configurable delays
- Performance monitoring
- Query timeout handling
- Health checks

**Types**: `TaskRun`, `StackRun`, `TaskFunction`, `QueryOptions`, `DatabaseResult<T>`

### http-client.ts (12KB)
**HTTP Client**: FlowState-aware HTTP client with retry logic

**Provides**:
- Retry with exponential backoff
- Timeout handling
- FlowState context tracking for pause/resume
- Service call metadata
- Error handling and response parsing

**Interfaces**: `HttpClientConfig`, `RequestOptions`, `HttpResponse<T>`, `FlowStateContext`

### utils.ts (5KB)
**Common Utilities**: String manipulation, validation, response helpers

**Exports**:
- String: `simpleStringify()`, `sanitizeString()`
- Validation: `isValidUuid()`, `isValidEmail()`, `validateRequired()`
- Correlation ID generation
- Response helpers: `createApiResponse()`, `createErrorResponse()`
- Circular dependency handling for JSON serialization

## Execution Flow

### Task Execution with Suspend/Resume

```
1. Task Submission
   └─> task-executor receives task with parameters
       └─> Creates TaskRun in database
           └─> Creates StackRun and calls deno-executor

2. Task Execution
   └─> deno-executor loads task code into SecureSandbox
       └─> Executes task with isolated global scope
           └─> Task calls __callHostTool__('serviceName', {...})

3. Suspension
   └─> FlowState detects external call
       └─> VM state serialized
           └─> Child StackRun created for service call
               └─> Execution paused, returns suspension data

4. Service Call Processing
   └─> simple-stack-processor fetches pending StackRun
       └─> Acquires database lock
           └─> Calls target service (gapi, openai, etc.)
               └─> Service executes and returns result

5. Resumption
   └─> Stack processor calls deno-executor /resume
       └─> VM state restored with external result
           └─> Task continues from suspension point
               └─> Task completes or suspends again

6. Completion
   └─> Final result written to TaskRun
       └─> Parent tasks notified via HTTP chaining
```

### Service-to-Service Communication

**Pattern**: HTTP POST with JSON payload
```typescript
// Call from any service
const result = await serviceRegistry.call('keystore', {
  method: 'getKey',
  args: ['api_key_name', 'namespace']
});

// Translates to HTTP:
POST http://localhost:3104/
{
  "method": "getKey",
  "args": ["api_key_name", "namespace"]
}
```

**Response Standard**:
```typescript
{
  success: true,
  data: { ... },
  metadata: {
    duration: 123,
    timestamp: "2025-11-14T...",
    requestId: "uuid"
  }
}
```

## Development Guide

### Adding New Services

1. **Create Service Directory**:
```bash
mkdir services/my-service
```

2. **Implement Service** (`services/my-service/index.ts`):
```typescript
import { BaseService } from '../../shared/core/base-service.ts';

export class MyService extends BaseService {
  constructor() {
    super({ name: 'my-service', version: '1.0.0' });
  }

  async myMethod(param: string): Promise<any> {
    return { result: param };
  }
}

// HTTP handler
export async function handler(req: Request): Promise<Response> {
  const service = new MyService();
  const body = await req.json();
  const result = await service.myMethod(body.param);
  return new Response(JSON.stringify({ success: true, data: result }));
}

// Auto-start when run directly
if (import.meta.main) {
  const port = parseInt(Deno.env.get('PORT') || '3000');
  Deno.serve({ port }, handler);
}
```

3. **CLI Auto-Discovery**: Service automatically discovered and started by `npx tasker`

### Debugging

**Enable Debug Logging**:
```bash
npx tasker --debug
DEBUG=true npx tasker
```

**Test Service Directly**:
```bash
curl -X POST http://localhost:3100/health
curl -X POST http://localhost:3100/ -H "Content-Type: application/json" -d '{"method":"test"}'
```

**Use admin-debug Service**:
```bash
# Test GAPI integration
curl -X POST http://localhost:3108/ -d '{"action":"test-direct-gapi"}'

# Test stack processor
curl -X POST http://localhost:3108/ -d '{"action":"test-stack-processor"}'
```

### Service Templates

CLI generates boilerplate services if no services found:
- `hello-world` - Basic service example
- `echo-service` - Echo request body
- `api-gateway` - Proxy/gateway pattern

## Deployment

### Local Development
```bash
cd packages/tasker-wrapped-services
npx tasker --port 3100 --debug
```

### Single Service (Development)
```bash
# With hot reload
deno run --watch --allow-all services/deno-executor/index.ts

# Specific port
PORT=3100 deno run --allow-all services/deno-executor/index.ts
```

### Production (All Runtimes)
```bash
# Deno
deno run --allow-all services/deno-executor/index.ts

# Node.js (requires Deno compatibility layer)
node --input-type=module services/deno-executor/index.ts

# Bun
bun services/deno-executor/index.ts
```

### Docker/Kubernetes

**Single Service Container**:
```dockerfile
FROM denoland/deno:latest
WORKDIR /app
COPY services/deno-executor ./services/deno-executor
COPY shared ./shared
ENV PORT=3100
CMD ["deno", "run", "--allow-all", "services/deno-executor/index.ts"]
```

**Multi-Service Deployment**:
```bash
# Each service in separate container
# Service discovery via registry file or service mesh
# Ports configured via environment variables
```

### Supabase Edge Functions
```bash
# tasker-adaptor-supabase imports this code
# Wraps services as Supabase edge functions
# Zero changes to service implementation
```

## Configuration

### Environment Variables

**Required for All Services**:
```bash
PORT=3100                    # HTTP port (overridden by CLI)
SERVICE_NAME=my-service      # Service identifier
DEBUG=true                   # Enable debug logging
DENO_ENV=production          # Environment (development|staging|production)
```

**Database (Supabase)**:
```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=xxx
SUPABASE_SERVICE_ROLE_KEY=xxx
```

**Google APIs (gapi)**:
```bash
GAPI_KEY=xxx                 # Google API key
GAPI_ADMIN_EMAIL=xxx         # Admin email for domain impersonation
GAPI_SERVICE_ACCOUNT_JSON=xxx # Service account credentials
```

**OpenAI (openai)**:
```bash
OPENAI_API_KEY=sk-xxx
```

**Web Search (websearch)**:
```bash
WEBSEARCH_API_KEY=xxx
WEBSEARCH_ENGINE_ID=xxx
```

### CLI Options

```bash
npx tasker [options]

Options:
  --port <number>           Base port (default: 3100)
  --services <list>         Comma-separated service names
  --deno                    Force Deno runtime
  --node                    Force Node.js runtime
  --bun                     Force Bun runtime
  --debug                   Enable debug logging
  --help                    Show help
```

### Service Registry

**Location**: `.service-registry.json` (auto-generated)

**Format**:
```json
{
  "timestamp": "2025-11-14T...",
  "services": [
    {
      "name": "deno-executor",
      "port": 3100,
      "url": "http://localhost:3100"
    },
    {
      "name": "simple-stack-processor",
      "port": 3101,
      "url": "http://localhost:3101"
    }
  ]
}
```

**Usage**: Services read registry for peer discovery and HTTP communication

## Architectural Patterns

**Design Patterns Applied**:
- **Singleton**: Config, Logger, Database, HttpClient, ServiceRegistry
- **Abstract Base Class**: BaseService, BaseHttpHandler
- **Decorator**: @ServiceOperation for automatic logging
- **Factory**: Service creation and initialization
- **Strategy**: Multiple request formats (chain vs method-based)
- **Chain of Responsibility**: Service registry delegates to appropriate service
- **Secure Sandbox**: Task execution in isolated environment with whitelisted globals

**Communication Patterns**:
- **HTTP Chaining**: Services communicate exclusively via HTTP (no direct imports)
- **FlowState Integration**: Automatic pause/resume on external calls
- **Fire-and-Forget Async**: Stack processor uses setTimeout for non-blocking triggers
- **Database Locking**: Concurrent execution safety with database-backed locks

**Error Handling**:
- Typed error enums (10 error types via `ServiceErrorType`)
- Consistent error response format across all services
- Error normalization in `BaseService`
- Request context in error logs

**Observability**:
- Structured logging with request ID tracking
- Performance monitoring via `perf` utility
- Health check endpoints on all services
- Correlation ID propagation across service calls

## Key Principles

- ✅ **Runtime-Agnostic**: Same code runs on Deno, Node.js, Bun
- ✅ **Discovery-Driven**: Services auto-discovered by CLI
- ✅ **Sequential Ports**: Predictable port assignment (3100+)
- ✅ **HTTP Chaining**: All communication via HTTP (no direct imports)
- ✅ **FlowState Integration**: Automatic suspend/resume
- ✅ **No Supabase Coupling**: Can run anywhere
- ✅ **Production-Ready**: Enterprise patterns, no mocks
- ✅ **Secure by Default**: Sandboxed execution, credential storage
- ✅ **Observable**: Structured logging, health checks, metrics

## Related Packages

| Package | Purpose |
|---------|---------|
| **tasker-sequential** | Core task execution engine with FlowState |
| **tasker-adaptor** | Storage adaptor interface |
| **tasker-adaptor-supabase** | Supabase edge functions (imports this code) |
| **tasker-adaptor-sqlite** | SQLite storage backend |
| **tasker-http-utils** | HTTP utilities and helpers |
| **tasker-logging** | Logging framework |
| **tasker-validators** | Input validation |
| **tasker-utils** | Common utilities |

## Version

**Current**: 1.1.0
**Features**: Boilerplate service generation, consolidated logging, improved CLI discovery
