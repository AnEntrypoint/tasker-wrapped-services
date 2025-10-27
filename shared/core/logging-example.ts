/**
 * Logging Service Usage Examples
 *
 * This file demonstrates how to use the unified logging service
 * in various scenarios that are common in the codebase.
 */

import { logger, log, performance, context, hostLog } from './logging-service.ts';

// Example 1: Basic logging with different levels
export async function basicLoggingExample() {
  console.log('=== Basic Logging Example ===');

  // Simple logging
  log.debug('This is a debug message');
  log.info('This is an info message');
  log.warn('This is a warning message');
  log.error('This is an error message');

  // With metadata
  log.info('Processing user request', {
    userId: 'user-123',
    action: 'create-task',
    timestamp: new Date().toISOString()
  });

  // With error object
  try {
    throw new Error('Something went wrong');
  } catch (error) {
    log.error('An error occurred', error, {
      userId: 'user-123',
      operation: 'task-creation'
    });
  }
}

// Example 2: Context-aware logging for request tracing
export async function requestTracingExample() {
  console.log('\n=== Request Tracing Example ===');

  const requestId = crypto.randomUUID();
  const userId = 'user-456';

  // Set context for the entire request
  context.set({
    requestId,
    userId,
    service: 'task-service',
    correlationId: `batch-${Date.now()}`
  });

  log.info('Request started', { endpoint: '/tasks/create' });

  try {
    // Simulate different operations within the same request
    await performance.measureAsync('validate-input', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      log.debug('Input validation completed');
    });

    await performance.measureAsync('database-operation', async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      log.info('Database operation completed');
    });

    await performance.measureAsync('send-notification', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      log.info('Notification sent');
    });

    log.info('Request completed successfully');
  } catch (error) {
    log.error('Request failed', error);
  } finally {
    // Clear context when request is done
    context.clear();
  }
}

// Example 3: Service-specific logging with child loggers
export async function serviceLoggingExample() {
  console.log('\n=== Service-Specific Logging Example ===');

  // Create child loggers for different services
  const gmailLogger = logger.child({
    service: 'wrappedgapi',
    version: '1.0.0'
  });

  const keystoreLogger = logger.child({
    service: 'wrappedkeystore',
    environment: Deno.env.get('DENO_ENV') || 'development'
  });

  // Use service-specific loggers
  gmailLogger.info('Initializing Gmail API client', {
    adminEmail: Deno.env.get('GAPI_ADMIN_EMAIL') || 'admin@example.com'
  });

  keystoreLogger.debug('Fetching credentials from keystore', {
    keyType: 'google-api-key'
  });

  // Simulate API calls with performance tracking
  await performance.measureAsync('gmail-api-call', async () => {
    gmailLogger.info('Making Gmail API call', {
      endpoint: '/gmail/v1/users/messages/list',
      maxResults: 100
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    gmailLogger.info('Gmail API call completed', {
      messageCount: 25,
      hasMore: true
    });
  });
}

// Example 4: Batch logging for efficiency
export async function batchLoggingExample() {
  console.log('\n=== Batch Logging Example ===');

  // Collect logs and send them in batch
  const batchLogs = [
    { level: 'info' as const, message: 'Starting batch processing', metadata: { batchSize: 100 } },
    { level: 'debug' as const, message: 'Processing items 1-10' },
    { level: 'debug' as const, message: 'Processing items 11-20' },
    { level: 'warn' as const, message: 'Found duplicate item', metadata: { itemId: 'item-15' } },
    { level: 'info' as const, message: 'Batch processing completed', metadata: { processed: 98, skipped: 2 } }
  ];

  // Log all entries at once
  log.batch(batchLogs);
}

// Example 5: Performance monitoring and timing
export async function performanceExample() {
  console.log('\n=== Performance Monitoring Example ===');

  // Manual timer management
  const timer1 = performance.start('database-connection', {
    host: 'localhost',
    database: 'tasker'
  });

  await new Promise(resolve => setTimeout(resolve, 15));
  performance.end(timer1, { success: true });

  // Measuring async functions
  const result = await performance.measureAsync('complex-computation', async () => {
    log.debug('Starting complex computation');
    await new Promise(resolve => setTimeout(resolve, 25));
    log.debug('Complex computation completed');
    return { result: 'success', itemsProcessed: 42 };
  });

  log.info('Computation result', result);

  // Measuring sync functions
  const syncResult = performance.measureSync('data-transformation', () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({ id: i, value: Math.random() }));
    return data.filter(item => item.value > 0.5).length;
  });

  log.info('Data transformation completed', {
    filteredCount: syncResult,
    originalCount: 1000
  });
}

// Example 6: Backward compatibility with hostLog
export async function backwardCompatibilityExample() {
  console.log('\n=== Backward Compatibility Example ===');

  // Old hostLog calls still work
  hostLog('legacy-service', 'info', 'This uses the old hostLog function');
  hostLog('legacy-service', 'warn', 'Warning message', { data: 'some data' });
  hostLog('legacy-service', 'error', 'Error message', {
    errorCode: 500,
    details: 'Something went wrong'
  });

  // Mixed usage is fine
  log.info('New logging service message');
  hostLog('legacy-service', 'info', 'Old hostLog message');
}

// Example 7: Configuration management
export async function configurationExample() {
  console.log('\n=== Configuration Management Example ===');

  // Show current configuration
  const currentConfig = logger.getConfig();
  log.info('Current logging configuration', currentConfig);

  // Test different log levels
  logger.updateConfig({ level: 'warn' });
  log.debug('This debug message should not appear');
  log.info('This info message should not appear');
  log.warn('This warning message should appear');
  log.error('This error message should appear');

  // Reset to original config
  logger.updateConfig({ level: currentConfig.level });
  log.info('Log level reset to original');
}

// Example 8: Sensitive data redaction
export async function sensitiveDataExample() {
  console.log('\n=== Sensitive Data Redaction Example ===');

  // Log with sensitive data - it will be automatically redacted
  log.info('User authentication attempt', {
    username: 'john.doe',
    password: 'super-secret-password',
    apiKey: 'sk-1234567890abcdef',
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  });

  // Log with nested sensitive data
  log.info('API request details', {
    url: 'https://api.example.com/users',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer secret-token-here',
      'X-API-Key': 'api-key-value'
    },
    body: {
      user: 'john.doe',
      credentials: {
        password: 'another-secret'
      }
    }
  });
}

// Run all examples
export async function runAllExamples() {
  console.log('Logging Service Examples');
  console.log('========================\n');

  try {
    await basicLoggingExample();
    await requestTracingExample();
    await serviceLoggingExample();
    await batchLoggingExample();
    await performanceExample();
    await backwardCompatibilityExample();
    await configurationExample();
    await sensitiveDataExample();

    console.log('\n✅ All examples completed successfully!');
  } catch (error) {
    console.error('\n❌ Example failed:', error);
  }
}

// Run examples if this file is executed directly
if (import.meta.main) {
  await runAllExamples();
}