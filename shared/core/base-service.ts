/**
 * Base Service Class
 *
 * Provides a standardized foundation for all service implementations in the codebase.
 * This class enforces consistent initialization, health checks, error handling,
 * logging patterns, and method naming conventions across all services.
 */

import { ConfigService } from './config-service.ts';
import { logger, perf, context } from './logging-service.ts';
import { DatabaseService } from './database-service.ts';

// Service health status types
export type ServiceHealthStatus = 'healthy' | 'unhealthy' | 'degraded';

// Service health check result interface
export interface IHealthCheckResult {
  status: ServiceHealthStatus;
  timestamp: string;
  version?: string;
  details?: Record<string, any>;
  error?: string;
  performance?: number;
}

// Service configuration interface
export interface IServiceConfig {
  name: string;
  version: string;
  description?: string;
  enableHealthCheck: boolean;
  enablePerformanceLogging: boolean;
  timeout: number;
  retries: number;
}

// Service request context interface
export interface IServiceContext {
  requestId?: string;
  userId?: string;
  correlationId?: string;
  operation?: string;
  metadata?: Record<string, any>;
}

// Service response interface
export interface IServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  metadata?: {
    timestamp: string;
    duration: number;
    requestId?: string;
    version?: string;
  };
}

// Service error types
export enum ServiceErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  NOT_FOUND_ERROR = 'NOT_FOUND_ERROR',
  CONFLICT_ERROR = 'CONFLICT_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR'
}

// Custom service error class
export class ServiceError extends Error {
  public readonly type: ServiceErrorType;
  public readonly code: string;
  public readonly details?: Record<string, any>;
  public readonly statusCode: number;

  constructor(
    type: ServiceErrorType,
    message: string,
    code?: string,
    details?: Record<string, any>,
    statusCode: number = 500
  ) {
    super(message);
    this.name = 'ServiceError';
    this.type = type;
    this.code = code || type;
    this.details = details;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      code: this.code,
      message: this.message,
      details: this.details,
      stack: this.stack
    };
  }
}

/**
 * Base Service Class
 *
 * All services should extend this class to ensure consistent patterns
 * for initialization, error handling, logging, and health checks.
 */
export abstract class BaseService {
  protected readonly config: ConfigService;
  protected readonly database: DatabaseService;
  protected readonly serviceName: string;
  protected readonly serviceVersion: string;
  protected readonly serviceConfig: IServiceConfig;

  constructor(serviceConfig: IServiceConfig) {
    this.config = ConfigService.getInstance();
    this.database = DatabaseService.getInstance();
    this.serviceName = serviceConfig.name;
    this.serviceVersion = serviceConfig.version;
    this.serviceConfig = serviceConfig;

    // Initialize service context
    this.initializeService();
  }

  /**
   * Initialize the service with proper logging and configuration validation
   */
  private initializeService(): void {
    logger.info(`Initializing service: ${this.serviceName}`, {
      version: this.serviceVersion,
      environment: this.config.environment
    });

    // Validate configuration
    this.validateConfiguration();

    // Set up service-specific logging context
    logger.setRequestContext({
      service: this.serviceName,
      version: this.serviceVersion
    });

    logger.info(`Service initialized successfully: ${this.serviceName}`);
  }

  /**
   * Validate service-specific configuration
   * Override this method in subclasses to add custom validation
   */
  protected validateConfiguration(): void {
    const validation = this.config.validate();
    if (!validation.isValid) {
      throw new ServiceError(
        ServiceErrorType.CONFIGURATION_ERROR,
        `Invalid configuration for ${this.serviceName}`,
        'CONFIG_VALIDATION_FAILED',
        { errors: validation.errors }
      );
    }
  }

  /**
   * Create a standardized service context
   */
  protected createServiceContext(context?: Partial<IServiceContext>): IServiceContext {
    return {
      requestId: context?.requestId || crypto.randomUUID(),
      correlationId: context?.correlationId || crypto.randomUUID(),
      service: this.serviceName,
      version: this.serviceVersion,
      ...context
    };
  }

  /**
   * Execute a service operation with consistent error handling and logging
   */
  protected async executeOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    context?: Partial<IServiceContext>
  ): Promise<IServiceResponse<T>> {
    const serviceContext = this.createServiceContext(context);
    const timerId = perf.start(`${this.serviceName}.${operationName}`, {
      operation: operationName,
      requestId: serviceContext.requestId
    });

    try {
      logger.info(`Starting operation: ${operationName}`, {
        requestId: serviceContext.requestId,
        operation: operationName
      });

      // Set context for the operation
      logger.setRequestContext(serviceContext);

      // Execute the operation
      const result = await operation();

      const duration = perf.end(timerId);

      logger.info(`Operation completed successfully: ${operationName}`, {
        requestId: serviceContext.requestId,
        duration,
        hasResult: !!result
      });

      return this.createSuccessResponse(result, serviceContext, duration);

    } catch (error) {
      const duration = perf.end(timerId);

      logger.error(`Operation failed: ${operationName}`, error as Error, {
        requestId: serviceContext.requestId,
        duration
      });

      return this.createErrorResponse(error as Error, serviceContext, duration);
    } finally {
      // Clear the request context
      logger.clearRequestContext();
    }
  }

  /**
   * Create a successful service response
   */
  protected createSuccessResponse<T>(
    data: T,
    context: IServiceContext,
    duration: number
  ): IServiceResponse<T> {
    return {
      success: true,
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        duration,
        requestId: context.requestId,
        version: this.serviceVersion
      }
    };
  }

  /**
   * Create an error service response
   */
  protected createErrorResponse(
    error: Error,
    context: IServiceContext,
    duration: number
  ): IServiceResponse {
    const serviceError = this.normalizeError(error);

    return {
      success: false,
      error: {
        code: serviceError.code,
        message: serviceError.message,
        details: serviceError.details
      },
      metadata: {
        timestamp: new Date().toISOString(),
        duration,
        requestId: context.requestId,
        version: this.serviceVersion
      }
    };
  }

  /**
   * Normalize different error types to ServiceError
   */
  protected normalizeError(error: Error): ServiceError {
    if (error instanceof ServiceError) {
      return error;
    }

    // Convert common error patterns to ServiceError
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return new ServiceError(
        ServiceErrorType.TIMEOUT_ERROR,
        error.message,
        'OPERATION_TIMEOUT',
        { originalError: error.message }
      );
    }

    if (message.includes('not found')) {
      return new ServiceError(
        ServiceErrorType.NOT_FOUND_ERROR,
        error.message,
        'RESOURCE_NOT_FOUND',
        { originalError: error.message },
        404
      );
    }

    if (message.includes('unauthorized') || message.includes('authentication')) {
      return new ServiceError(
        ServiceErrorType.AUTHENTICATION_ERROR,
        error.message,
        'AUTHENTICATION_FAILED',
        { originalError: error.message },
        401
      );
    }

    if (message.includes('forbidden') || message.includes('authorization')) {
      return new ServiceError(
        ServiceErrorType.AUTHORIZATION_ERROR,
        error.message,
        'AUTHORIZATION_FAILED',
        { originalError: error.message },
        403
      );
    }

    if (message.includes('validation')) {
      return new ServiceError(
        ServiceErrorType.VALIDATION_ERROR,
        error.message,
        'VALIDATION_FAILED',
        { originalError: error.message },
        400
      );
    }

    // Default to internal error
    return new ServiceError(
      ServiceErrorType.INTERNAL_ERROR,
      error.message,
      'INTERNAL_ERROR',
      { originalError: error.message, stack: error.stack }
    );
  }

  /**
   * Perform a health check on the service
   * Override this method in subclasses to add service-specific health checks
   */
  protected async performHealthCheck(): Promise<IHealthCheckResult> {
    const timerId = perf.start(`${this.serviceName}.healthCheck`);

    try {
      // Basic health checks
      const checks: Promise<{ name: string; healthy: boolean; error?: string }>[] = [
        this.checkConfigurationHealth(),
        this.checkDatabaseHealth()
      ];

      const results = await Promise.allSettled(checks);

      let overallStatus: ServiceHealthStatus = 'healthy';
      const details: Record<string, any> = {};
      let errors: string[] = [];

      results.forEach((result, index) => {
        const checkName = ['configuration', 'database'][index];

        if (result.status === 'fulfilled') {
          details[checkName] = result.value;
          if (!result.value.healthy) {
            overallStatus = 'degraded';
            if (result.value.error) {
              errors.push(result.value.error);
            }
          }
        } else {
          details[checkName] = { healthy: false, error: 'Check failed' };
          overallStatus = 'unhealthy';
          errors.push(`${checkName} check failed: ${result.reason}`);
        }
      });

      const duration = perf.end(timerId);

      if (overallStatus === 'healthy') {
        logger.info(`Health check passed for ${this.serviceName}`, { duration });
      } else {
        logger.warn(`Health check issues for ${this.serviceName}`, {
          status: overallStatus,
          errors,
          duration
        });
      }

      return {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        version: this.serviceVersion,
        details,
        performance: duration,
        error: errors.length > 0 ? errors.join('; ') : undefined
      };

    } catch (error) {
      const duration = perf.end(timerId);

      logger.error(`Health check failed for ${this.serviceName}`, error as Error, { duration });

      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        version: this.serviceVersion,
        error: (error as Error).message,
        performance: duration
      };
    }
  }

  /**
   * Check configuration health
   */
  protected async checkConfigurationHealth(): Promise<{ name: string; healthy: boolean; error?: string }> {
    try {
      const validation = this.config.validate();
      return {
        name: 'configuration',
        healthy: validation.isValid,
        error: validation.isValid ? undefined : validation.errors.join(', ')
      };
    } catch (error) {
      return {
        name: 'configuration',
        healthy: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Check database health
   */
  protected async checkDatabaseHealth(): Promise<{ name: string; healthy: boolean; error?: string }> {
    try {
      const dbHealth = await this.database.healthCheck();
      return {
        name: 'database',
        healthy: dbHealth.healthy,
        error: dbHealth.error
      };
    } catch (error) {
      return {
        name: 'database',
        healthy: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Get service information
   */
  public getServiceInfo(): { name: string; version: string; description?: string } {
    return {
      name: this.serviceName,
      version: this.serviceVersion,
      description: this.serviceConfig.description
    };
  }

  /**
   * Public method to get health check result
   */
  public async getHealthCheck(): Promise<IHealthCheckResult> {
    return this.performHealthCheck();
  }

  /**
   * Abstract method that must be implemented by subclasses
   * Define the main service operations and business logic
   */
  abstract getOperations(): string[];

  /**
   * Cleanup method for graceful shutdown
   * Override this method in subclasses to add custom cleanup logic
   */
  public async cleanup(): Promise<void> {
    logger.info(`Cleaning up service: ${this.serviceName}`);

    // Clear any service-specific resources here

    logger.info(`Service cleanup completed: ${this.serviceName}`);
  }
}

/**
 * Utility functions for creating standardized service responses
 */
export const ServiceResponse = {
  success: <T>(data: T, requestId?: string): IServiceResponse<T> => ({
    success: true,
    data,
    metadata: {
      timestamp: new Date().toISOString(),
      duration: 0,
      requestId,
      version: 'unknown'
    }
  }),

  error: (
    code: string,
    message: string,
    details?: Record<string, any>,
    requestId?: string
  ): IServiceResponse => ({
    success: false,
    error: { code, message, details },
    metadata: {
      timestamp: new Date().toISOString(),
      duration: 0,
      requestId,
      version: 'unknown'
    }
  })
};

/**
 * Service decorator for automatic operation logging
 */
export function ServiceOperation(operationName: string) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    // Skip decoration if descriptor is not available
    if (!descriptor) {
      console.warn(`ServiceOperation decorator: Cannot apply to ${propertyName} - descriptor not found`);
      return descriptor;
    }

    const method = descriptor.value;

    // Skip decoration if method is not available
    if (!method || typeof method !== 'function') {
      console.warn(`ServiceOperation decorator: Cannot apply to ${propertyName} - method not found or not a function`);
      return descriptor;
    }

    descriptor.value = async function (...args: any[]) {
      const serviceName = (this as BaseService).serviceName;
      const timerId = perf.start(`${serviceName}.${operationName}`);

      try {
        logger.info(`Starting ${operationName}`, {
          service: serviceName,
          operation: operationName,
          args: args.length
        });

        const result = await method.apply(this, args);

        const duration = perf.end(timerId);
        logger.info(`Completed ${operationName}`, {
          service: serviceName,
          operation: operationName,
          duration,
          success: true
        });

        return result;
      } catch (error) {
        const duration = perf.end(timerId);
        logger.error(`Failed ${operationName}`, error as Error, {
          service: serviceName,
          operation: operationName,
          duration,
          success: false
        });
        throw error;
      }
    };

    return descriptor;
  };
}