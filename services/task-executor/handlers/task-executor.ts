import { jsonResponse, formatErrorResponse, formatLogMessage } from "../utils/response-formatter.ts";
import { fetchTaskFromDatabase, database, type TaskFunction } from "../services/database.ts";
import { generateModuleCode } from "../services/module-generator.ts";
import { createServiceRoleClient } from "../../_shared/database-service.ts";

// Get supabase client from unified database service
const supabaseClient = createServiceRoleClient();

/**
 * Task interface representing a task in the database
 */
export interface TaskDefinition {
  id: string;
  name: string;
  description: string;
  code: string;
  created_at: string;
  updated_at: string;
}

/**
 * Execute a task with the given name and input
 *
 * This function now implements an ephemeral execution model:
 * 1. It immediately returns a response indicating that the task is being processed
 * 2. The task execution is recorded in the task_runs table with status 'queued'
 * 3. The result of the task execution is stored in the task_runs table, not returned to the caller
 * 4. The caller can check the status of the task execution by querying the task_runs table
 */
export async function executeTask(
  taskId: string,
  input: Record<string, unknown> = {},
  _options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}
): Promise<Response> {
  const startTime = Date.now();
  const taskRunId = crypto.randomUUID();
  console.log(formatLogMessage('INFO', `Task execution started at ${new Date(startTime).toISOString()}`));
  console.log(formatLogMessage('INFO', `Executing task: ${taskId} with run ID: ${taskRunId}`));

  try {
    // Fetch the task from the database
    const task = await fetchTaskFromDatabase(taskId);

    if (!task) {
      const errorMsg = `Task not found: ${taskId}`;
      console.error(`[ERROR] ${errorMsg}`);
      console.log(formatLogMessage('ERROR', errorMsg));
      return jsonResponse(formatErrorResponse(errorMsg), 404);
    }

    // Create a task_runs record with status 'queued'
      try {
      const insertResult = await supabaseClient.from('task_runs').insert({
          id: taskRunId,
        task_name: taskId,
        input: input || {},
          status: 'queued',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
      }).select('id').maybeSingle();

        if (!insertResult || insertResult.error) {
          const errorMessage = insertResult?.error?.message || 'Unknown error during insert';
          console.log(formatLogMessage('ERROR', `Failed to create task_runs record: ${errorMessage}`));
          // Continue execution even if task_runs record creation fails
        } else {
          console.log(formatLogMessage('INFO', `Created task_runs record with ID: ${taskRunId}`));
        }
      } catch (taskRunError) {
        console.log(formatLogMessage('ERROR', `Error creating task_runs record: ${taskRunError}`));
        // Continue execution even if task_runs record creation fails
      }

    // Execute task synchronously - start immediately
    console.log(formatLogMessage('INFO', `Starting synchronous execution of task ${taskId}...`));
    
    try {
      // Call the deno-executor edge function
      console.log(formatLogMessage('INFO', `Invoking deno-executor function for task ${taskId}...`));
      const denoExecutorUrl = `${SUPABASE_URL}/functions/v1/deno-executor`;
      
      // DEBUG: Log the payload being sent
      const payload = {
        taskName: task.name,
        taskRunId: taskRunId,
        stackRunId: null // Let system auto-generate
      };
      console.log(formatLogMessage('DEBUG', `Deno executor payload: ${JSON.stringify(payload)}`));

      const response = await fetch(denoExecutorUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify(payload)
      });

      const responseBody = await response.text();

      if (!response.ok) {
        const errorMsg = `Failed to execute task: ${response.status} - ${responseBody}`;
        console.log(formatLogMessage('ERROR', errorMsg));

        // Update the task_runs record with the error
        await supabaseClient.from('task_runs').update({
          status: 'error',
          error: { message: errorMsg },
          updated_at: new Date().toISOString()
        }).eq('id', taskRunId);

        return jsonResponse(formatErrorResponse(errorMsg), 500);
      }

      // Parse the response
      let result;
      try {
        result = JSON.parse(responseBody);
      } catch (parseError) {
        console.log(formatLogMessage('ERROR', `Failed to parse deno-executor response: ${parseError}`));
        return jsonResponse(formatErrorResponse(`Failed to parse response: ${parseError}`), 500);
      }

      // Check if task was suspended (expected behavior)
      if (result && result.__hostCallSuspended) {
        console.log(formatLogMessage('INFO', `Task ${taskId} suspended as expected - execution will resume on stack completion`));
        return jsonResponse({
          message: "Task started and suspended",
          taskRunId,
          status: "suspended",
          suspended: true
        }, 202);
      }

      // If task completed immediately (no suspend), update with result
      if (result && !result.__hostCallSuspended) {
        await supabaseClient.from('task_runs').update({
          status: 'completed',
          result,
          updated_at: new Date().toISOString(),
          ended_at: new Date().toISOString()
        }).eq('id', taskRunId);
        
        return jsonResponse({
          message: "Task completed immediately",
          taskRunId,
          status: "completed",
          result
        }, 200);
      }

      // Fallback - shouldn't reach here
      return jsonResponse({
        message: "Task execution completed with unknown state",
        taskRunId,
        status: "unknown"
      }, 200);
      
    } catch (error) {
      console.log(formatLogMessage('ERROR', `Task execution error: ${error}`));
      
      // Update task run with error
      try {
        await supabaseClient.from('task_runs').update({
          status: 'error',
          error: { message: error instanceof Error ? error.message : String(error) },
          updated_at: new Date().toISOString(),
          ended_at: new Date().toISOString()
        }).eq('id', taskRunId);
      } catch (updateError) {
        console.log(formatLogMessage('ERROR', `Failed to update task run with error: ${updateError}`));
      }
      
      return jsonResponse(formatErrorResponse(`Task execution failed: ${error instanceof Error ? error.message : String(error)}`), 500);
    }

    // This code is now moved above to execute synchronously
    // The function will return the appropriate response from the try block above
  } catch (error) {
    console.error(`Error in executeTask: ${error instanceof Error ? error.message : String(error)}`);
    return jsonResponse(formatErrorResponse(`Error executing task: ${error instanceof Error ? error.message : String(error)}`), 500);
  }
}
