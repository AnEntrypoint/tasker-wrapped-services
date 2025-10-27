/**
 * Unified Logging Service
 *
 * A comprehensive logging framework that provides structured logging with different levels,
 * supports both JSON and text formats, integrates with ConfigService, and provides
 * context-aware logging with performance monitoring and request tracing.
 */

// Import config service with lazy loading to avoid circular dependencies
import type { ConfigService } from './config-service.ts';

// Log level types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log format types
export type LogFormat = 'json' | 'text';

// Log entry interface
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  requestId?: string;
  userId?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  performance?: {
    duration?: number;
    operation?: string;
    startTime?: number;
    endTime?: number;
  };
  stack?: string;
}

// Logger configuration interface
export interface LoggerConfig {
  level: LogLevel;
  format: LogFormat;
  enableConsole: boolean;
  enablePerformance: boolean;
  enableTracing: boolean;
  redactSensitiveData: boolean;
  sensitiveFields: string[];
}

// Context for structured logging
export interface LogContext {
  requestId?: string;
  userId?: string;
  correlationId?: string;
  service?: string;
  metadata?: Record<string, any>;
}

// Performance timing interface
export interface PerformanceTimer {
  operation: string;
  startTime: number;
  metadata?: Record<string, any>;
}

// Logger class
export class Logger {
  private static instance: Logger;
  private config: LoggerConfig;
  private performanceTimers: Map<string, PerformanceTimer> = new Map();
  private requestContext: LogContext = {};

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  // Load configuration from environment variables or defaults
  private loadConfig(): LoggerConfig {
    // Lazy load config service to avoid circular dependencies
    let loggingConfig;
    try {
      const configModule = import('./config-service.ts');
      loggingConfig = configModule.then(m => m.config.logging);
    } catch (error) {
      // Fallback to environment variables if config service fails
    }

    // Get values from environment directly
    const env = Deno.env.get;
    const isDebug = env('DEBUG') === 'true' || env('DENO_ENV') === 'development';

    return {
      level: (env('LOG_LEVEL') as LogLevel) || (isDebug ? 'debug' : 'info'),
      format: (env('LOG_FORMAT') as LogFormat) || 'text',
      enableConsole: env('LOG_CONSOLE') !== 'false',
      enablePerformance: isDebug,
      enableTracing: isDebug,
      redactSensitiveData: true,
      sensitiveFields: [
        'password',
        'token',
        'key',
        'secret',
        'authorization',
        'x-api-key',
        'service_role_key',
        'anon_key',
        'gapi_key',
        'admin_email'
      ]
    };
  }

  // Set request context for tracing
  public setRequestContext(context: LogContext): void {
    this.requestContext = { ...this.requestContext, ...context };
  }

  // Clear request context
  public clearRequestContext(): void {
    this.requestContext = {};
  }

  // Check if log level should be logged
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.config.level);
    const messageLevelIndex = levels.indexOf(level);

    return messageLevelIndex >= currentLevelIndex;
  }

  // Redact sensitive data from log entries
  private redactSensitiveData(data: any): any {
    if (!this.config.redactSensitiveData || !data) {
      return data;
    }

    if (typeof data === 'string') {
      return data.replace(/([a-zA-Z]*(?:password|token|key|secret|authorization)[a-zA-Z]*["\s]*[:=]["\s]*)([^"\\\s,}]+)/gi, '$1[REDACTED]');
    }

    if (typeof data === 'object' && data !== null) {
      // CRITICAL: Deep clone to avoid mutating the original data
      const redacted = JSON.parse(JSON.stringify(data));

      const redactValue = (obj: any, path: string = ''): void => {
        for (const key in obj) {
          const currentPath = path ? `${path}.${key}` : key;

          if (this.config.sensitiveFields.some(field =>
            key.toLowerCase().includes(field.toLowerCase()) ||
            currentPath.toLowerCase().includes(field.toLowerCase())
          )) {
            obj[key] = '[REDACTED]';
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            redactValue(obj[key], currentPath);
          }
        }
      };

      redactValue(redacted);
      return redacted;
    }

    return data;
  }

  // Create log entry
  private createLogEntry(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.requestContext.service || 'unknown',
      message: this.redactSensitiveData(message),
      ...this.requestContext
    };

    if (metadata) {
      entry.metadata = this.redactSensitiveData(metadata);
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: this.redactSensitiveData(error.message),
        stack: error.stack
      };
    }

    // Get stack trace for debug and error levels
    if (level === 'debug' || level === 'error') {
      entry.stack = new Error().stack;
    }

    return entry;
  }

  // Format log entry based on configuration
  private formatLogEntry(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    // Text format
    const parts = [
      entry.timestamp,
      `[${entry.level.toUpperCase()}]`,
      entry.service ? `[${entry.service.toUpperCase()}]` : '',
      entry.requestId ? `[REQ:${entry.requestId}]` : '',
      entry.userId ? `[USER:${entry.userId}]` : '',
      entry.message
    ].filter(Boolean).join(' ');

    // Add performance info if present
    if (entry.performance && entry.performance.duration) {
      return `${parts} (${entry.performance.duration}ms)`;
    }

    // Add metadata if present
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      return `${parts} ${JSON.stringify(entry.metadata)}`;
    }

    // Add error info if present
    if (entry.error) {
      return `${parts} ${entry.error.name}: ${entry.error.message}`;
    }

    return parts;
  }

  // Write log entry
  private writeLog(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    const formatted = this.formatLogEntry(entry);

    if (this.config.enableConsole) {
      switch (entry.level) {
        case 'debug':
          console.debug(formatted);
          break;
        case 'info':
          console.info(formatted);
          break;
        case 'warn':
          console.warn(formatted);
          break;
        case 'error':
          console.error(formatted);
          break;
      }
    }
  }

  // Core logging methods
  public debug(message: string, metadata?: Record<string, any>): void {
    const entry = this.createLogEntry('debug', message, metadata);
    this.writeLog(entry);
  }

  public info(message: string, metadata?: Record<string, any>): void {
    const entry = this.createLogEntry('info', message, metadata);
    this.writeLog(entry);
  }

  public warn(message: string, metadata?: Record<string, any>): void {
    const entry = this.createLogEntry('warn', message, metadata);
    this.writeLog(entry);
  }

  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    const entry = this.createLogEntry('error', message, metadata, error);
    this.writeLog(entry);
  }

  // Performance logging
  public startTimer(operation: string, metadata?: Record<string, any>): string {
    if (!this.config.enablePerformance) {
      return '';
    }

    const timerId = `${operation}-${Date.now()}-${Math.random()}`;
    const timer: PerformanceTimer = {
      operation,
      startTime: performance.now(),
      metadata
    };

    this.performanceTimers.set(timerId, timer);
    this.debug(`Timer started: ${operation}`, metadata);

    return timerId;
  }

  public endTimer(timerId: string, metadata?: Record<string, any>): number {
    if (!this.config.enablePerformance || !timerId) {
      return 0;
    }

    const timer = this.performanceTimers.get(timerId);
    if (!timer) {
      this.warn(`Timer not found: ${timerId}`);
      return 0;
    }

    const endTime = performance.now();
    const duration = endTime - timer.startTime;

    this.performanceTimers.delete(timerId);

    const logMetadata = {
      ...timer.metadata,
      ...metadata,
      duration: Math.round(duration * 100) / 100
    };

    this.info(`Timer completed: ${timer.operation}`, logMetadata);

    return duration;
  }

  // Measure async function performance
  public async measureAsync<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const timerId = this.startTimer(operation, metadata);

    try {
      const result = await fn();
      this.endTimer(timerId, { success: true });
      return result;
    } catch (error: any) {
      this.endTimer(timerId, { success: false, error: error?.message || 'Unknown error' });
      throw error;
    }
  }

  // Measure sync function performance
  public measureSync<T>(
    operation: string,
    fn: () => T,
    metadata?: Record<string, any>
  ): T {
    const timerId = this.startTimer(operation, metadata);

    try {
      const result = fn();
      this.endTimer(timerId, { success: true });
      return result;
    } catch (error: any) {
      this.endTimer(timerId, { success: false, error: error?.message || 'Unknown error' });
      throw error;
    }
  }

  // Create child logger with additional context
  public child(context: LogContext): Logger {
    const childLogger = new Logger();
    childLogger.config = this.config;
    childLogger.requestContext = { ...this.requestContext, ...context };
    childLogger.performanceTimers = this.performanceTimers;
    return childLogger;
  }

  // Configuration management
  public updateConfig(newConfig: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): LoggerConfig {
    return { ...this.config };
  }

  // Utility methods
  public clearAllTimers(): void {
    this.performanceTimers.clear();
  }

  public getActiveTimers(): string[] {
    return Array.from(this.performanceTimers.keys());
  }

  // Batch logging for performance
  public logBatch(entries: Array<{
    level: LogLevel;
    message: string;
    metadata?: Record<string, any>;
    error?: Error;
  }>): void {
    entries.forEach(entry => {
      if (entry.error) {
        this.error(entry.message, entry.error, entry.metadata);
      } else {
        switch (entry.level) {
          case 'debug':
            this.debug(entry.message, entry.metadata);
            break;
          case 'info':
            this.info(entry.message, entry.metadata);
            break;
          case 'warn':
            this.warn(entry.message, entry.metadata);
            break;
          case 'error':
            this.error(entry.message, undefined, entry.metadata);
            break;
        }
      }
    });
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Export convenience functions for backward compatibility
export const log = {
  debug: (message: string, metadata?: Record<string, any>) => logger.debug(message, metadata),
  info: (message: string, metadata?: Record<string, any>) => logger.info(message, metadata),
  warn: (message: string, metadata?: Record<string, any>) => logger.warn(message, metadata),
  error: (message: string, error?: Error, metadata?: Record<string, any>) =>
    logger.error(message, error, metadata)
};

// Performance measurement utilities
export const perf = {
  start: (operation: string, metadata?: Record<string, any>) => logger.startTimer(operation, metadata),
  end: (timerId: string, metadata?: Record<string, any>) => logger.endTimer(timerId, metadata),
  measureAsync: <T>(operation: string, fn: () => Promise<T>, metadata?: Record<string, any>) =>
    logger.measureAsync(operation, fn, metadata),
  measureSync: <T>(operation: string, fn: () => T, metadata?: Record<string, any>) =>
    logger.measureSync(operation, fn, metadata)
};

// Context management
export const context = {
  set: (ctx: LogContext) => logger.setRequestContext(ctx),
  clear: () => logger.clearRequestContext(),
  child: (ctx: LogContext) => logger.child(ctx)
};

// Backward compatibility with existing hostLog function
export function hostLog(
  prefix: string,
  level: 'debug' | 'info' | 'warn' | 'error' | 'log',
  message: string,
  ...additionalData: any[]
): void {
  const logLevel = level === 'log' ? 'info' : level as LogLevel;
  const metadata = additionalData.length > 0 ? { data: additionalData } : undefined;

  const childLogger = logger.child({ service: prefix });

  switch (logLevel) {
    case 'debug':
      childLogger.debug(message, metadata);
      break;
    case 'info':
      childLogger.info(message, metadata);
      break;
    case 'warn':
      childLogger.warn(message, metadata);
      break;
    case 'error':
      childLogger.error(message, undefined, metadata);
      break;
  }
}

