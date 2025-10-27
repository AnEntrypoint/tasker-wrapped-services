import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { serviceRegistry } from "../_shared/service-registry.ts";
import { BaseHttpHandler, HttpStatus, createHealthCheckResponse } from "../_shared/http-handler.ts";
import { config } from "../_shared/config-service.ts";
import { BaseService, ServiceError, ServiceErrorType } from "../_shared/base-service.ts";
import { logger } from "../_shared/logging-service.ts";

// Type definitions
interface IServerTimeResult {
  timestamp: string;
  source: string;
}

interface IKeyStoreValue {
  key_name: string;
  key_value: string;
  scope?: string;
  updated_at?: string;
}

/**
 * Keystore service implementation
 * This provides a simple key-value store backed by Supabase
 */
class KeystoreService extends BaseService {
  private wrappedSupabaseUrl: string;
  private serviceRoleKey: string;

  constructor() {
    super({
      name: 'keystore',
      version: '1.0.0',
      description: 'Key-value store service backed by Supabase',
      enableHealthCheck: true,
      enablePerformanceLogging: true,
      timeout: 30000,
      retries: 3
    });

    const supabaseUrl = config.database.url;
    const serviceRoleKey = config.database.serviceRoleKey;

    if (!serviceRoleKey) {
      throw new ServiceError(
        ServiceErrorType.CONFIGURATION_ERROR,
        "SUPABASE_SERVICE_ROLE_KEY environment variable is required",
        'MISSING_SERVICE_ROLE_KEY'
      );
    }

    // Use wrappedsupabase proxy as the only way to access Supabase
    this.wrappedSupabaseUrl = `${supabaseUrl}/functions/v1/wrappedsupabase`;
    this.serviceRoleKey = serviceRoleKey;
  }

  public getOperations(): string[] {
    return [
      'getKey',
      'setKey',
      'listKeys',
      'hasKey',
      'listNamespaces',
      'getServerTime'
    ];
  }

  private async callWrappedSupabase(chain: any[]): Promise<any> {
    return this.executeOperation(
      'callWrappedSupabase',
      async () => {
        const response = await fetch(this.wrappedSupabaseUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.serviceRoleKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ chain })
        });

        if (!response.ok) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `wrappedsupabase HTTP call failed: ${response.status} ${response.statusText}`,
            'WRAPPED_SUPABASE_HTTP_ERROR',
            { status: response.status }
          );
        }

        const result = await response.json();
        logger.info(`callWrappedSupabase got result:`, { result });

        if (!result.success || !result.data) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `wrappedsupabase call failed: ${result.error || 'Unknown error'}`,
            'WRAPPED_SUPABASE_ERROR',
            { error: result.error }
          );
        }

        const innerResult = result.data;
        logger.info(`callWrappedSupabase got innerResult:`, { innerResult });

        if (!innerResult.success || innerResult.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `wrappedsupabase data error: ${innerResult.error?.message || 'Unknown error'}`,
            'WRAPPED_SUPABASE_DATA_ERROR',
            { error: innerResult.error }
          );
        }

        const returnValue = innerResult.data;
        logger.info(`callWrappedSupabase returning:`, { returnValue });
        return returnValue;
      }
    );
  }
  

  // Get a stored key value
  async getKey(namespace: string, key: string): Promise<string | null> {
    return this.executeOperation(
      'getKey',
      async () => {
        const wrappedResponse = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'select', args: ['key_value'] },
          { property: 'eq', args: ['key_name', key] },
          { property: 'limit', args: [1] }
        ]);

        // callWrappedSupabase is wrapped by executeOperation, so unwrap it
        const supabaseResponse = wrappedResponse.data;

        if (supabaseResponse.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed to get key: ${supabaseResponse.error}`,
            'GET_KEY_ERROR',
            { key, namespace, originalError: supabaseResponse.error }
          );
        }

        const rows = supabaseResponse.data;
        if (rows && rows.length > 0) {
          return rows[0].key_value;
        }

        return null;
      },
      { key, namespace }
    );
  }
  
  // Store a key value
  async setKey(namespace: string, key: string, value: string): Promise<boolean> {
    return this.executeOperation(
      'setKey',
      async () => {
        // Check if the key exists
        const wrappedCheckResult = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'select', args: ['id'] },
          { property: 'eq', args: ['key_name', key] },
          { property: 'limit', args: [1] }
        ]);

        const checkResult = wrappedCheckResult.data;

        if (checkResult.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed during existence check: ${checkResult.error}`,
            'SET_KEY_EXISTENCE_CHECK_ERROR',
            { key, namespace, originalError: checkResult.error }
          );
        }

        const exists = checkResult.data && checkResult.data.length > 0;

        let wrappedResult;
        if (exists) {
          // Update existing key
          wrappedResult = await this.callWrappedSupabase([
            { property: 'from', args: ['keystore'] },
            { property: 'update', args: [{ key_value: value, updated_at: new Date().toISOString() }] },
            { property: 'eq', args: ['key_name', key] }
          ]);
        } else {
          // Insert new key
          wrappedResult = await this.callWrappedSupabase([
            { property: 'from', args: ['keystore'] },
            { property: 'insert', args: [{ key_name: key, key_value: value }] }
          ]);
        }

        const result = wrappedResult.data;

        if (result.error) {
          const action = exists ? 'update' : 'insert';
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed to ${action} key: ${result.error}`,
            `${action.toUpperCase()}_KEY_ERROR`,
            { key, namespace, action, originalError: result.error }
          );
        }

        return true;
      },
      { key, namespace, value }
    );
  }
  
  // List all keys in a namespace
  async listKeys(namespace: string): Promise<string[]> {
    return this.executeOperation(
      'listKeys',
      async () => {
        const wrappedResult = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'select', args: ['key_name'] }
        ]);

        const result = wrappedResult.data;

        if (result.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed to list keys: ${result.error}`,
            'LIST_KEYS_ERROR',
            { namespace, originalError: result.error }
          );
        }

        return result.data?.length ? result.data.map((row: any) => row.key_name) : [];
      },
      { namespace }
    );
  }
  
  // Check if a key exists in a namespace
  async hasKey(namespace: string, key: string): Promise<boolean> {
    return this.executeOperation(
      'hasKey',
      async () => {
        const wrappedResult = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'select', args: ['id'] },
          { property: 'eq', args: ['key_name', key] },
          { property: 'limit', args: [1] }
        ]);

        const result = wrappedResult.data;

        if (result.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed to check key existence: ${result.error}`,
            'HAS_KEY_ERROR',
            { key, namespace, originalError: result.error }
          );
        }

        return result.data && result.data.length > 0;
      },
      { key, namespace }
    );
  }
  
  // List all namespaces
  async listNamespaces(): Promise<string[]> {
    return this.executeOperation(
      'listNamespaces',
      async () => {
        const wrappedResult = await this.callWrappedSupabase([
          { property: 'from', args: ['keystore'] },
          { property: 'select', args: ['scope'] }
        ]);

        const result = wrappedResult.data;

        if (result.error) {
          throw new ServiceError(
            ServiceErrorType.EXTERNAL_SERVICE_ERROR,
            `Failed to list namespaces: ${result.error}`,
            'LIST_NAMESPACES_ERROR',
            { originalError: result.error }
          );
        }

        if (result.data?.length) {
          const namespaces = new Set<string>();
          result.data.forEach((row: any) => {
            if (row.scope) namespaces.add(row.scope);
          });
          return Array.from(namespaces);
        }

        // Return default namespaces if none found
        return ['global', 'openai'];
      }
    );
  }
  
  // Get the current server time
  getServerTime(): IServerTimeResult {
    const timestamp = new Date().toISOString();
    return { timestamp, source: "keystore" };
  }

  // Enhanced health check for keystore service
  protected async performHealthCheck(): Promise<IHealthCheckResult> {
    const baseHealth = await super.performHealthCheck();

    try {
      // Test keystore functionality
      const testKey = `health_check_${Date.now()}`;
      await this.setKey('health', testKey, 'test_value');
      const retrievedValue = await this.getKey('health', testKey);
      await this.callWrappedSupabase([
        { property: 'from', args: ['keystore'] },
        { property: 'delete' },
        { property: 'eq', args: ['key_name', testKey] }
      ]);

      if (retrievedValue !== 'test_value') {
        throw new Error('Keystore functionality test failed');
      }

      baseHealth.details!.keystore = { healthy: true, message: 'Functionality test passed' };
    } catch (error) {
      baseHealth.status = 'unhealthy';
      baseHealth.details!.keystore = {
        healthy: false,
        error: (error as Error).message
      };
      baseHealth.error = `Keystore health check failed: ${(error as Error).message}`;
    }

    return baseHealth;
  }
}

// Create keystore service instance
const keystoreService = new KeystoreService();

// Enhanced Keystore HTTP Handler
class KeystoreHttpHandler extends BaseHttpHandler {
  protected async routeHandler(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    // Enhanced health check endpoint
    if (req.method === "GET" && path === "/health") {
      try {
        const healthCheck = await keystoreService.getHealthCheck();
        return createHealthCheckResponse("keystore", healthCheck.status, healthCheck.details);
      } catch (error) {
        return createHealthCheckResponse("keystore", "unhealthy", {
          error: (error as Error).message
        });
      }
    }

    // Generic SDK proxy endpoint
    if (req.method === "POST") {
      const body = await this.parseRequestBody(req);

      try {
        let result;

        // Handle both action and chain formats
        if (body.action) {
          // Map action to method calls
          switch (body.action) {
            case "getKey":
              result = await keystoreService.getKey(body.namespace || 'global', body.key);
              break;
            case "setKey":
              result = await keystoreService.setKey(body.namespace || 'global', body.key, body.value);
              break;
            case "listKeys":
              result = await keystoreService.listKeys(body.namespace || 'global');
              break;
            case "hasKey":
              result = await keystoreService.hasKey(body.namespace || 'global', body.key);
              break;
            case "listNamespaces":
              result = await keystoreService.listNamespaces();
              break;
            case "getServerTime":
              result = keystoreService.getServerTime();
              break;
            default:
              throw new Error(`Unknown action: ${body.action}`);
          }
        }
        // Handle chain format manually (no executeMethodChain import)
        else if (body.chain) {
          // Execute method chain manually
          let current: any = keystoreService;
          for (const step of body.chain) {
            if (typeof current[step.property] === 'function') {
              current = await current[step.property](...(step.args || []));
            } else {
              throw new Error(`Method '${step.property}' not found or not callable`);
            }
          }
          result = current;
        }
        else {
          throw new Error("Request must include either 'action' or 'chain' property");
        }

        return this.createSuccessResponse(result);
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        return this.createErrorResponse(
          err.message,
          (err as any).status || HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    }

    // Not found response
    return this.createErrorResponse("Not found", HttpStatus.NOT_FOUND);
  }
}

// Create handler instance and start serving
const keystoreHandler = new KeystoreHttpHandler();
const port = parseInt(Deno.env.get('PORT') || '8003');
console.log(`Starting keystore service on port ${port}...`);
serve((req) => keystoreHandler.handle(req), { port });