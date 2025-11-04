/**
 * Database Service Adapter for Tasks
 *
 * This file provides backward compatibility while delegating to the unified database service.
 * All new code should use the unified database service directly.
 */

import logger from 'tasker-logging';
import { nowISO } from 'tasker-utils/timestamps';
import {
  database,
  fetchTaskFromDatabase as dbFetchTaskFromDatabase,
  type TaskFunction,
  type DatabaseResult
} from '../../_shared/database-service.ts';

// Re-export fetchTaskFromDatabase with backward compatible signature
export async function fetchTaskFromDatabase(taskId?: string, taskName?: string): Promise<{ taskFunction: any, taskName: string, description: string } | null> {
  const identifier = taskId || taskName;
  if (!identifier) {
    logger.error({ message: "Database query error: Either taskId or taskName must be provided" });
    return null;
  }

  logger.info({ message: "Fetching task", identifier });

  try {
    const taskData = await dbFetchTaskFromDatabase(identifier, taskId);
    if (taskData) {
      logger.info({ message: "Task found", taskName: taskData.name, taskId: taskData.id });

      // Extract task function code and create executable function
      const taskFunction = taskData.code;

      return {
        taskFunction,
        taskName: taskData.name,
        description: taskData.description || ''
      };
    } else {
      logger.info({ message: "No task found", identifier });
    }
    return null;
  } catch (error) {
    logger.error({ message: "Database fetch error", error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Save task result to the database
 */
export async function saveTaskResult(taskId: string, result: any): Promise<boolean> {
  if (!taskId) {
    logger.error({ message: "Database error: Task ID is required" });
    return false;
  }

  try {
    const dbResult = await database.executeQuery(
      'saveTaskResult',
      (client) => client.from('task_results').insert({
        task_id: taskId,
        result,
        created_at: nowISO()
      })
    );

    if (!dbResult.success) {
      logger.error({ message: "Database save error", error: dbResult.error?.message });
      return false;
    }

    return true;
  } catch (error) {
    logger.error({ message: "Database save error", error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Handle Supabase access for external tasks
 */
export async function handleSupabaseAccess(input: any): Promise<any> {
  const dbConfig = database.databaseConfig;

  if (!dbConfig.url) {
    throw new Error("Missing Supabase configuration (URL)");
  }

  const allowedPaths = ["tasks", "task_results", "users"];

  if (!input.table || !allowedPaths.includes(input.table)) {
    throw new Error("Access denied: Table not allowed");
  }

  // Return wrappedsupabase proxy URL for backward compatibility
  const wrappedSupabaseUrl = `${dbConfig.url}/functions/v1/wrappedsupabase`;

  return {
    url: wrappedSupabaseUrl,
    table: input.table,
  };
}

// Export the database service for direct access
export { database };
export type { TaskFunction, DatabaseResult };
