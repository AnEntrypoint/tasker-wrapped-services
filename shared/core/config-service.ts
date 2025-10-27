/**
 * Unified Configuration Service
 * Consolidates all environment variable handling and configuration
 */

import * as dotenv from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

// Load environment variables
dotenv.config({ export: true });

// Environment types
export type Environment = 'development' | 'staging' | 'production';

// Database configuration interface
export interface DatabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  host: string;
  port: number;
}

// Service configuration interface
export interface ServiceConfig {
  name: string;
  port: number;
  baseUrl: string;
  environment: Environment;
  debug: boolean;
}

// Google API configuration
export interface GoogleApiConfig {
  key?: string;
  adminEmail?: string;
  customerId?: string;
  maxUsersPerDomain?: number;
  maxResultsPerUser?: number;
}

// Main configuration class
export class ConfigService {
  private static instance: ConfigService;
  private _environment: Environment;
  private _services: Map<string, ServiceConfig> = new Map();

  private constructor() {
    this._environment = this.determineEnvironment();
    this.initializeServices();
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  // Environment detection
  private determineEnvironment(): Environment {
    const env = Deno.env.get('DENO_ENV') || Deno.env.get('NODE_ENV') || 'development';
    return env as Environment;
  }

  private initializeServices(): void {
    const supabaseUrl = this.getSupabaseUrl();

    this._services.set('supabase', {
      name: 'supabase',
      port: 54321,
      baseUrl: supabaseUrl,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('tasks', {
      name: 'tasks',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/tasks`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('stack-processor', {
      name: 'stack-processor',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/simple-stack-processor`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('wrappedkeystore', {
      name: 'wrappedkeystore',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/wrappedkeystore`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('wrappedgapi', {
      name: 'wrappedgapi',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/wrappedgapi`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('wrappedsupabase', {
      name: 'wrappedsupabase',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/wrappedsupabase`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('wrappedopenai', {
      name: 'wrappedopenai',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/wrappedopenai`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('wrappedwebsearch', {
      name: 'wrappedwebsearch',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/wrappedwebsearch`,
      environment: this._environment,
      debug: this.isDebug
    });

    this._services.set('deno-executor', {
      name: 'deno-executor',
      port: 54321,
      baseUrl: `${supabaseUrl}/functions/v1/deno-executor`,
      environment: this._environment,
      debug: this.isDebug
    });
  }

  // Get environment variable with type safety and validation
  private getEnvVar(key: string, required = true, defaultValue?: string): string {
    const value = Deno.env.get(key);

    if (required && !value) {
      throw new Error(`Required environment variable ${key} is not set`);
    }

    return value || defaultValue || '';
  }

  // Get numeric environment variable
  private getEnvNumber(key: string, required = true, defaultValue?: number): number {
    const value = this.getEnvVar(key, required, defaultValue?.toString());
    const parsed = parseInt(value);

    if (isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be a valid number, got: ${value}`);
    }

    return parsed;
  }

  // Get boolean environment variable
  private getEnvBoolean(key: string, defaultValue = false): boolean {
    const value = this.getEnvVar(key, false);
    if (!value) return defaultValue;

    return value.toLowerCase() === 'true' || value === '1';
  }

  // Supabase URL resolution logic
  private getSupabaseUrl(): string {
    const extSupabaseUrl = this.getEnvVar('EXT_SUPABASE_URL', false);
    const supabaseUrl = this.getEnvVar('SUPABASE_URL', false);

    // If the URL is the edge functions URL, use the REST API URL instead for local dev
    if (extSupabaseUrl?.includes('127.0.0.1:8000')) {
      return 'http://localhost:54321';
    }

    if (supabaseUrl?.includes('127.0.0.1:8000')) {
      return 'http://localhost:54321';
    }

    return extSupabaseUrl || supabaseUrl || 'http://localhost:54321';
  }

  // Public configuration getters
  public get environment(): Environment {
    return this._environment;
  }

  public get isDevelopment(): boolean {
    return this._environment === 'development';
  }

  public get isProduction(): boolean {
    return this._environment === 'production';
  }

  public get isDebug(): boolean {
    return this.getEnvBoolean('DEBUG', this.isDevelopment);
  }

  // Database configuration
  public get database(): DatabaseConfig {
    const url = this.getSupabaseUrl();
    const port = this.getEnvNumber('SUPABASE_DB_PORT', false, 54322);

    return {
      url,
      anonKey: this.getEnvVar('SUPABASE_ANON_KEY') || this.getEnvVar('EXT_SUPABASE_ANON_KEY'),
      serviceRoleKey: this.getEnvVar('SUPABASE_SERVICE_ROLE_KEY') || this.getEnvVar('EXT_SUPABASE_SERVICE_ROLE_KEY'),
      host: this.getEnvVar('SUPABASE_DB_HOST', false, '127.0.0.1'),
      port
    };
  }

  // Service configuration
  public getService(serviceName: string): ServiceConfig | undefined {
    return this._services.get(serviceName);
  }

  public getAllServices(): ServiceConfig[] {
    return Array.from(this._services.values());
  }

  // Google API configuration
  public get googleApi(): GoogleApiConfig {
    return {
      key: this.getEnvVar('GAPI_KEY', false),
      adminEmail: this.getEnvVar('GAPI_ADMIN_EMAIL', false),
      customerId: this.getEnvVar('GAPI_CUSTOMER_ID', false),
      maxUsersPerDomain: this.getEnvNumber('GAPI_MAX_USERS_PER_DOMAIN', false, 500),
      maxResultsPerUser: this.getEnvNumber('GAPI_MAX_RESULTS_PER_USER', false, 100)
    };
  }

  // Logging configuration
  public get logging(): {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
    enableConsole: boolean;
  } {
    const level = this.getEnvVar('LOG_LEVEL', false, this.isDebug ? 'debug' : 'info') as any;
    const format = this.getEnvVar('LOG_FORMAT', false, 'text') as any;
    const enableConsole = this.getEnvBoolean('LOG_CONSOLE', true);

    return { level, format, enableConsole };
  }

  // Task processing configuration
  public get taskProcessing(): {
    maxConcurrentTasks: number;
    taskTimeout: number;
    retryAttempts: number;
    retryDelay: number;
  } {
    return {
      maxConcurrentTasks: this.getEnvNumber('MAX_CONCURRENT_TASKS', false, 5),
      taskTimeout: this.getEnvNumber('TASK_TIMEOUT', false, 300000), // 5 minutes
      retryAttempts: this.getEnvNumber('TASK_RETRY_ATTEMPTS', false, 3),
      retryDelay: this.getEnvNumber('TASK_RETRY_DELAY', false, 1000) // 1 second
    };
  }

  // HTTP client configuration
  public get http(): {
    timeout: number;
    retries: number;
    retryDelay: number;
  } {
    return {
      timeout: this.getEnvNumber('HTTP_TIMEOUT', false, 30000), // 30 seconds
      retries: this.getEnvNumber('HTTP_RETRIES', false, 3),
      retryDelay: this.getEnvNumber('HTTP_RETRY_DELAY', false, 1000) // 1 second
    };
  }

  // Validation helper
  public validate(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      this.database;
    } catch (error: any) {
      errors.push(`Database configuration: ${error?.message || 'Unknown error'}`);
    }

    try {
      this.googleApi;
    } catch (error: any) {
      errors.push(`Google API configuration: ${error?.message || 'Unknown error'}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  // Debug information
  public getDebugInfo(): Record<string, any> {
    return {
      environment: this._environment,
      services: Object.fromEntries(this._services),
      database: {
        url: this.database.url,
        hasKeys: !!(this.database.anonKey && this.database.serviceRoleKey)
      },
      googleApi: {
        hasKey: !!this.googleApi.key,
        hasAdminEmail: !!this.googleApi.adminEmail
      },
      validation: this.validate()
    };
  }
}

// Export singleton instance
export const config = ConfigService.getInstance();

// Export convenience functions for backward compatibility
export const getSupabaseUrl = (): string => config.database.url;
export const getSupabaseAnonKey = (): string => config.database.anonKey;
export const getSupabaseServiceRoleKey = (): string => config.database.serviceRoleKey;
export const isDevelopment = (): boolean => config.isDevelopment;
export const isProduction = (): boolean => config.isProduction;
export const isDebug = (): boolean => config.isDebug;