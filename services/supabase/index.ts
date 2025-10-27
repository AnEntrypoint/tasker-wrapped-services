import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { BaseHttpHandler, HttpStatus, createHealthCheckResponse } from "../_shared/http-handler.ts";
import { config } from "../_shared/config-service.ts";
import { BaseService, ServiceOperation, ServiceError, ServiceErrorType } from "../_shared/base-service.ts";

/**
 * Supabase wrapper service implementation
 * This provides a proxy interface for Supabase database operations
 */
class SupabaseService extends BaseService {
  private supabaseClient: any;

  constructor() {
    super({
      name: 'wrappedsupabase',
      version: '1.0.0',
      description: 'Supabase database operations wrapper',
      enableHealthCheck: true,
      enablePerformanceLogging: true,
      timeout: 30000,
      retries: 3
    });

    this.supabaseClient = this.createSupabaseClient();
  }

  public getOperations(): string[] {
    return [
      'executeQuery',
      'processChain',
      'getClient'
    ];
  }

  private createSupabaseClient(): any {
    const targetSupabaseUrl = config.database.url;
    const serviceRoleKey = config.database.serviceRoleKey;

    if (!targetSupabaseUrl) {
      throw new ServiceError(
        ServiceErrorType.CONFIGURATION_ERROR,
        "Supabase URL not configured correctly",
        'MISSING_SUPABASE_URL'
      );
    }

    if (!serviceRoleKey) {
      throw new ServiceError(
        ServiceErrorType.CONFIGURATION_ERROR,
        "Service Role Key not found",
        'MISSING_SERVICE_ROLE_KEY'
      );
    }

    return createClient(targetSupabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });
  }

  async processChain(chain: any[]): Promise<any> {
    return this.executeOperation(
      'processChain',
      async () => {
        if (!Array.isArray(chain) || chain.length === 0) {
          throw new ServiceError(
            ServiceErrorType.VALIDATION_ERROR,
            'Invalid request format - expected chain array',
            'INVALID_CHAIN_FORMAT',
            { chain }
          );
        }

        let result = this.supabaseClient;

        // Process the chain manually
        for (const step of chain) {
          if (step.property && typeof result[step.property] === 'function') {
            const args = step.args || [];
            result = result[step.property](...args);
          } else {
            throw new ServiceError(
              ServiceErrorType.VALIDATION_ERROR,
              `Method ${step.property} not found or not a function`,
              'METHOD_NOT_FOUND',
              { method: step.property }
            );
          }
        }

        // Execute the final result if it's a promise
        const finalResult = await result;

        // Check if the result has an error (Supabase error format)
        if (finalResult && finalResult.error) {
          const errorMessage = finalResult.error.message || 'Database operation failed';
          const errorDetails = finalResult.error.details || finalResult.error.hint || '';
          const fullMessage = errorDetails ? `${errorMessage}: ${errorDetails}` : errorMessage;

          throw new ServiceError(
            ServiceErrorType.INTERNAL_ERROR,
            fullMessage,
            'DATABASE_ERROR',
            { error: finalResult.error, chain }
          );
        }

        return finalResult;
      },
      { chainLength: chain.length }
    );
  }

  protected async performHealthCheck(): Promise<IHealthCheckResult> {
    const baseHealth = await super.performHealthCheck();

    try {
      // Test database connectivity
      const result = await this.supabaseClient
        .from('task_functions')
        .select('id')
        .limit(1);

      if (result.error) {
        throw new Error(`Database test query failed: ${result.error.message}`);
      }

      baseHealth.details!.database = {
        healthy: true,
        message: 'Database connectivity verified'
      };
    } catch (error) {
      baseHealth.status = 'unhealthy';
      baseHealth.details!.database = {
        healthy: false,
        error: (error as Error).message
      };
      baseHealth.error = `Database health check failed: ${(error as Error).message}`;
    }

    return baseHealth;
  }
}

// Create supabase service instance
const supabaseService = new SupabaseService();

// Supabase HTTP Handler
class WrappedSupabaseHandler extends BaseHttpHandler {
  protected async routeHandler(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    // Enhanced health check endpoint
    if (req.method === "GET" && path === "/health") {
      try {
        const healthCheck = await supabaseService.getHealthCheck();
        return createHealthCheckResponse("wrappedsupabase", healthCheck.status, healthCheck.details);
      } catch (error) {
        return createHealthCheckResponse("wrappedsupabase", "unhealthy", {
          error: (error as Error).message
        });
      }
    }

    // Handle POST requests with chain processing
    if (req.method === 'POST') {
      const body = await this.parseRequestBody(req);

      try {
        if (body.chain && Array.isArray(body.chain)) {
          const result = await supabaseService.processChain(body.chain);
          return this.createSuccessResponse(result);
        } else {
          throw new ServiceError(
            ServiceErrorType.VALIDATION_ERROR,
            'Invalid request format - expected chain array',
            'INVALID_CHAIN_FORMAT',
            { body }
          );
        }
      } catch (error) {
        const err = error instanceof ServiceError ? error : new ServiceError(
          ServiceErrorType.INTERNAL_ERROR,
          (error as Error).message,
          'PROCESSING_ERROR'
        );
        return this.createErrorResponse(
          err.message,
          err.statusCode || HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    }

    return this.createErrorResponse("Method not allowed", HttpStatus.METHOD_NOT_ALLOWED);
  }
}

// Create handler instance and start serving
const wrappedSupabaseHandler = new WrappedSupabaseHandler();
const port = parseInt(Deno.env.get('PORT') || '8002');
console.log(`Starting wrappedsupabase service on port ${port}...`);
serve((req) => wrappedSupabaseHandler.handle(req), { port });