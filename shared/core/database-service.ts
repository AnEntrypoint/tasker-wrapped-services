/**
 * Unified Database Service
 *
 * Consolidates all database operations and eliminates duplicate query patterns.
 * Provides standardized query methods with error handling, connection pooling,
 * retry logic, transaction support, and performance monitoring.
 */

import { createClient, SupabaseClient, PostgrestSingleResponse, PostgrestResponse } from 'https://esm.sh/@supabase/supabase-js@2';
import { ConfigService, DatabaseConfig } from './config-service.ts';
import { logger, perf, context } from './logging-service.ts';

// Database connection pool interface
interface ConnectionPool {
  client: SupabaseClient;
  inUse: boolean;
  created: number;
  lastUsed: number;
}

// Query options interface
export interface QueryOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  enablePerformanceLogging?: boolean;
  context?: Record<string, any>;
}

// Transaction callback type
export type TransactionCallback<T> = (client: SupabaseClient) => Promise<T>;

// Database query result type
export type DatabaseResult<T> = {
  data: T | null;
  error: Error | null;
  success: boolean;
  performance?: {
    duration: number;
    operation: string;
    retryCount: number;
  };
};

// Table types
export type TaskRun = {
  id: string;
  task_function_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'suspended_waiting_child';
  result?: any;
  error?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  suspended_at?: string;
  resume_payload?: any;
};

export type StackRun = {
  id: string;
  task_run_id: string;
  parent_stack_run_id?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  function_name: string;
  parameters?: any;
  result?: any;
  error?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  waiting?: boolean;
  waiting_on_stack_run_id?: string;
};

export type TaskFunction = {
  id: string;
  name: string;
  description?: string;
  code: string;
  created_at: string;
  updated_at: string;
};

export type KeyStoreEntry = {
  id: string;
  key: string;
  value: any;
  created_at: string;
  updated_at: string;
};

/**
 * Main Database Service class
 */
export class DatabaseService {
  private static instance: DatabaseService;
  private config: ConfigService;
  private connectionPool: ConnectionPool[] = [];
  private maxPoolSize = 10;
  private connectionTimeout = 30000; // 30 seconds
  private defaultRetries = 3;
  private defaultRetryDelay = 1000; // 1 second

  private constructor() {
    this.config = ConfigService.getInstance();
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  /**
   * Get database configuration
   */
  public get databaseConfig(): DatabaseConfig {
    return this.config.database;
  }

  /**
   * Create a Supabase client with proper configuration
   */
  public createClient(serviceRole = true): SupabaseClient {
    const dbConfig = this.databaseConfig;
    const key = serviceRole ? dbConfig.serviceRoleKey : dbConfig.anonKey;

    if (!dbConfig.url || !key) {
      throw new Error('Missing database configuration (URL or authentication key)');
    }

    return createClient(dbConfig.url, key, {
      auth: { persistSession: false },
      db: {
        schema: 'public'
      }
    });
  }

  /**
   * Get a database client from the connection pool
   */
  public async getClient(): Promise<SupabaseClient> {
    // Try to reuse an existing connection
    const availableConnection = this.connectionPool.find(conn => !conn.inUse);

    if (availableConnection) {
      availableConnection.inUse = true;
      availableConnection.lastUsed = Date.now();
      logger.debug('Reusing database connection from pool', {
        connectionId: availableConnection.client.toString()
      });
      return availableConnection.client;
    }

    // Create new connection if pool not full
    if (this.connectionPool.length < this.maxPoolSize) {
      const client = this.createClient();
      const connection: ConnectionPool = {
        client,
        inUse: true,
        created: Date.now(),
        lastUsed: Date.now()
      };

      this.connectionPool.push(connection);
      logger.debug('Created new database connection', {
        poolSize: this.connectionPool.length
      });
      return client;
    }

    // Pool is full, wait for available connection
    logger.warn('Connection pool exhausted, waiting for available connection');
    await this.waitForAvailableConnection();
    return this.getClient();
  }

  /**
   * Release a database client back to the pool
   */
  public releaseClient(client: SupabaseClient): void {
    const connection = this.connectionPool.find(conn => conn.client === client);
    if (connection) {
      connection.inUse = false;
      connection.lastUsed = Date.now();
      logger.debug('Released database connection back to pool');
    }
  }

  /**
   * Wait for an available connection
   */
  private async waitForAvailableConnection(): Promise<void> {
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max wait

    while (attempts < maxAttempts) {
      const availableConnection = this.connectionPool.find(conn => !conn.inUse);
      if (availableConnection) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    throw new Error('Timeout waiting for available database connection');
  }

  /**
   * Execute a database query with retry logic and performance monitoring
   */
  public async executeQuery<T>(
    operation: string,
    queryFn: (client: SupabaseClient) => Promise<PostgrestResponse<T> | PostgrestSingleResponse<T>>,
    options: QueryOptions = {}
  ): Promise<DatabaseResult<T>> {
    const {
      timeout = this.connectionTimeout,
      retries = this.defaultRetries,
      retryDelay = this.defaultRetryDelay,
      enablePerformanceLogging = true,
      context: queryContext = {}
    } = options;

    const timerId = perf.start(`db.${operation}`);
    let retryCount = 0;
    let lastError: Error | null = null;

    // Add query context
    const queryId = crypto.randomUUID();

    logger.debug(`Executing database operation: ${operation}`, {
      queryId,
      timeout,
      retries,
      ...queryContext
    });

    while (retryCount <= retries) {
      try {
        const client = await this.getClient();

        // Add timeout to the query
        const queryPromise = queryFn(client);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Query timeout')), timeout);
        });

        const result = await Promise.race([queryPromise, timeoutPromise]);

        this.releaseClient(client);

        // Check for database errors
        if (result.error) {
          throw new Error(`Database error: ${result.error.message} (code: ${result.error.code})`);
        }

        const duration = perf.end(timerId);

        if (enablePerformanceLogging) {
          logger.info(`Database operation completed: ${operation}`, {
            queryId,
            duration,
            retryCount,
            hasData: !!result.data,
            dataLength: Array.isArray(result.data) ? result.data.length : 1
          });
        }

        return {
          data: result.data,
          error: null,
          success: true,
          performance: {
            duration,
            operation,
            retryCount
          }
        };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;

        logger.warn(`Database operation failed (attempt ${retryCount}/${retries + 1}): ${operation}`, {
          queryId,
          error: lastError.message,
          retryCount,
          willRetry: retryCount <= retries
        });

        if (retryCount <= retries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * retryCount));
        }
      }
    }

    // All retries exhausted
    const duration = perf.end(timerId);
    logger.error(`Database operation failed after ${retries + 1} attempts: ${operation}`, {
      queryId,
      duration,
      finalError: lastError?.message
    });

    return {
      data: null,
      error: lastError,
      success: false,
      performance: {
        duration,
        operation,
        retryCount
      }
    };
  }

  /**
   * Execute multiple operations in a transaction-like manner
   */
  public async executeTransaction<T>(
    operations: Array<{
      operation: string;
      queryFn: (client: SupabaseClient) => Promise<any>;
    }>,
    options: QueryOptions = {}
  ): Promise<DatabaseResult<T[]>> {
    const transactionTimerId = perf.start('db.transaction');
    const transactionId = crypto.randomUUID();

    logger.info(`Starting database transaction with ${operations.length} operations`, {
      transactionId,
      operations: operations.map(op => op.operation)
    });

    const results: any[] = [];
    let client: SupabaseClient;

    try {
      client = await this.getClient();

      for (const { operation, queryFn } of operations) {
        const result = await this.executeQuery(
          `${operation}`,
          () => queryFn(client),
          { ...options, enablePerformanceLogging: false }
        );

        if (!result.success) {
          throw result.error;
        }

        results.push(result.data);
      }

      this.releaseClient(client);
      const duration = perf.end(transactionTimerId);

      logger.info(`Database transaction completed successfully`, {
        transactionId,
        duration,
        operationCount: operations.length
      });

      return {
        data: results,
        error: null,
        success: true,
        performance: {
          duration,
          operation: 'transaction',
          retryCount: 0
        }
      };

    } catch (error) {
      if (client) {
        this.releaseClient(client);
      }

      const duration = perf.end(transactionTimerId);
      const err = error instanceof Error ? error : new Error(String(error));

      logger.error(`Database transaction failed`, {
        transactionId,
        duration,
        error: err.message,
        operationsCompleted: results.length
      });

      return {
        data: null,
        error: err,
        success: false,
        performance: {
          duration,
          operation: 'transaction',
          retryCount: 0
        }
      };
    }
  }

  /**
   * Fetch task from database by ID or name (consolidated function)
   */
  public async fetchTaskFromDatabase(
    taskIdOrName: string,
    taskId: string | null = null,
    options: QueryOptions = {}
  ): Promise<TaskFunction | null> {
    logger.info(`Fetching task from database: ${taskIdOrName}`, { taskId });

    let queryBuilder = (client: SupabaseClient) => {
      let query = client.from('task_functions').select('*');

      if (taskId && this.isUuid(taskId)) {
        query = query.eq('id', taskId);
      } else {
        const searchTerm = taskIdOrName;
        query = query.eq('name', searchTerm);
      }

      return query.limit(1).single();
    };

    const result = await this.executeQuery<TaskFunction>(
      'fetchTaskFromDatabase',
      queryBuilder,
      options
    );

    if (result.success && result.data) {
      logger.info(`Task found: ${result.data.name} (id: ${result.data.id})`);
      return result.data;
    } else {
      logger.warn(`No task found for ${taskIdOrName}`, {
        error: result.error?.message
      });
      return null;
    }
  }

  /**
   * Query builders for common operations
   */

  // Task Run operations
  public createTaskRun(taskFunctionId: string): Promise<DatabaseResult<TaskRun>> {
    return this.executeQuery(
      'createTaskRun',
      (client) => client.from('task_runs').insert({
        task_function_id: taskFunctionId,
        status: 'pending'
      }).select().single()
    );
  }

  public getTaskRun(taskRunId: string): Promise<DatabaseResult<TaskRun>> {
    return this.executeQuery(
      'getTaskRun',
      (client) => client.from('task_runs').select('*').eq('id', taskRunId).single()
    );
  }

  public updateTaskRun(taskRunId: string, updates: Partial<TaskRun>): Promise<DatabaseResult<TaskRun>> {
    return this.executeQuery(
      'updateTaskRun',
      (client) => client.from('task_runs').update(updates).eq('id', taskRunId).select().single()
    );
  }

  public getPendingTaskRuns(): Promise<DatabaseResult<TaskRun[]>> {
    return this.executeQuery(
      'getPendingTaskRuns',
      (client) => client.from('task_runs').select('*').eq('status', 'pending').order('created_at')
    );
  }

  // Stack Run operations
  public createStackRun(stackRun: Omit<StackRun, 'id' | 'created_at' | 'updated_at'>): Promise<DatabaseResult<StackRun>> {
    return this.executeQuery(
      'createStackRun',
      (client) => client.from('stack_runs').insert(stackRun).select().single()
    );
  }

  public getStackRun(stackRunId: string): Promise<DatabaseResult<StackRun>> {
    return this.executeQuery(
      'getStackRun',
      (client) => client.from('stack_runs').select('*').eq('id', stackRunId).single()
    );
  }

  public updateStackRun(stackRunId: string, updates: Partial<StackRun>): Promise<DatabaseResult<StackRun>> {
    return this.executeQuery(
      'updateStackRun',
      (client) => client.from('stack_runs').update(updates).eq('id', stackRunId).select().single()
    );
  }

  public getPendingStackRuns(): Promise<DatabaseResult<StackRun[]>> {
    return this.executeQuery(
      'getPendingStackRuns',
      (client) => client.from('stack_runs').select('*').eq('status', 'pending').order('created_at')
    );
  }

  public getChildStackRuns(parentStackRunId: string): Promise<DatabaseResult<StackRun[]>> {
    return this.executeQuery(
      'getChildStackRuns',
      (client) => client.from('stack_runs').select('*').eq('parent_stack_run_id', parentStackRunId).order('created_at')
    );
  }

  // KeyStore operations
  public getKeyValue(key: string): Promise<DatabaseResult<KeyStoreEntry>> {
    return this.executeQuery(
      'getKeyValue',
      (client) => client.from('keystore').select('*').eq('key', key).single()
    );
  }

  public setKeyValue(key: string, value: any): Promise<DatabaseResult<KeyStoreEntry>> {
    return this.executeQuery(
      'setKeyValue',
      (client) => client.from('keystore').upsert({ key, value }).select().single()
    );
  }

  public deleteKey(key: string): Promise<DatabaseResult<void>> {
    return this.executeQuery(
      'deleteKey',
      (client) => client.from('keystore').delete().eq('key', key)
    );
  }

  // Task Function operations
  public getAllTaskFunctions(): Promise<DatabaseResult<TaskFunction[]>> {
    return this.executeQuery(
      'getAllTaskFunctions',
      (client) => client.from('task_functions').select('*').order('name')
    );
  }

  public saveTaskFunction(taskFunction: Omit<TaskFunction, 'id' | 'created_at' | 'updated_at'>): Promise<DatabaseResult<TaskFunction>> {
    return this.executeQuery(
      'saveTaskFunction',
      (client) => client.from('task_functions').upsert(taskFunction).select().single()
    );
  }

  /**
   * Health check for database connection
   */
  public async healthCheck(): Promise<{ healthy: boolean; error?: string; performance?: number }> {
    const healthTimerId = perf.start('db.healthCheck');

    try {
      const result = await this.executeQuery(
        'healthCheck',
        (client) => client.from('task_functions').select('id').limit(1)
      );

      const duration = perf.end(healthTimerId);

      return {
        healthy: result.success,
        error: result.error?.message,
        performance: duration
      };
    } catch (error) {
      const duration = perf.end(healthTimerId);
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        performance: duration
      };
    }
  }

  /**
   * Cleanup stale connections from the pool
   */
  public cleanupConnections(): void {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    const beforeCount = this.connectionPool.length;
    this.connectionPool = this.connectionPool.filter(conn => {
      const isStale = !conn.inUse && (now - conn.lastUsed) > staleThreshold;
      if (isStale) {
        logger.debug('Cleaning up stale database connection', {
          connectionAge: now - conn.created,
          lastUsed: now - conn.lastUsed
        });
      }
      return !isStale;
    });

    if (this.connectionPool.length !== beforeCount) {
      logger.info('Database connection pool cleanup completed', {
        beforeCount,
        afterCount,
        cleanedUp: beforeCount - this.connectionPool.length
      });
    }
  }

  /**
   * Get connection pool statistics
   */
  public getPoolStats(): {
    total: number;
    inUse: number;
    available: number;
    oldestConnection: number;
    newestConnection: number;
  } {
    const now = Date.now();
    const inUse = this.connectionPool.filter(conn => conn.inUse).length;

    return {
      total: this.connectionPool.length,
      inUse,
      available: this.connectionPool.length - inUse,
      oldestConnection: this.connectionPool.length > 0
        ? now - Math.min(...this.connectionPool.map(conn => conn.created))
        : 0,
      newestConnection: this.connectionPool.length > 0
        ? now - Math.max(...this.connectionPool.map(conn => conn.created))
        : 0
    };
  }

  /**
   * Helper method to check if string is a UUID
   */
  private isUuid(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Close all connections and cleanup
   */
  public async close(): Promise<void> {
    logger.info('Closing database service', {
      activeConnections: this.connectionPool.filter(conn => conn.inUse).length
    });

    // Wait for in-use connections to be released (with timeout)
    const maxWait = 10000; // 10 seconds
    const startTime = Date.now();

    while (this.connectionPool.some(conn => conn.inUse) && (Date.now() - startTime) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.connectionPool = [];
    logger.info('Database service closed');
  }
}

// Export singleton instance
export const database = DatabaseService.getInstance();

// Export convenience functions for backward compatibility
export const fetchTaskFromDatabase = (
  taskIdOrName: string,
  taskId?: string | null,
  options?: QueryOptions
): Promise<TaskFunction | null> => {
  return database.fetchTaskFromDatabase(taskIdOrName, taskId, options);
};

export const createServiceRoleClient = (): SupabaseClient => {
  return database.createClient(true);
};

export const createAnonClient = (): SupabaseClient => {
  return database.createClient(false);
};

// Export types
export type {
  TaskRun,
  StackRun,
  TaskFunction,
  KeyStoreEntry,
  DatabaseResult,
  QueryOptions,
  TransactionCallback
};