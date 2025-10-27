import { formatLogMessage } from "../utils/response-formatter.ts";
import { TaskRegistry } from "../registry/task-registry.ts";
import { fetchTaskFromDatabase } from "./database.ts";
import { GeneratedSchema } from "../types/index.ts";

const basicTaskRegistry = new TaskRegistry();
const specialTaskRegistry = new TaskRegistry();

export const tasksService = {
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    const logs: string[] = [formatLogMessage('INFO', `[SDK Service] Executing task: ${taskIdentifier}`)];
    try {
      // Check registry first (same logic as direct execution)
      let taskFunction = basicTaskRegistry.get(taskIdentifier);
      let taskType = 'basic';

      if (!taskFunction) {
        taskFunction = specialTaskRegistry.get(taskIdentifier);
        taskType = 'special';
      }

      if (taskFunction) {
        logs.push(formatLogMessage('INFO', `[SDK Service] Found task in ${taskType} registry, executing locally`));
        const result = await taskFunction(input, { supabaseClient: null });
        if (options.include_logs) {
          return { success: true, result, logs };
        }
        return { success: true, result };
      }

      // Fetch from database
      logs.push(formatLogMessage('INFO', `[SDK Service] Task not in registry, fetching from database: ${taskIdentifier}`));
      const { taskFunction: dbTaskFunction, taskName, description } = await fetchTaskFromDatabase(taskIdentifier);

      if (!dbTaskFunction) {
        const error = `Task not found: ${taskIdentifier}`;
        logs.push(formatLogMessage('ERROR', `[SDK Service] ${error}`));
        return { success: false, error, logs };
      }

      // Delegate to deno-executor for tasks that require suspend/resume capabilities
      logs.push(formatLogMessage('INFO', `[SDK Service] Delegating task to deno-executor: ${taskName || taskIdentifier}`));

      // Use simple direct database approach
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const supabase = createClient(supabaseUrl, serviceRoleKey);

      logs.push(formatLogMessage('INFO', `[SDK Service] Created direct Supabase client`));

      // First, get the task function data directly
      const { data: taskData, error: taskError } = await supabase
        .from('task_functions')
        .select('*')
        .eq('name', taskIdentifier)
        .single();

      if (taskError || !taskData) {
        const error = `Task data not found: ${taskError?.message || 'Unknown error'}`;
        logs.push(formatLogMessage('ERROR', `[SDK Service] ${error}`));
        return { success: false, error, logs };
      }

      logs.push(formatLogMessage('INFO', `[SDK Service] Retrieved task data: ${JSON.stringify({ id: taskData.id, name: taskData.name, description: taskData.description })}`));

      // Create task run directly
      const taskNameForRun = taskData.name || taskIdentifier;
      logs.push(formatLogMessage('INFO', `[SDK Service] Using task name: ${taskNameForRun}`));

      const { data: taskRunData, error: createError } = await supabase
        .from('task_runs')
        .insert({
          task_function_id: taskData.id,
          task_name: taskNameForRun,
          input: input,
          status: 'pending'
        })
        .select()
        .single();

      if (createError || !taskRunData) {
        const error = `Failed to create task run: ${createError?.message || 'Unknown error'}`;
        logs.push(formatLogMessage('ERROR', `[SDK Service] ${error}`));
        return { success: false, error, logs };
      }

      const taskRun = taskRunData;
      logs.push(formatLogMessage('INFO', `[SDK Service] Created task run ${taskRun.id}, creating initial stack run`));

      const { data: initialStackRunData, error: initialStackRunError } = await supabase
        .from('stack_runs')
        .insert({
          parent_task_run_id: taskRun.id,
          service_name: 'deno-executor',
          method_name: 'execute',
          args: {
            taskCode: taskData.code,
            taskName: taskData.name,
            taskInput: input,
            taskRunId: String(taskRun.id),
            stackRunId: '0'
          },
          status: 'pending'
        })
        .select()
        .single();

      if (initialStackRunError || !initialStackRunData) {
        const error = `Failed to create initial stack run: ${initialStackRunError?.message || 'Unknown error'}`;
        logs.push(formatLogMessage('ERROR', `[SDK Service] ${error}`));
        return { success: false, error, logs };
      }

      const actualStackRunId = initialStackRunData.id;

      const { error: updateStackRunError } = await supabase
        .from('stack_runs')
        .update({
          args: {
            taskCode: taskData.code,
            taskName: taskData.name,
            taskInput: input,
            taskRunId: String(taskRun.id),
            stackRunId: String(actualStackRunId)
          }
        })
        .eq('id', actualStackRunId);

      if (updateStackRunError) {
        logs.push(formatLogMessage('WARN', `[SDK Service] Failed to update stackRunId in args: ${updateStackRunError.message}`));
      }

      logs.push(formatLogMessage('INFO', `[SDK Service] Created initial stack run ${actualStackRunId}, triggering FIFO processing`));

      const { triggerFIFOProcessingChain } = await import('./stack-processor.ts');
      await triggerFIFOProcessingChain(supabaseUrl, serviceRoleKey);

      // Return immediately after triggering processing (for testing)
      logs.push(formatLogMessage('INFO', `[SDK Service] Task ${taskRun.id} submitted successfully, processing in background`));
      return {
        success: true,
        result: {
          taskRunId: taskRun.id,
          status: 'submitted',
          message: 'Task submitted for background processing'
        },
        logs,
        taskName: taskData.name,
        description: taskData.description
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(formatLogMessage('ERROR', `[SDK Service] Task execution failed: ${errorMessage}`));

      if (options.include_logs) {
        return { success: false, error: errorMessage, logs };
      }
      return { success: false, error: errorMessage };
    }
  },

  list: async (filter: { type?: 'basic' | 'special' | 'database' } = {}) => {
    const allTasks: any[] = [];

    if (!filter.type || filter.type === 'basic') {
      Object.keys(basicTaskRegistry.list()).forEach(taskName => {
        allTasks.push({ name: taskName, type: 'basic' });
      });
    }

    if (!filter.type || filter.type === 'special') {
      Object.keys(specialTaskRegistry.list()).forEach(taskName => {
        allTasks.push({ name: taskName, type: 'special' });
      });
    }

    // TODO: Implement database task listing if needed

    return { success: true, tasks: allTasks };
  }
};