# Logging Service Migration Guide

This guide helps migrate from the existing mixed logging approaches to the unified logging service.

## Overview

The new logging service provides:
- Structured logging with different levels (debug, info, warn, error)
- JSON and text format support
- Performance logging and request tracing
- Sensitive data redaction
- Context-aware logging
- Integration with ConfigService

## Quick Migration

### Replace existing imports

**Before:**
```typescript
import { hostLog } from '../_shared/utils.ts';
```

**After:**
```typescript
import { logger, log, performance, context } from '../_shared/logging-service.ts';
// Or keep using the old import (it's redirected):
import { hostLog } from '../_shared/utils.ts';
```

### Basic logging patterns

**Old way (hostLog):**
```typescript
hostLog('my-service', 'info', 'Processing request', { userId: 123 });
hostLog('my-service', 'error', 'Failed to process', error);
```

**New way (recommended):**
```typescript
// Simple logging
log.info('Processing request', { userId: 123 });
log.error('Failed to process', error);

// With context
context.set({ service: 'my-service', requestId: 'req-123' });
log.info('Processing request', { userId: 123 });
```

### Performance logging

**Old way (manual):**
```typescript
const start = Date.now();
// ... do something
const duration = Date.now() - start;
console.log(`Operation took ${duration}ms`);
```

**New way (automatic):**
```typescript
// Method 1: Timer
const timerId = performance.start('database-query');
// ... do database work
performance.end(timerId);

// Method 2: Measure async function
const result = await performance.measureAsync('database-query', async () => {
  return await db.query('SELECT * FROM users');
});

// Method 3: Measure sync function
const result = performance.measureSync('data-processing', () => {
  return processData(rawData);
});
```

### Context-aware logging

**New way (request tracing):**
```typescript
// Set context at the start of a request
context.set({
  requestId: crypto.randomUUID(),
  userId: req.headers['x-user-id'],
  service: 'wrappedgapi'
});

// All subsequent logs will include this context
log.info('Starting API call');
log.debug('Making request to Google API', { endpoint: '/admin/directory/v1/domains' });

// Clear context when done
context.clear();
```

### Child loggers for specific contexts

**New way (scoped logging):**
```typescript
// Create a child logger with specific context
const userLogger = logger.child({
  userId: 'user-123',
  service: 'auth-service'
});

// All logs from this logger will include the context
userLogger.info('User logged in');
userLogger.warn('Password will expire soon');
```

## Configuration

The logging service uses ConfigService for configuration:

### Environment Variables

```bash
# Log level: debug, info, warn, error
LOG_LEVEL=info

# Log format: json, text
LOG_FORMAT=text

# Enable console output
LOG_CONSOLE=true
```

### Configuration in Code

```typescript
import { logger } from '../_shared/logging-service.ts';

// Update configuration at runtime
logger.updateConfig({
  level: 'debug',
  format: 'json',
  enablePerformance: true
});

// Get current configuration
const config = logger.getConfig();
```

## Migration Examples

### Example 1: Simple Service Function

**Before:**
```typescript
export async function processRequest(data: any) {
  console.log(`[${new Date().toISOString()}] [INFO] [SERVICE] Processing request`);

  try {
    const result = await processData(data);
    console.log(`[${new Date().toISOString()}] [INFO] [SERVICE] Request processed successfully`);
    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [ERROR] [SERVICE] Processing failed: ${error.message}`);
    throw error;
  }
}
```

**After:**
```typescript
import { log, performance } from '../_shared/logging-service.ts';

export async function processRequest(data: any) {
  log.info('Processing request');

  try {
    const result = await performance.measureAsync('process-request', () => processData(data));
    log.info('Request processed successfully');
    return result;
  } catch (error) {
    log.error('Processing failed', error);
    throw error;
  }
}
```

### Example 2: API Wrapper

**Before:**
```typescript
function log(level: string, message: string) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] [WRAPPEDGAPI] ${message}`);
}

export async function callGoogleAPI(endpoint: string, params: any) {
  log('info', `Calling Google API: ${endpoint}`);
  const start = Date.now();

  try {
    const response = await fetch(endpoint, params);
    const duration = Date.now() - start;
    log('info', `API call completed in ${duration}ms`);
    return response;
  } catch (error) {
    log('error', `API call failed: ${error.message}`);
    throw error;
  }
}
```

**After:**
```typescript
import { logger, performance, context } from '../_shared/logging-service.ts';

// Set service context once
const serviceLogger = logger.child({ service: 'wrappedgapi' });

export async function callGoogleAPI(endpoint: string, params: any) {
  serviceLogger.info('Calling Google API', { endpoint });

  return await performance.measureAsync('google-api-call', async () => {
    try {
      const response = await fetch(endpoint, params);
      serviceLogger.info('API call completed');
      return response;
    } catch (error) {
      serviceLogger.error('API call failed', error, { endpoint });
      throw error;
    }
  });
}
```

### Example 3: Database Operations

**Before:**
```typescript
export async function createUser(userData: any) {
  console.log(`[${new Date().toISOString()}] [INFO] [DB] Creating user: ${userData.email}`);

  try {
    const { data, error } = await supabase
      .from('users')
      .insert(userData)
      .select()
      .single();

    if (error) {
      console.error(`[${new Date().toISOString()}] [ERROR] [DB] User creation failed: ${error.message}`);
      throw error;
    }

    console.log(`[${new Date().toISOString()}] [INFO] [DB] User created successfully: ${data.id}`);
    return data;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [ERROR] [DB] Unexpected error: ${error.message}`);
    throw error;
  }
}
```

**After:**
```typescript
import { log, performance, context } from '../_shared/logging-service.ts';

const dbLogger = logger.child({ service: 'database' });

export async function createUser(userData: any) {
  const redactedUserData = { ...userData, password: '[REDACTED]' };
  dbLogger.info('Creating user', { email: userData.email });

  return await performance.measureAsync('create-user', async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .insert(userData)
        .select()
        .single();

      if (error) {
        dbLogger.error('User creation failed', error, redactedUserData);
        throw error;
      }

      dbLogger.info('User created successfully', { userId: data.id });
      return data;
    } catch (error) {
      dbLogger.error('Unexpected error during user creation', error);
      throw error;
    }
  });
}
```

## Backward Compatibility

The new logging service maintains full backward compatibility:

### Existing `hostLog` calls continue to work
```typescript
import { hostLog } from '../_shared/utils.ts';

// This still works exactly as before
hostLog('my-service', 'info', 'Message', { data: 'value' });
```

### Simple console.log replacement
```typescript
// Before
console.log('Debug message');
console.error('Error message', error);

// After (recommended)
log.debug('Debug message');
log.error('Error message', error);
```

## Advanced Features

### Batch Logging
```typescript
// Log multiple entries efficiently
log.batch([
  { level: 'info', message: 'Starting batch processing' },
  { level: 'debug', message: 'Processing item 1' },
  { level: 'debug', message: 'Processing item 2' },
  { level: 'info', message: 'Batch processing completed' }
]);
```

### Timer Management
```typescript
// Start multiple timers
const timer1 = performance.start('operation-1');
const timer2 = performance.start('operation-2');

// End them individually
performance.end(timer1);
performance.end(timer2);

// Check active timers
console.log('Active timers:', performance.getActiveTimers());

// Clear all timers
performance.clearAllTimers();
```

### Configuration per Environment
```typescript
// Development - verbose logging
if (config.isDevelopment) {
  logger.updateConfig({
    level: 'debug',
    format: 'text',
    enablePerformance: true
  });
}

// Production - optimized logging
if (config.isProduction) {
  logger.updateConfig({
    level: 'warn',
    format: 'json',
    enablePerformance: false
  });
}
```

## Troubleshooting

### Common Issues

1. **Logs not appearing**: Check log level configuration
2. **Missing context**: Ensure context.set() is called before logging
3. **Performance overhead**: Disable performance logging in production
4. **Sensitive data leakage**: Configure redaction fields properly

### Debug Configuration

```typescript
// Check current configuration
console.log('Logging config:', logger.getConfig());

// Test logging
log.debug('Debug message test');
log.info('Info message test');
log.warn('Warning message test');
log.error('Error message test', new Error('Test error'));
```

## Best Practices

1. **Use structured logging**: Always provide context and metadata
2. **Set appropriate log levels**: Use debug for development, info/warn for production
3. **Add request tracing**: Use context.set() for request-scoped logging
4. **Measure performance**: Use performance logging for critical operations
5. **Handle sensitive data**: Let the service redact sensitive information automatically
6. **Use child loggers**: Create scoped loggers for different services or components

## Migration Checklist

- [ ] Replace `hostLog` imports with new logging service imports
- [ ] Update basic logging calls to use structured format
- [ ] Add performance logging for critical operations
- [ ] Implement request tracing with context
- [ ] Configure appropriate log levels for each environment
- [ ] Test sensitive data redaction
- [ ] Verify backward compatibility with existing code
- [ ] Update documentation for your specific service

## Support

For questions or issues with the logging service, refer to the source code in `/supabase/functions/_shared/logging-service.ts` or check the ConfigService integration in `/supabase/functions/_shared/config-service.ts`.