/**
 * Unified HTTP Client for Service Registry
 *
 * Provides a centralized HTTP client with FlowState integration for automatic
 * pause/resume on external calls, retry logic, error handling, and logging.
 */

import { logger } from './logging-service.ts';
import { config } from './config-service.ts';

// HTTP client configuration
export interface HttpClientConfig {
  timeout: number;
  retries: number;
  retryDelay: number;
  enableFlowStateIntegration: boolean;
  flowStateTimeout?: number;
}

// Request options interface
export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  retries?: number;
  enableFlowState?: boolean;
  serviceContext?: {
    serviceName: string;
    methodPath: string[];
    taskRunId?: string;
    stackRunId?: string;
  };
}

// HTTP response interface
export interface HttpResponse<T = any> {
  success: boolean;
  status: number;
  statusText: string;
  data?: T;
  error?: string;
  headers?: Record<string, string>;
  metadata?: {
    duration: number;
    retries: number;
    serviceCall?: {
      serviceName: string;
      methodPath: string;
    };
  };
}

// FlowState request context for pause/resume
export interface FlowStateContext {
  serviceName: string;
  methodPath: string[];
  args: any[];
  taskRunId: string;
  stackRunId: string;
  fetchUrl: string;
}

// HTTP client class
export class HttpClient {
  private static instance: HttpClient;
  private config: HttpClientConfig;
  private flowStateContexts: Map<string, FlowStateContext> = new Map();

  private constructor() {
    this.config = {
      timeout: config.http.timeout,
      retries: config.http.retries,
      retryDelay: config.http.retryDelay,
      enableFlowStateIntegration: true,
      flowStateTimeout: 2 * 60 * 60 * 1000 // 2 hours
    };
  }

  public static getInstance(): HttpClient {
    if (!HttpClient.instance) {
      HttpClient.instance = new HttpClient();
    }
    return HttpClient.instance;
  }

  /**
   * Make HTTP request with automatic retry and error handling
   */
  public async request<T = any>(
    url: string,
    options: RequestOptions = {}
  ): Promise<HttpResponse<T>> {
    const startTime = performance.now();
    const {
      method = 'GET',
      headers = {},
      body,
      timeout = this.config.timeout,
      retries = this.config.retries,
      enableFlowState = this.config.enableFlowStateIntegration,
      serviceContext
    } = options;

    const operationId = `http-${method}-${Date.now()}-${Math.random()}`;
    const timerId = logger.startTimer(`HTTP ${method} ${url}`, {
      operationId,
      serviceContext
    });

    try {
      // Check if this is a FlowState external call that should be intercepted
      if (enableFlowState && serviceContext && this.isFlowStateCall(url)) {
        const flowStateResponse = await this.handleFlowStateCall(url, options, operationId);
        logger.endTimer(timerId, { success: true, flowStateHandled: true });
        return flowStateResponse as HttpResponse<T>;
      }

      // Regular HTTP request with retry logic
      const response = await this.executeWithRetry<T>(url, {
        method,
        headers,
        body,
        timeout,
        retries
      }, operationId);

      const duration = performance.now() - startTime;
      logger.endTimer(timerId, {
        success: true,
        duration: Math.round(duration * 100) / 100,
        status: response.status
      });

      return response;

    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.endTimer(timerId, {
        success: false,
        duration: Math.round(duration * 100) / 100,
        error: errorMessage
      });

      logger.error(`HTTP request failed: ${method} ${url}`, error as Error, {
        operationId,
        serviceContext,
        attempts: retries + 1
      });

      return {
        success: false,
        status: 0,
        statusText: 'Request Failed',
        error: errorMessage,
        metadata: {
          duration: Math.round(duration * 100) / 100,
          retries: retries + 1,
          serviceCall: serviceContext ? {
            serviceName: serviceContext.serviceName,
            methodPath: serviceContext.methodPath.join('.')
          } : undefined
        }
      };
    }
  }

  /**
   * Execute HTTP request with retry logic
   */
  private async executeWithRetry<T>(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: any;
      timeout: number;
      retries: number;
    },
    operationId: string
  ): Promise<HttpResponse<T>> {
    const { method, headers, body, timeout, retries } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        logger.debug(`HTTP retry attempt ${attempt}/${retries} for ${method} ${url}`, {
          operationId,
          attempt,
          delay,
          lastError: lastError?.message
        });
        await this.sleep(delay);
      }

      try {
        const response = await this.executeRequest<T>(url, method, headers, body, timeout, operationId);

        if (response.success || this.isNonRetryableStatus(response.status)) {
          return response;
        } else {
          // Retry on server errors
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          logger.warn(`HTTP request returned retryable error: ${response.status} ${response.statusText}`, {
            operationId,
            attempt,
            status: response.status,
            statusText: response.statusText
          });
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn(`HTTP request attempt ${attempt + 1} failed`, {
          operationId,
          attempt,
          error: lastError.message
        });
      }
    }

    throw lastError || new Error('All retry attempts failed');
  }

  /**
   * Execute single HTTP request
   */
  private async executeRequest<T>(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    timeout: number,
    operationId: string
  ): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Tasker-HttpClient/1.0.0',
          'X-Operation-Id': operationId,
          ...headers
        },
        signal: controller.signal
      };

      if (body && method !== 'GET') {
        if (typeof body === 'object') {
          requestOptions.body = JSON.stringify(body);
        } else {
          requestOptions.body = body;
          if (requestOptions.headers) {
            const headers = requestOptions.headers as Record<string, string>;
            delete headers['Content-Type']; // Let browser set it
          }
        }
      }

      logger.debug(`Executing HTTP request: ${method} ${url}`, {
        operationId,
        headers: this.sanitizeHeaders(headers),
        hasBody: !!body
      });

      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseData: T | undefined;
      let responseError: string | undefined;

      try {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          responseData = await response.json();
        } else {
          const text = await response.text();
          if (text) {
            try {
              responseData = JSON.parse(text) as T;
            } catch {
              // Return as string if not JSON
              responseData = text as T;
            }
          }
        }
      } catch (parseError) {
        logger.warn(`Failed to parse response body`, {
          operationId,
          status: response.status,
          error: (parseError as Error).message
        });
        responseError = `Failed to parse response: ${(parseError as Error).message}`;
      }

      const httpResponse: HttpResponse<T> = {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        data: responseData,
        error: responseError,
        headers: responseHeaders
      };

      logger.debug(`HTTP response received: ${response.status} ${response.statusText}`, {
        operationId,
        success: httpResponse.success,
        hasData: !!responseData,
        dataSize: responseData ? JSON.stringify(responseData).length : 0
      });

      return httpResponse;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }

      throw error;
    }
  }

  /**
   * Handle FlowState external calls for automatic pause/resume
   */
  private async handleFlowStateCall(
    url: string,
    options: RequestOptions,
    operationId: string
  ): Promise<HttpResponse> {
    const { serviceContext } = options;

    if (!serviceContext) {
      throw new Error('FlowState call requires service context');
    }

    const { serviceName, methodPath, taskRunId, stackRunId } = serviceContext;
    const fetchUrl = `https://tasker-external-call/${serviceName}/${methodPath.join('.')}`;

    logger.info(`FlowState external call intercepted: ${serviceName}.${methodPath.join('.')}`, {
      operationId,
      serviceName,
      methodPath: methodPath.join('.'),
      taskRunId,
      stackRunId
    });

    // Store the FlowState context for later retrieval
    const context: FlowStateContext = {
      serviceName,
      methodPath,
      args: options.body ? [options.body] : [],
      taskRunId: taskRunId || 'unknown',
      stackRunId: stackRunId || 'unknown',
      fetchUrl
    };

    this.flowStateContexts.set(operationId, context);

    // Create a mock response that signals FlowState to pause
    const flowStateResponse = {
      id: `flowstate-pause-${operationId}`,
      success: true,
      status: 200,
      statusText: 'FlowState Pause',
      data: {
        __flowStatePaused: true,
        serviceName,
        methodPath,
        args: context.args,
        taskRunId,
        stackRunId,
        fetchUrl,
        operationId
      },
      timestamp: Date.now()
    };

    return {
      success: true,
      status: 200,
      statusText: 'FlowState Pause',
      data: flowStateResponse,
      metadata: {
        duration: 0,
        retries: 0,
        serviceCall: {
          serviceName,
          methodPath: methodPath.join('.')
        }
      }
    };
  }

  /**
   * Check if URL is a FlowState external call
   */
  private isFlowStateCall(url: string): boolean {
    return url.includes('tasker-external-call') || url.startsWith('https://tasker-external-call/');
  }

  /**
   * Check if HTTP status is non-retryable
   */
  private isNonRetryableStatus(status: number): boolean {
    // Don't retry on client errors (4xx) except for specific cases
    return (status >= 400 && status < 500) &&
           status !== 408 && // Request Timeout
           status !== 429 && // Too Many Requests
           status !== 422;   // Unprocessable Entity
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Sanitize headers for logging (remove sensitive data)
   */
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = [
      'authorization',
      'x-api-key',
      'service_role_key',
      'anon_key',
      'gapi_key'
    ];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Get FlowState context by operation ID
   */
  public getFlowStateContext(operationId: string): FlowStateContext | undefined {
    return this.flowStateContexts.get(operationId);
  }

  /**
   * Clear FlowState context
   */
  public clearFlowStateContext(operationId: string): void {
    this.flowStateContexts.delete(operationId);
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<HttpClientConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  public getConfig(): HttpClientConfig {
    return { ...this.config };
  }

  /**
   * Convenience method for GET requests
   */
  public async get<T = any>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  /**
   * Convenience method for POST requests
   */
  public async post<T = any>(url: string, data?: any, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body: data });
  }

  /**
   * Convenience method for PUT requests
   */
  public async put<T = any>(url: string, data?: any, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body: data });
  }

  /**
   * Convenience method for DELETE requests
   */
  public async delete<T = any>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }
}

// Export singleton instance
export const httpClient = HttpClient.getInstance();

// Export convenience functions
export const http = {
  request: <T = any>(url: string, options?: RequestOptions) => httpClient.request<T>(url, options),
  get: <T = any>(url: string, options?: Omit<RequestOptions, 'method'>) => httpClient.get<T>(url, options),
  post: <T = any>(url: string, data?: any, options?: Omit<RequestOptions, 'method' | 'body'>) => httpClient.post<T>(url, data, options),
  put: <T = any>(url: string, data?: any, options?: Omit<RequestOptions, 'method' | 'body'>) => httpClient.put<T>(url, data, options),
  delete: <T = any>(url: string, options?: Omit<RequestOptions, 'method'>) => httpClient.delete<T>(url, options)
};