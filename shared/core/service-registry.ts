/**
 * Unified Service Registry for HTTP-Wrapped External Services
 *
 * Provides a single source of truth for ALL external service calls,
 * wrapping every external dependency as HTTP services that FlowState
 * can automatically pause/resume.
 */

import { httpClient, type FlowStateContext } from './http-client.ts';
import { logger } from './logging-service.ts';
import { config } from './config-service.ts';

// Service health status
export type ServiceHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

// Service definition interface
export interface ServiceDefinition {
  name: string;
  baseUrl: string;
  version: string;
  description: string;
  methods: ServiceMethod[];
  healthCheck?: HealthCheckConfig;
  fallback?: FallbackConfig;
}

// Service method interface
export interface ServiceMethod {
  name: string;
  description: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  parameters?: MethodParameter[];
  returnType?: string;
  timeout?: number;
  retries?: number;
  requiresAuth?: boolean;
}

// Method parameter interface
export interface MethodParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: any;
}

// Health check configuration
export interface HealthCheckConfig {
  path: string;
  method?: 'GET' | 'POST';
  interval?: number; // milliseconds
  timeout?: number;
  expectedStatus?: number;
  expectedResponse?: any;
}

// Fallback configuration
export interface FallbackConfig {
  enabled: boolean;
  fallbackServices?: string[];
  cacheResults?: boolean;
  cacheTTL?: number; // milliseconds
}

// Service call context
export interface ServiceCallContext {
  serviceName: string;
  methodName: string;
  taskRunId?: string;
  stackRunId?: string;
  requestId?: string;
  metadata?: Record<string, any>;
}

// Service response wrapper
export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    serviceName: string;
    methodName: string;
    duration: number;
    retries: number;
    cached?: boolean;
    flowStatePaused?: boolean;
  };
}

// Service registry class
export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services: Map<string, ServiceDefinition> = new Map();
  private healthStatus: Map<string, ServiceHealth> = new Map();
  private lastHealthCheck: Map<string, number> = new Map();
  private serviceCache: Map<string, { data: any; timestamp: number }> = new Map();

  private constructor() {
    this.initializeServices();
    this.startHealthChecks();
  }

  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * Initialize all service definitions
   */
  private initializeServices(): void {
    // Database service (Supabase)
    this.registerService({
      name: 'database',
      baseUrl: this.getServiceUrl('wrappedsupabase'),
      version: '1.0.0',
      description: 'Supabase database operations',
      methods: [
        {
          name: 'select',
          description: 'Select records from a table',
          path: '/select',
          method: 'POST',
          parameters: [
            { name: 'table', type: 'string', required: true, description: 'Table name' },
            { name: 'query', type: 'object', required: false, description: 'Query parameters' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'insert',
          description: 'Insert records into a table',
          path: '/insert',
          method: 'POST',
          parameters: [
            { name: 'table', type: 'string', required: true, description: 'Table name' },
            { name: 'records', type: 'any[]', required: true, description: 'Records to insert' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'update',
          description: 'Update records in a table',
          path: '/update',
          method: 'POST',
          parameters: [
            { name: 'table', type: 'string', required: true, description: 'Table name' },
            { name: 'query', type: 'object', required: false, description: 'Query conditions' },
            { name: 'update', type: 'object', required: true, description: 'Update data' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'delete',
          description: 'Delete records from a table',
          path: '/delete',
          method: 'POST',
          parameters: [
            { name: 'table', type: 'string', required: true, description: 'Table name' },
            { name: 'query', type: 'object', required: false, description: 'Query conditions' }
          ],
          returnType: '{ count: number }'
        },
        {
          name: 'rpc',
          description: 'Execute a database function',
          path: '/rpc',
          method: 'POST',
          parameters: [
            { name: 'functionName', type: 'string', required: true, description: 'Function name' },
            { name: 'params', type: 'any[]', required: false, description: 'Function parameters' }
          ],
          returnType: 'any'
        }
      ],
      healthCheck: {
        path: '/health',
        method: 'GET',
        interval: 30000, // 30 seconds
        timeout: 5000
      }
    });

    this.registerService({
      name: 'keystore',
      baseUrl: this.getServiceUrl('wrappedkeystore'),
      version: '1.0.0',
      description: 'Key-value storage for credentials and configuration',
      methods: [
        {
          name: 'getKey',
          description: 'Get a value by key',
          path: '/getKey',
          method: 'POST',
          parameters: [
            { name: 'namespace', type: 'string', required: true, description: 'Namespace' },
            { name: 'key', type: 'string', required: true, description: 'Key to retrieve' }
          ],
          returnType: 'string'
        },
        {
          name: 'setKey',
          description: 'Set a value by key',
          path: '/setKey',
          method: 'POST',
          parameters: [
            { name: 'namespace', type: 'string', required: true, description: 'Namespace' },
            { name: 'key', type: 'string', required: true, description: 'Key to set' },
            { name: 'value', type: 'string', required: true, description: 'Value to set' }
          ],
          returnType: 'boolean'
        },
        {
          name: 'listKeys',
          description: 'List all keys',
          path: '/listKeys',
          method: 'POST',
          parameters: [
            { name: 'namespace', type: 'string', required: false, description: 'Namespace filter' }
          ],
          returnType: 'string[]'
        }
      ],
      healthCheck: {
        path: '/health',
        method: 'GET',
        interval: 30000,
        timeout: 5000
      }
    });

    // Google API service
    this.registerService({
      name: 'gapi',
      baseUrl: this.getServiceUrl('wrappedgapi'),
      version: '1.0.0',
      description: 'Google API integration service',
      methods: [
        {
          name: 'domains.list',
          description: 'List domains',
          path: '/domains/list',
          method: 'POST',
          parameters: [
            { name: 'customer', type: 'string', required: false, description: 'Customer ID' },
            { name: 'maxResults', type: 'number', required: false, description: 'Maximum results' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'users.list',
          description: 'List users',
          path: '/users/list',
          method: 'POST',
          parameters: [
            { name: 'domain', type: 'string', required: false, description: 'Domain name' },
            { name: 'customer', type: 'string', required: false, description: 'Customer ID' },
            { name: 'maxResults', type: 'number', required: false, description: 'Maximum results' },
            { name: 'query', type: 'string', required: false, description: 'Search query' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'gmail.messages.list',
          description: 'List Gmail messages',
          path: '/gmail/messages/list',
          method: 'POST',
          parameters: [
            { name: 'userId', type: 'string', required: false, defaultValue: 'me', description: 'User ID' },
            { name: 'query', type: 'string', required: false, description: 'Search query' },
            { name: 'maxResults', type: 'number', required: false, description: 'Maximum results' }
          ],
          returnType: 'any[]'
        },
        {
          name: 'gmail.messages.get',
          description: 'Get Gmail message details',
          path: '/gmail/messages/get',
          method: 'POST',
          parameters: [
            { name: 'userId', type: 'string', required: false, defaultValue: 'me', description: 'User ID' },
            { name: 'messageId', type: 'string', required: true, description: 'Message ID' },
            { name: 'format', type: 'string', required: false, description: 'Message format' }
          ],
          returnType: 'any'
        }
      ],
      healthCheck: {
        path: '/health',
        method: 'GET',
        interval: 30000,
        timeout: 10000
      }
    });

    // OpenAI API service
    this.registerService({
      name: 'openai',
      baseUrl: this.getServiceUrl('wrappedopenai'),
      version: '1.0.0',
      description: 'OpenAI API integration service',
      methods: [
        {
          name: 'chat.completions.create',
          description: 'Create chat completion',
          path: '/chat/completions/create',
          method: 'POST',
          parameters: [
            { name: 'model', type: 'string', required: true, description: 'Model name' },
            { name: 'messages', type: 'any[]', required: true, description: 'Chat messages' },
            { name: 'temperature', type: 'number', required: false, description: 'Sampling temperature' },
            { name: 'maxTokens', type: 'number', required: false, description: 'Maximum tokens' }
          ],
          returnType: 'any'
        }
      ],
      healthCheck: {
        path: '/health',
        method: 'GET',
        interval: 60000, // 1 minute
        timeout: 10000
      }
    });

    // Web search service
    this.registerService({
      name: 'websearch',
      baseUrl: this.getServiceUrl('wrappedwebsearch'),
      version: '1.0.0',
      description: 'Web search API integration service',
      methods: [
        {
          name: 'search',
          description: 'Perform web search',
          path: '/search',
          method: 'POST',
          parameters: [
            { name: 'query', type: 'string', required: true, description: 'Search query' },
            { name: 'maxResults', type: 'number', required: false, description: 'Maximum results' },
            { name: 'safeSearch', type: 'string', required: false, description: 'Safe search level' }
          ],
          returnType: 'any[]'
        }
      ],
      healthCheck: {
        path: '/health',
        method: 'GET',
        interval: 60000,
        timeout: 10000
      }
    });
  }

  /**
   * Get service URL based on environment
   */
  private getServiceUrl(serviceName: string): string {
    const serviceConfig = config.getService(serviceName);
    if (serviceConfig) {
      return serviceConfig.baseUrl;
    }

    // Fallback to Supabase edge functions for development
    const supabaseUrl = config.supabase?.url || 'http://127.0.0.1:54321';
    return `${supabaseUrl}/functions/v1/${serviceName}`;
  }

  /**
   * Register a new service definition
   */
  public registerService(service: ServiceDefinition): void {
    this.services.set(service.name, service);
    this.healthStatus.set(service.name, 'unknown');
    logger.info(`Service registered: ${service.name}`, {
      version: service.version,
      baseUrl: service.baseUrl,
      methods: service.methods.length
    });
  }

  /**
   * Get service definition by name
   */
  public getService(serviceName: string): ServiceDefinition | undefined {
    return this.services.get(serviceName);
  }

  /**
   * Get all registered services
   */
  public getAllServices(): ServiceDefinition[] {
    return Array.from(this.services.values());
  }

  /**
   * Check if service exists
   */
  public hasService(serviceName: string): boolean {
    return this.services.has(serviceName);
  }

  /**
   * Call a service method with automatic FlowState integration
   */
  public async call<T = any>(
    serviceName: string,
    methodName: string,
    args: any[] = [],
    context?: Partial<ServiceCallContext>
  ): Promise<ServiceResponse<T>> {
    // ULTRA DEBUG: Log every single call to confirm this method is being executed
    console.log('[ServiceRegistry.call] ENTRY', {
      serviceName,
      methodName,
      argsType: typeof args,
      isArray: Array.isArray(args),
      argsLength: Array.isArray(args) ? args.length : 'N/A'
    });

    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    const method = service.methods.find(m => m.name === methodName);
    if (!method) {
      throw new Error(`Method not found: ${serviceName}.${methodName}`);
    }

    const callContext: ServiceCallContext = {
      serviceName,
      methodName,
      requestId: `req-${Date.now()}-${Math.random()}`,
      metadata: {},
      ...context
    };

    const startTime = performance.now();
    const timerId = logger.startTimer(`Service Call: ${serviceName}.${methodName}`, {
      serviceName,
      methodName,
      requestId: callContext.requestId
    });

    try {
      // Check cache for GET operations
      const cacheKey = method.method === 'GET' ? this.getCacheKey(serviceName, methodName, args) : null;
      if (cacheKey) {
        const cached = this.serviceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < 300000) { // 5 minutes cache
          logger.endTimer(timerId, { success: true, cached: true });
          return {
            success: true,
            data: cached.data,
            metadata: {
              serviceName,
              methodName,
              duration: 0,
              retries: 0,
              cached: true
            }
          };
        }
      }

      // Build request URL - use base URL directly, not with method.path
      const url = service.baseUrl;

      // Prepare request body
      let requestBody;
      if (method.method !== 'GET') {
        // Debug logging for processChain calls
        if (methodName === 'processChain') {
          console.log('[ServiceRegistry-DEBUG] processChain call received', {
            argsType: typeof args,
            isArray: Array.isArray(args),
            hasChain: args && typeof args === 'object' && 'chain' in args,
            argsKeys: args && typeof args === 'object' ? Object.keys(args) : []
          });
        }

        // Special handling for processChain - pass chain directly, not wrapped
        // Check if args itself is an object with chain property (not an array containing it)
        if (methodName === 'processChain' && typeof args === 'object' && args !== null && 'chain' in args && !Array.isArray(args)) {
          requestBody = args; // args = { chain: [...] }
          console.log('[ServiceRegistry-DEBUG] processChain: passing chain directly', { chainLength: args.chain?.length });
        } else {
          // Standard chain format for other methods
          requestBody = {
            chain: [
              { property: methodName, args: args }
            ]
          };
          if (methodName === 'processChain') {
            console.log('[ServiceRegistry-DEBUG] processChain: wrapping in chain format (fallback)', { argsType: typeof args });
          }
        }
      }

      // Prepare request options with FlowState integration
      const requestOptions = {
        method: 'POST',
        body: requestBody,
        timeout: method.timeout || 30000,
        retries: method.retries || 3,
        enableFlowState: true,
        serviceContext: {
          serviceName,
          methodPath: methodName.split('.'),
          taskRunId: callContext.taskRunId,
          stackRunId: callContext.stackRunId
        }
      };

      logger.debug(`Making service call: ${serviceName}.${methodName}`, {
        url,
        method: method.method,
        args: this.sanitizeArgs(args),
        requestId: callContext.requestId
      });

      // Make HTTP request
      const response = await httpClient.request<T>(url, requestOptions);

      const duration = performance.now() - startTime;
      logger.endTimer(timerId, {
        success: response.success,
        duration: Math.round(duration * 100) / 100,
        status: response.status
      });

      // Cache successful GET responses
      if (response.success && cacheKey && response.data) {
        this.serviceCache.set(cacheKey, {
          data: response.data,
          timestamp: Date.now()
        });
      }

      const serviceResponse: ServiceResponse<T> = {
        success: response.success,
        data: response.data,
        error: response.error,
        metadata: {
          serviceName,
          methodName,
          duration: Math.round(duration * 100) / 100,
          retries: response.metadata?.retries || 0,
          cached: !!cacheKey && this.serviceCache.has(cacheKey),
          flowStatePaused: (response.data as any)?.__flowStatePaused || false
        }
      };

      if (response.success) {
        logger.info(`Service call successful: ${serviceName}.${methodName}`, {
          requestId: callContext.requestId,
          duration: serviceResponse.metadata?.duration,
          cached: serviceResponse.metadata?.cached
        });
      } else {
        logger.warn(`Service call failed: ${serviceName}.${methodName}`, {
          requestId: callContext.requestId,
          error: response.error,
          status: response.status
        });
      }

      return serviceResponse;

    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.endTimer(timerId, {
        success: false,
        duration: Math.round(duration * 100) / 100,
        error: errorMessage
      });

      logger.error(`Service call error: ${serviceName}.${methodName}`, error as Error, {
        requestId: callContext.requestId,
        args: this.sanitizeArgs(args)
      });

      return {
        success: false,
        error: errorMessage,
        metadata: {
          serviceName,
          methodName,
          duration: Math.round(duration * 100) / 100,
          retries: 0
        }
      };
    }
  }

  /**
   * Get service health status
   */
  public getServiceHealth(serviceName: string): ServiceHealth {
    return this.healthStatus.get(serviceName) || 'unknown';
  }

  /**
   * Get health status for all services
   */
  public getAllServiceHealth(): Record<string, ServiceHealth> {
    const health: Record<string, ServiceHealth> = {};
    for (const [serviceName, status] of this.healthStatus) {
      health[serviceName] = status;
    }
    return health;
  }

  /**
   * Perform health check on a service
   */
  public async performHealthCheck(serviceName: string): Promise<ServiceHealth> {
    const service = this.services.get(serviceName);
    if (!service || !service.healthCheck) {
      return 'unknown';
    }

    // Skip health checks for wrapped services when using integrated Supabase server
    // (all functions served from same endpoint, individual health checks don't work)
    const supabaseUrl = config.supabase?.url || 'http://127.0.0.1:54321';
    if (service.baseUrl.startsWith(supabaseUrl) &&
        (serviceName.startsWith('wrapped') || ['gapi', 'keystore', 'database', 'openai', 'websearch'].includes(serviceName))) {
      this.healthStatus.set(serviceName, 'healthy');
      this.lastHealthCheck.set(serviceName, Date.now());
      return 'healthy';
    }

    try {
      const { path, method = 'GET', timeout = 5000 } = service.healthCheck;
      const url = `${service.baseUrl}${path}`;

      const response = await httpClient.request(url, {
        method,
        timeout,
        enableFlowState: false // Don't use FlowState for health checks
      });

      const status = response.success ? 'healthy' : 'unhealthy';
      this.healthStatus.set(serviceName, status);
      this.lastHealthCheck.set(serviceName, Date.now());

      logger.debug(`Health check completed for ${serviceName}: ${status}`, {
        url,
        status: response.status
      });

      return status;

    } catch (error) {
      logger.warn(`Health check failed for ${serviceName}`, {
        error: error instanceof Error ? error.message : String(error)
      });

      this.healthStatus.set(serviceName, 'unhealthy');
      this.lastHealthCheck.set(serviceName, Date.now());
      return 'unhealthy';
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    setInterval(async () => {
      for (const [serviceName, service] of this.services) {
        if (service.healthCheck) {
          const interval = service.healthCheck.interval || 30000;
          const lastCheck = this.lastHealthCheck.get(serviceName) || 0;

          if (Date.now() - lastCheck >= interval) {
            await this.performHealthCheck(serviceName);
          }
        }
      }
    }, 10000); // Check every 10 seconds for any services that need health checks
  }

  /**
   * Generate cache key for service calls
   */
  private getCacheKey(serviceName: string, methodName: string, args: any[]): string {
    return `${serviceName}.${methodName}:${JSON.stringify(args)}`;
  }

  /**
   * Sanitize arguments for logging (remove sensitive data)
   */
  private sanitizeArgs(args: any[]): any[] {
    return args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        const sanitized = { ...arg };
        const sensitiveFields = ['password', 'token', 'key', 'secret', 'authorization'];

        for (const field of sensitiveFields) {
          if (field in sanitized) {
            sanitized[field] = '[REDACTED]';
          }
        }

        return sanitized;
      }
      return arg;
    });
  }

  /**
   * Clear service cache
   */
  public clearCache(serviceName?: string): void {
    if (serviceName) {
      // Clear cache for specific service
      for (const [key] of this.serviceCache) {
        if (key.startsWith(`${serviceName}.`)) {
          this.serviceCache.delete(key);
        }
      }
    } else {
      // Clear all cache
      this.serviceCache.clear();
    }
  }

  /**
   * Get registry statistics
   */
  public getStats(): {
    totalServices: number;
    totalMethods: number;
    healthSummary: Record<string, number>;
    cacheSize: number;
  } {
    const healthSummary: Record<string, number> = {
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      unknown: 0
    };

    for (const status of this.healthStatus.values()) {
      healthSummary[status]++;
    }

    let totalMethods = 0;
    for (const service of this.services.values()) {
      totalMethods += service.methods.length;
    }

    return {
      totalServices: this.services.size,
      totalMethods,
      healthSummary,
      cacheSize: this.serviceCache.size
    };
  }
}

// Export singleton instance
export const serviceRegistry = ServiceRegistry.getInstance();

// Export convenience functions for service calls
export const services = {
  call: <T = any>(serviceName: string, methodName: string, args?: any[], context?: Partial<ServiceCallContext>) =>
    serviceRegistry.call<T>(serviceName, methodName, args || [], context),

  // Database convenience methods
  database: {
    select: (table: string, query?: any, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('database', 'select', [table, query], context),
    insert: (table: string, records: any[], context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('database', 'insert', [table, records], context),
    update: (table: string, query: any, update: any, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('database', 'update', [table, query, update], context),
    delete: (table: string, query?: any, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('database', 'delete', [table, query], context),
    rpc: (functionName: string, params?: any[], context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('database', 'rpc', [functionName, params || []], context)
  },

  // Keystore convenience methods
  keystore: {
    get: (key: string, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('keystore', 'get', [key], context),
    set: (key: string, value: string, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('keystore', 'set', [key, value], context),
    delete: (key: string, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('keystore', 'delete', [key], context),
    list: (prefix?: string, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('keystore', 'list', [prefix], context)
  },

  // Google API convenience methods
  gapi: {
    domains: {
      list: (customer?: string, maxResults?: number, context?: Partial<ServiceCallContext>) =>
        serviceRegistry.call('gapi', 'domains.list', [customer, maxResults], context)
    },
    users: {
      list: (domain?: string, customer?: string, maxResults?: number, query?: string, context?: Partial<ServiceCallContext>) =>
        serviceRegistry.call('gapi', 'users.list', [domain, customer, maxResults, query], context)
    },
    gmail: {
      messages: {
        list: (userId?: string, query?: string, maxResults?: number, context?: Partial<ServiceCallContext>) =>
          serviceRegistry.call('gapi', 'gmail.messages.list', [userId, query, maxResults], context),
        get: (userId: string, messageId: string, format?: string, context?: Partial<ServiceCallContext>) =>
          serviceRegistry.call('gapi', 'gmail.messages.get', [userId, messageId, format], context)
      }
    }
  },

  // OpenAI convenience methods
  openai: {
    chat: {
      completions: {
        create: (model: string, messages: any[], temperature?: number, maxTokens?: number, context?: Partial<ServiceCallContext>) =>
          serviceRegistry.call('openai', 'chat.completions.create', [model, messages, temperature, maxTokens], context)
      }
    }
  },

  // Web search convenience methods
  websearch: {
    search: (query: string, maxResults?: number, safeSearch?: string, context?: Partial<ServiceCallContext>) =>
      serviceRegistry.call('websearch', 'search', [query, maxResults, safeSearch], context)
  }
};

