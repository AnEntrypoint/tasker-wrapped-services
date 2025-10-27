/**
 * Unified HTTP Handler for all Edge Functions
 * Consolidates CORS, response formatting, and error handling
 */

import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";

// Standardized response interfaces
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  logs?: string[];
  timestamp?: string;
}

export interface PaginationInfo {
  page?: number;
  limit?: number;
  total?: number;
  offset?: number;
}

// Standardized CORS headers
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE, PATCH'
};

// HTTP status codes with semantic meaning
export enum HttpStatus {
  OK = 200,
  CREATED = 201,
  NO_CONTENT = 204,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  CONFLICT = 409,
  UNPROCESSABLE_ENTITY = 422,
  INTERNAL_SERVER_ERROR = 500,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503
}

// Base HTTP Handler class
export abstract class BaseHttpHandler {
  protected abstract routeHandler(req: Request, url: URL): Promise<Response>;

  // Main handler method with CORS and error handling
  public async handle(req: Request): Promise<Response> {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      return this.createCorsResponse();
    }

    try {
      const url = new URL(req.url);
      return await this.routeHandler(req, url);
    } catch (error) {
      return this.handleError(error, `Unhandled error in ${this.constructor.name}`);
    }
  }

  // Standardized CORS response
  protected createCorsResponse(status = 200): Response {
    return new Response(null, { status, headers: CORS_HEADERS });
  }

  // Standardized success response
  protected createSuccessResponse<T>(
    data: T,
    status = HttpStatus.OK,
    logs?: string[],
    pagination?: PaginationInfo
  ): Response {
    const response: ApiResponse<T> = {
      success: true,
      data,
      timestamp: new Date().toISOString()
    };

    if (logs && logs.length > 0) {
      response.logs = logs;
    }

    if (pagination) {
      (response.data as any).pagination = pagination;
    }

    return new Response(JSON.stringify(response), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS
      }
    });
  }

  // Standardized error response
  protected createErrorResponse(
    message: string,
    status = HttpStatus.INTERNAL_SERVER_ERROR,
    logs?: string[],
    details?: Record<string, any>
  ): Response {
    const response: ApiResponse = {
      success: false,
      error: message,
      timestamp: new Date().toISOString()
    };

    if (logs && logs.length > 0) {
      response.logs = logs;
    }

    if (details) {
      (response as any).details = details;
    }

    return new Response(JSON.stringify(response), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS
      }
    });
  }

  // Centralized error handling
  protected handleError(error: unknown, context = 'Unknown error'): Response {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetails = {
      context,
      type: error instanceof Error ? error.constructor.name : 'Unknown',
      timestamp: new Date().toISOString()
    };

    console.error(`[${this.constructor.name}] ${context}:`, error);

    // Don't expose internal errors in production
    const isDevelopment = Deno.env.get('DENO_ENV') !== 'production';
    const userMessage = isDevelopment ? errorMessage : 'Internal server error';

    return this.createErrorResponse(
      userMessage,
      HttpStatus.INTERNAL_SERVER_ERROR,
      undefined,
      isDevelopment ? errorDetails : undefined
    );
  }

  // Validation helper for required fields
  protected validateRequired(body: any, requiredFields: string[]): string[] {
    const missing: string[] = [];

    for (const field of requiredFields) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        missing.push(field);
      }
    }

    return missing;
  }

  // Parse request body with error handling
  protected async parseRequestBody(req: Request): Promise<any> {
    try {
      return await req.json();
    } catch (error) {
      throw new Error('Invalid JSON in request body');
    }
  }

  // Get query parameters with type safety
  protected getQueryParams(url: URL): Record<string, string> {
    const params: Record<string, string> = {};

    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }

    return params;
  }

  // Get pagination info from query params
  protected getPaginationInfo(url: URL): Required<PaginationInfo> {
    const params = this.getQueryParams(url);

    return {
      page: Math.max(1, parseInt(params.page || '1')),
      limit: Math.min(100, Math.max(1, parseInt(params.limit || '10'))),
      total: 0, // To be filled by the calling code
      offset: Math.max(0, (parseInt(params.page || '1') - 1) * Math.min(100, Math.max(1, parseInt(params.limit || '10'))))
    };
  }
}

// Generic HTTP handler creator for simple endpoints
export function createSimpleHandler(
  handler: (req: Request, url: URL) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(req.url);
      return await handler(req, url);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Simple handler error:', error);

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
          timestamp: new Date().toISOString()
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS
          }
        }
      );
    }
  };
}

// Health check helper
export function createHealthCheckResponse(serviceName: string, status: 'healthy' | 'unhealthy' = 'healthy', details?: Record<string, any>): Response {
  const response = {
    success: true,
    data: {
      service: serviceName,
      status,
      timestamp: new Date().toISOString(),
      ...details
    }
  };

  return new Response(JSON.stringify(response), {
    status: status === 'healthy' ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}