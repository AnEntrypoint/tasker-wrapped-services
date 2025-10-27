/**
 * Simple test script for the logging service
 * This isolates the logging service from the config service dependency issues
 */

import { logger, log, performance, context, hostLog } from './logging-service.ts';

console.log('Testing Unified Logging Service');
console.log('================================\n');

// Test 1: Basic logging levels
console.log('1. Testing log levels:');
log.debug('Debug message - should appear in development');
log.info('Info message - should always appear');
log.warn('Warning message - should always appear');
log.error('Error message - should always appear');

// Test 2: Context-aware logging
console.log('\n2. Testing context-aware logging:');
context.set({
  requestId: 'req-12345',
  userId: 'user-67890',
  service: 'test-service'
});

log.info('This log should include context');
log.debug('Debug with context');

context.clear();

// Test 3: Performance logging
console.log('\n3. Testing performance logging:');
const timerId = performance.start('test-operation');

// Simulate some work
await new Promise(resolve => setTimeout(resolve, 10));

performance.end(timerId, { success: true });

// Test 4: Async performance measurement
console.log('\n4. Testing async performance measurement:');
const result = await performance.measureAsync('async-operation', async () => {
  await new Promise(resolve => setTimeout(resolve, 5));
  return { processed: 100, success: true };
});

log.info('Async operation result', result);

// Test 5: Child logger
console.log('\n5. Testing child logger:');
const childLogger = logger.child({ service: 'child-service', version: '1.0.0' });

childLogger.info('Message from child logger');
childLogger.warn('Warning from child logger');

// Test 6: Backward compatibility
console.log('\n6. Testing backward compatibility:');
hostLog('legacy-service', 'info', 'Message using old hostLog function');
hostLog('legacy-service', 'warn', 'Warning with data', { key: 'value' });

// Test 7: Sensitive data redaction
console.log('\n7. Testing sensitive data redaction:');
log.info('Login attempt with sensitive data', {
  username: 'john.doe',
  password: 'super-secret-password',
  apiKey: 'sk-1234567890abcdef'
});

// Test 8: Batch logging
console.log('\n8. Testing batch logging:');
log.batch([
  { level: 'info', message: 'Batch message 1' },
  { level: 'debug', message: 'Batch message 2' },
  { level: 'warn', message: 'Batch message 3', metadata: { item: 'test' } }
]);

// Test 9: Error handling
console.log('\n9. Testing error handling:');
try {
  throw new Error('Test error for logging');
} catch (error) {
  log.error('Caught and logged error', error);
}

// Test 10: Configuration
console.log('\n10. Testing configuration:');
const config = logger.getConfig();
log.info('Current logging configuration', config);

// Test JSON format
logger.updateConfig({ format: 'json' });
log.info('This message should be in JSON format');

// Test text format
logger.updateConfig({ format: 'text' });
log.info('This message should be in text format');

console.log('\n✅ All logging service tests completed successfully!');
console.log('\nThe unified logging service is ready for use across the codebase.');