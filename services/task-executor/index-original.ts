import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
// Removed executeTask import - using new synchronous execution model
import { jsonResponse, formatTaskResult, formatLogMessage } from "./utils/response-formatter.ts";
import { TaskRegistry } from "./registry/task-registry.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateSchema, formatSchema } from './services/schema-generator.ts';
import { parseJSDocComments } from './utils/jsdoc-parser.ts';
import { GeneratedSchema } from "./types/index.ts";
import { executeMethodChain } from "npm:sdk-http-wrapper@1.0.10/server";
import { hostLog, simpleStringify } from '../_shared/utils.ts'; // Assuming utils are in _shared
import { fetchTaskFromDatabase } from "./services/database.ts";

config({ export: true });

declare global {
  var __updatedFields: Record<string, any>;
}

// Initialize task registries
const basicTaskRegistry = new TaskRegistry();
const specialTaskRegistry = new TaskRegistry();

// Environment setup
const extSupabaseUrl = Deno.env.get('EXT_SUPABASE_URL') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';

// If the URL is the edge functions URL, use the REST API URL instead for local dev
const SUPABASE_URL = extSupabaseUrl.includes('127.0.0.1:8000') 
    ? 'http://localhost:54321' 
    : extSupabaseUrl || (supabaseUrl.includes('127.0.0.1:8000') ? 'http://localhost:54321' : supabaseUrl);

const SUPABASE_ANON_KEY = Deno.env.get('EXT_SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
console.log(`[INFO] SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`[INFO] SERVICE_ROLE_KEY (masked): ${SERVICE_ROLE_KEY ? '*'.repeat(10) : 'MISSING'}`);
console.log(`[INFO] Environment variables:`, Deno.env.toObject());
const supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

// --- Define the Tasks Service for SDK Wrapper ---
const tasksService = {
  execute: async (taskIdentifier: string, input: Record<string, unknown> = {}, options: { debug?: boolean, verbose?: boolean, include_logs?: boolean } = {}) => {
    //console.log(`[INFO][SDK Service] Received task execution request for: ${taskIdentifier}`);
    const logs: string[] = [formatLogMessage('INFO', `[SDK Service] Executing task: ${taskIdentifier}`)];
    try {
      // Check registry first (same logic as direct execution)
      if (specialTaskRegistry.hasTask(taskIdentifier) || basicTaskRegistry.hasTask(taskIdentifier)) {
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing registered task: ${taskIdentifier}`));
        let result;
        if (specialTaskRegistry.hasTask(taskIdentifier)) {
          result = await specialTaskRegistry.executeTask(taskIdentifier, input, logs);
        } else {
          result = await basicTaskRegistry.executeTask(taskIdentifier, input, logs);
        }
        // The SDK wrapper expects the raw result, not a formatted Response
        return { success: true, data: result, logs };
      } else {
        // Execute from database using new synchronous execution model
        logs.push(formatLogMessage('INFO', `[SDK Service] Executing task from database: ${taskIdentifier}`));
        
        // Use internal task execution (same as main handler)
        const taskFunction = await fetchTaskFromDatabase(undefined, taskIdentifier);
        if (!taskFunction) {
          throw new Error(`Task '${taskIdentifier}' not found.`);
        }
        
        // Create task_runs record
        const taskRunId = crypto.randomUUID();
        const baseUrl = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
        const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                             Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        
        const taskRunData = {
            task_function_id: taskFunction.id,
            task_name: taskFunction.name,
            input: input || null,
            status: 'queued'
        };
        
        const taskRunUrl = `${baseUrl}/rest/v1/task_runs`;
        const taskRunResponse = await fetch(taskRunUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(taskRunData)
        });
        
        if (!taskRunResponse.ok) {
            throw new Error(`Failed to create task run: ${taskRunResponse.status}`);
        }
        
        const taskRunResult = await taskRunResponse.json();
        const actualTaskRunId = Array.isArray(taskRunResult) ? taskRunResult[0].id : taskRunResult.id;
        
        // Create initial stack_run
        const stackRunData = {
            parent_task_run_id: actualTaskRunId,
            service_name: 'tasks',
            method_name: 'execute',
            args: [taskFunction.name, input || null],
            status: 'pending',
            vm_state: {
                taskCode: taskFunction.code,
                taskName: taskFunction.name,
                taskInput: input || null
            }
        };
        
        const stackRunsUrl = `${baseUrl}/rest/v1/stack_runs`;
        const stackRunResponse = await fetch(stackRunsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(stackRunData)
        });
        
        if (!stackRunResponse.ok) {
            throw new Error(`Failed to create stack run: ${stackRunResponse.status}`);
        }
        
        const stackRunResult = await stackRunResponse.json();
        const stackRunId = Array.isArray(stackRunResult) ? stackRunResult[0].id : stackRunResult.id;
        
        // CRITICAL FIX: Always trigger stack processor synchronously for FIFO processing
        try {
            const stackProcessorUrl = `${baseUrl}/functions/v1/simple-stack-processor`;
            const triggerResponse = await fetch(stackProcessorUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${serviceRoleKey}`,
                },
                body: JSON.stringify({ stackRunId })
            });
            
            if (triggerResponse.ok) {
                logs.push(formatLogMessage('INFO', `Stack processor triggered successfully for stack run ${stackRunId}`));
            } else {
                const errorText = await triggerResponse.text();
                logs.push(formatLogMessage('ERROR', `Failed to trigger stack processor: ${triggerResponse.status} - ${errorText}`));
            }
        } catch (error) {
            logs.push(formatLogMessage('ERROR', `Error triggering stack processor: ${error}`));
        }
        
        // Return success with task run ID for monitoring
        return { 
            success: true, 
            taskRunId: actualTaskRunId,
            stackRunId: stackRunId,
            data: { message: 'Task submitted successfully and will process automatically', taskRunId: actualTaskRunId },
            logs 
        };
      }
    } catch (error) {
      const errorMsg = `[SDK Service] Error executing task ${taskIdentifier}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[ERROR] ${errorMsg}`);
      logs.push(formatLogMessage('ERROR', errorMsg));
      // Throw the error so executeMethodChain can format it
      throw new Error(errorMsg);
    }
  }
};
// ---------------------------------------------

// Initialize global state
if (!globalThis.__updatedFields) globalThis.__updatedFields = {};

function createResponse(data: any, logs: string[] = [], status = 200): Response {
  return jsonResponse(formatTaskResult(true, data, undefined, logs), status);
}

function createErrorResponse(errorMessage: string, logs: string[] = [], status = 500): Response {
  return jsonResponse(formatTaskResult(false, undefined, errorMessage, logs), status);
}

function createCorsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LOG_PREFIX_BASE = "[TasksHandlerEF]"; // Tasks Handler Edge Function

// Helper function to check if the queue is busy
async function checkQueueBusy(baseUrl: string, serviceRoleKey: string): Promise<boolean> {
    try {
        // Check for any task_runs or stack_runs that are currently processing
        const taskRunsUrl = `${baseUrl}/rest/v1/task_runs?status=in.(processing)&limit=1`;
        const stackRunsUrl = `${baseUrl}/rest/v1/stack_runs?status=in.(processing,pending,pending_resume)&limit=1`;
        
        const [taskRunsResponse, stackRunsResponse] = await Promise.all([
            fetch(taskRunsUrl, {
                headers: {
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'apikey': serviceRoleKey
                }
            }),
            fetch(stackRunsUrl, {
                headers: {
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'apikey': serviceRoleKey
                }
            })
        ]);
        
        if (!taskRunsResponse.ok || !stackRunsResponse.ok) {
            hostLog(LOG_PREFIX_BASE, 'warn', 'Failed to check queue status, assuming busy');
            return true; // Assume busy if we can't check
        }
        
        const taskRuns = await taskRunsResponse.json();
        const stackRuns = await stackRunsResponse.json();
        
        const isBusy = (taskRuns.length > 0) || (stackRuns.length > 0);
        hostLog(LOG_PREFIX_BASE, 'info', `Queue check: ${isBusy ? 'busy' : 'free'} (${taskRuns.length} task_runs, ${stackRuns.length} stack_runs)`);
        
        return isBusy;
    } catch (error) {
        hostLog(LOG_PREFIX_BASE, 'error', `Error checking queue status: ${error}`);
        return true; // Assume busy on error
    }
}

// Helper function to execute a stack run synchronously
async function executeStackRunSynchronously(stackRunId: string, baseUrl: string, serviceRoleKey: string): Promise<{success: boolean, result?: any, error?: string}> {
    try {
        hostLog(LOG_PREFIX_BASE, 'info', `Starting synchronous execution of stack run ${stackRunId}`);
        
        // Mark task as processing
        const updateUrl = `${baseUrl}/rest/v1/task_runs?parent_stack_run_id=eq.${stackRunId}`;
        await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                status: 'processing',
                updated_at: new Date().toISOString()
            })
        });
        
        // Execute the stack run via simple-stack-processor
        const stackProcessorUrl = `${baseUrl}/functions/v1/simple-stack-processor`;
        const response = await fetch(stackProcessorUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`
            },
            body: JSON.stringify({
                stackRunId: stackRunId
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Stack processor failed: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        hostLog(LOG_PREFIX_BASE, 'info', `Stack run ${stackRunId} executed with status: ${result.status}`);
        
        // After execution, trigger next queued task if any
        await triggerNextQueuedTask(baseUrl, serviceRoleKey);
        
        return {
            success: result.status === 'completed',
            result: result.result,
            error: result.error
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(LOG_PREFIX_BASE, 'error', `Synchronous execution failed: ${errorMessage}`);
        
        // Try to trigger next queued task even on failure
        try {
            await triggerNextQueuedTask(baseUrl, serviceRoleKey);
        } catch (triggerError) {
            hostLog(LOG_PREFIX_BASE, 'error', `Failed to trigger next task after error: ${triggerError}`);
        }
        
        return {
            success: false,
            error: errorMessage
        };
    }
}

// FIFO Processing Chain - continuously processes tasks until queue is empty
async function triggerFIFOProcessingChain(baseUrl: string, serviceRoleKey: string): Promise<void> {
    const logPrefix = '[FIFO-Chain]';
    hostLog(logPrefix, 'info', 'Starting FIFO processing chain');
    
    let processedCount = 0;
    const maxProcessingCycles = 100; // Safety limit to prevent infinite loops
    
    while (processedCount < maxProcessingCycles) {
        try {
            // Find the next queued task or pending stack run (FIFO order)
            const queuedTasksUrl = `${baseUrl}/rest/v1/task_runs?status=eq.queued&order=created_at.asc&limit=1`;
            const taskResponse = await fetch(queuedTasksUrl, {
                headers: {
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'apikey': serviceRoleKey
                }
            });
            
            if (!taskResponse.ok) {
                hostLog(logPrefix, 'warn', 'Failed to check for queued tasks');
                break;
            }
            
            const queuedTasks = await taskResponse.json();
            
            // Also check for pending stack runs
            const pendingStackUrl = `${baseUrl}/rest/v1/stack_runs?status=in.(pending,pending_resume)&order=created_at.asc&limit=1`;
            const stackResponse = await fetch(pendingStackUrl, {
                headers: {
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'apikey': serviceRoleKey
                }
            });
            
            const pendingStacks = stackResponse.ok ? await stackResponse.json() : [];
            
            // If no queued tasks and no pending stacks, we're done
            if (queuedTasks.length === 0 && pendingStacks.length === 0) {
                hostLog(logPrefix, 'info', `FIFO processing complete - processed ${processedCount} items`);
                break;
            }
            
            // Process pending stack runs first (they might be waiting on children)
            if (pendingStacks.length > 0) {
                const stackRun = pendingStacks[0];
                hostLog(logPrefix, 'info', `Processing pending stack run: ${stackRun.id}`);
                
                const stackProcessResponse = await fetch(`${baseUrl}/functions/v1/simple-stack-processor`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${serviceRoleKey}`
                    },
                    body: JSON.stringify({ stackRunId: stackRun.id })
                });
                
                if (stackProcessResponse.ok) {
                    processedCount++;
                    hostLog(logPrefix, 'info', `Stack run ${stackRun.id} processed`);
                    
                    // Brief pause to prevent overwhelming the system
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                } else {
                    hostLog(logPrefix, 'error', `Failed to process stack run ${stackRun.id}`);
                }
            }
            
            // Process queued tasks
            if (queuedTasks.length > 0) {
                const nextTask = queuedTasks[0];
                hostLog(logPrefix, 'info', `Processing queued task: ${nextTask.id}`);
                
                // Find the associated stack run for this task
                const taskStackUrl = `${baseUrl}/rest/v1/stack_runs?parent_task_run_id=eq.${nextTask.id}&limit=1`;
                const taskStackResponse = await fetch(taskStackUrl, {
                    headers: {
                        'Authorization': `Bearer ${serviceRoleKey}`,
                        'apikey': serviceRoleKey
                    }
                });
                
                if (taskStackResponse.ok) {
                    const taskStacks = await taskStackResponse.json();
                    if (taskStacks.length > 0) {
                        const stackRun = taskStacks[0];
                        
                        // Trigger simple stack processor for this task
                        const triggerResponse = await fetch(`${baseUrl}/functions/v1/simple-stack-processor`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${serviceRoleKey}`
                            },
                            body: JSON.stringify({ stackRunId: stackRun.id })
                        });
                        
                        if (triggerResponse.ok) {
                            processedCount++;
                            hostLog(logPrefix, 'info', `Task ${nextTask.id} processing initiated`);
                        } else {
                            hostLog(logPrefix, 'error', `Failed to trigger processing for task ${nextTask.id}`);
                        }
                    }
                }
            }
            
            // Brief pause between processing cycles
            await new Promise(resolve => setTimeout(resolve, 200));
            
        } catch (error) {
            hostLog(logPrefix, 'error', `Error in FIFO processing cycle: ${error}`);
            break;
        }
    }
    
    if (processedCount >= maxProcessingCycles) {
        hostLog(logPrefix, 'warn', `FIFO processing stopped after ${processedCount} cycles (safety limit reached)`);
    }
    
    hostLog(logPrefix, 'info', `FIFO processing chain completed - total items processed: ${processedCount}`);
}

// Helper function to trigger the next queued task
async function triggerNextQueuedTask(baseUrl: string, serviceRoleKey: string): Promise<void> {
    try {
        // Find the next queued task
        const queuedTasksUrl = `${baseUrl}/rest/v1/task_runs?status=eq.queued&order=created_at.asc&limit=1`;
        const response = await fetch(queuedTasksUrl, {
            headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey
            }
        });
        
        if (!response.ok) {
            hostLog(LOG_PREFIX_BASE, 'warn', 'Failed to check for queued tasks');
            return;
        }
        
        const queuedTasks = await response.json();
        
        if (queuedTasks.length === 0) {
            hostLog(LOG_PREFIX_BASE, 'info', 'No queued tasks to trigger');
            return;
        }
        
        const nextTask = queuedTasks[0];
        hostLog(LOG_PREFIX_BASE, 'info', `Triggering next queued task: ${nextTask.id}`);
        
        // Find the associated stack run
        const stackRunUrl = `${baseUrl}/rest/v1/stack_runs?parent_task_run_id=eq.${nextTask.id}&limit=1`;
        const stackRunResponse = await fetch(stackRunUrl, {
            headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey
            }
        });
        
        if (stackRunResponse.ok) {
            const stackRuns = await stackRunResponse.json();
            if (stackRuns.length > 0) {
                const stackRunId = stackRuns[0].id;
                
                // Trigger the simple stack processor asynchronously (fire and forget)
                const stackProcessorUrl = `${baseUrl}/functions/v1/simple-stack-processor`;
                fetch(stackProcessorUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${serviceRoleKey}`
                    },
                    body: JSON.stringify({
                        stackRunId: stackRunId
                    })
                }).catch(error => {
                    hostLog(LOG_PREFIX_BASE, 'error', `Failed to trigger next task processor: ${error}`);
                });
                
                hostLog(LOG_PREFIX_BASE, 'info', `Next task ${nextTask.id} triggered asynchronously`);
            }
        }
    } catch (error) {
        hostLog(LOG_PREFIX_BASE, 'error', `Error triggering next queued task: ${error}`);
    }
}

async function tasksHandler(req: Request): Promise<Response> {
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: CORS_HEADERS });
    }

    let supabaseClient: SupabaseClient;
    try {
        if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
            hostLog(LOG_PREFIX_BASE, 'error', "Supabase URL or Service Role Key is not configured in environment variables.");
            throw new Error("Supabase environment variables for service role not set.");
        }
        // Initialize Supabase client with service role key for administrative tasks
        supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
            // No need to pass auth headers explicitly when using service_role_key server-side
            auth: { persistSession: false }
        });
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Supabase client (service role) initialization failed:", error.message);
        return new Response(simpleStringify({ error: "Server configuration error.", details: error.message }), {
            status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    let requestBody;
    try {
        requestBody = await req.json();
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Invalid JSON request body:", error.message);
        return new Response(simpleStringify({ error: "Invalid JSON request body.", details: error.message }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    // Check for special service method calls first
    if (requestBody.service === "tasks" && requestBody.method === "triggerFIFO") {
        hostLog(LOG_PREFIX_BASE, 'info', "Received triggerFIFO request, starting FIFO processing chain");
        
        // Start the FIFO processing chain
        const baseUrl = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
        const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                             Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        
        if (!serviceRoleKey) {
            return new Response(simpleStringify({ error: "Service configuration error" }), {
                status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }
        
        // Don't await - let it run in background
        triggerFIFOProcessingChain(baseUrl, serviceRoleKey).catch(error => {
            hostLog(LOG_PREFIX_BASE, 'error', `Error in FIFO processing chain: ${error}`);
        });
        
        return new Response(simpleStringify({ 
            status: "ok", 
            message: "FIFO processing chain started" 
        }), {
            status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    const { taskName, input } = requestBody;
    const logPrefix = `${LOG_PREFIX_BASE} [TaskName: ${taskName || 'N/A'}]`;

    if (!taskName || typeof taskName !== 'string') {
        hostLog(logPrefix, 'error', "'taskName' is required in the request body and must be a string.");
        return new Response(simpleStringify({ error: "'taskName' is required and must be a string." }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }

    try {
        // Step 1: Fetch Task Definition from task_functions table
        hostLog(logPrefix, 'info', `Attempting to fetch definition for task: '${taskName}'`);
        
        // Use fetchTaskFromDatabase which now has direct HTTP fetch as a fallback
        const taskFunction = await fetchTaskFromDatabase(undefined, taskName);

        if (!taskFunction) {
            hostLog(logPrefix, 'warn', `Task definition not found for '${taskName}'.`);
            return new Response(simpleStringify({ error: `Task '${taskName}' not found.` }), {
                status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
            });
        }
        hostLog(logPrefix, 'info', `Task definition '${taskFunction.name}' (ID: ${taskFunction.id}) found.`);

        // Step 2: Create a task_runs record to track the overall user request
        hostLog(logPrefix, 'info', `Creating task_run record with input:`, input || '(no input)');
        
        // Use direct fetch method for creating task_run record
        const baseUrl = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
        const serviceRoleKey = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || 
                             Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
                         
        if (!serviceRoleKey) {
            throw new Error("Service role key not available for direct insert");
        }
        
        const taskRunData = {
            task_function_id: taskFunction.id,
            task_name: taskFunction.name,
            input: input || null,
            status: 'queued'
        };
        
        const url = `${baseUrl}/rest/v1/task_runs`;
        
        const insertResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(taskRunData)
        });
        
        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
            hostLog(logPrefix, 'error', `Failed to create task_run record in database: HTTP ${insertResponse.status} ${insertResponse.statusText}`, errorText);
            throw new Error(`Database error: Failed to initiate task run. HTTP ${insertResponse.status} ${insertResponse.statusText}`);
        }
        
        const taskRunResult = await insertResponse.json();
        const taskRunId = Array.isArray(taskRunResult) && taskRunResult.length > 0 ? taskRunResult[0].id : null;
        
        if (!taskRunId) {
            hostLog(logPrefix, 'error', "Failed to obtain task_run ID after insertion");
            throw new Error("Database error: Failed to obtain task run ID after insertion");
        }
        
        hostLog(logPrefix, 'info', `Task_run record created successfully: ${taskRunId}`);

        // Step 3: Skip queue busy check - always process immediately with stack processor
        
        // Step 4: Create the initial stack_runs record to kick off the execution
        hostLog(logPrefix, 'info', `Creating initial stack_run for task_run ${taskRunId}`);
        
        // Use direct fetch for creating stack_run record - call deno-executor directly
        const stackRunData = {
            parent_task_run_id: taskRunId,
            service_name: 'deno-executor',
            method_name: 'execute',
            args: [taskFunction.name, input || null],
            status: 'pending',
            vm_state: {
                taskCode: taskFunction.code,
                taskName: taskFunction.name,
                taskInput: input || null
            }
        };
        
        const stackRunsUrl = `${baseUrl}/rest/v1/stack_runs`;
        
        const stackRunResponse = await fetch(stackRunsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
                'apikey': serviceRoleKey,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(stackRunData)
        });
        
        if (!stackRunResponse.ok) {
            const errorText = await stackRunResponse.text();
            hostLog(logPrefix, 'error', `Failed to create initial stack_run record in database: HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`, errorText);
            
            // Attempt to mark the parent task_run as failed to avoid orphaned task_runs
            try {
                const updateTaskRunUrl = `${baseUrl}/rest/v1/task_runs?id=eq.${encodeURIComponent(taskRunId)}`;
                await fetch(updateTaskRunUrl, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${serviceRoleKey}`,
                        'apikey': serviceRoleKey
                    },
                    body: JSON.stringify({
                        status: 'failed',
                        error: { 
                            message: "System error: Failed to create initial stack_run for task execution.", 
                            details: `HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`
                        },
                        ended_at: new Date().toISOString()
                    })
                });
            } catch (updateErr) {
                hostLog(logPrefix, 'error', "Additionally failed to mark task_run as failed:", updateErr);
            }
            
            throw new Error(`Database error: Failed to create initial stack run. HTTP ${stackRunResponse.status} ${stackRunResponse.statusText}`);
        }
        
        const stackRunResult = await stackRunResponse.json();
        const stackRunId = Array.isArray(stackRunResult) && stackRunResult.length > 0 ? stackRunResult[0].id : null;
        
        if (!stackRunId) {
            hostLog(logPrefix, 'error', "Failed to obtain stack_run ID after insertion");
            throw new Error("Database error: Failed to obtain stack run ID after insertion");
        }
        
        hostLog(logPrefix, 'info', `Initial stack_run ${stackRunId} created. Task '${taskName}' (run ID: ${taskRunId}) has been successfully offloaded.`);

        // Step 4: No longer pre-triggering stack processor - will be handled in Step 5

        // Step 5: Always trigger the simple stack processor for automatic FIFO processing
        hostLog(logPrefix, 'info', `Always triggering simple stack processor for automatic processing of stack run ${stackRunId}`);

        // CRITICAL: Use fire-and-forget pattern to avoid blocking
        const stackProcessorUrl = `${baseUrl}/functions/v1/simple-stack-processor`;
        hostLog(logPrefix, 'info', `Triggering stack processor for automatic processing (async)`);

        // Fire-and-forget - don't wait for response
        setTimeout(() => {
            fetch(stackProcessorUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${serviceRoleKey}`,
                },
                body: JSON.stringify({ trigger: 'process-next' })
            }).catch(error => {
                hostLog(logPrefix, 'warn', `Async stack processor trigger failed (non-critical): ${error}`);
            });
        }, 0);
        
        // Return immediately - processing will continue automatically
        return new Response(simpleStringify({
            message: "Task submitted successfully and will process automatically.",
            taskRunId: taskRunId,
            stackRunId: stackRunId,
            status: "submitted",
            info: "Processing will continue automatically until completion - no manual triggers needed"
        }), {
            status: 202, // HTTP 202 Accepted: Processing started
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(logPrefix, 'error', "Unhandled error in /tasks endpoint handler:", error.message, error.stack);
        // Avoid exposing detailed internal errors to the client unless necessary
        return new Response(simpleStringify({ error: "An unexpected server error occurred while processing the task request." }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
}

// New handler for getting task status
async function statusHandler(req: Request): Promise<Response> {
    // Extract taskRunId from query params in URL for GET requests
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    
    const logPrefix = `[tasks/status/${taskRunId}]`;
    
    hostLog(logPrefix, 'info', `Received status request for task run ID: ${taskRunId}`);
    
    if (!taskRunId) {
        return new Response(
            simpleStringify({ error: 'Missing taskRunId parameter' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        // Determine the correct baseUrl for database access
        const extSupabaseUrl = Deno.env.get("EXT_SUPABASE_URL") || "";
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
        
        // Use Kong URL for local development or when EXT_SUPABASE_URL is missing
        const useKong = extSupabaseUrl.includes('localhost') || 
                       extSupabaseUrl.includes('127.0.0.1') || 
                       !extSupabaseUrl;
                       
        const baseUrl = useKong 
            ? 'http://kong:8000/rest/v1' 
            : `${SUPABASE_URL}/rest/v1`;
        
        // Fetch task run from database
        const dbUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}&select=*`;
        hostLog(logPrefix, 'info', `Attempting to fetch task run from: ${dbUrl}`);
        
        const response = await fetch(dbUrl, {
            headers: {
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                'apikey': SERVICE_ROLE_KEY
            }
        });
        
        if (!response.ok) {
            const error = await response.text();
            const errorMessage = `Database query failed: ${error}`;
            hostLog(logPrefix, 'error', errorMessage);
            return new Response(
                simpleStringify({ error: `Failed to fetch task status: ${errorMessage}` }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const tasks = await response.json();
        hostLog(logPrefix, 'info', `Database query successful. Found ${tasks.length} records.`);
        
        if (tasks.length === 0) {
            return new Response(
                simpleStringify({ error: `Task run with ID ${taskRunId} not found` }),
                { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const taskRun = tasks[0];
        
        // Check if task has been stuck in 'queued' or 'processing' state
        if ((taskRun.status === 'queued' || taskRun.status === 'processing') && taskRun.created_at) {
            const createdAt = new Date(taskRun.created_at);
            const now = new Date();
            const diffInSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
            
            // Even for recent tasks, do a quick check for completed results
            hostLog(logPrefix, 'info', `Task is in ${taskRun.status} state for ${diffInSeconds} seconds, checking if there's a completed stack run`);
            
            // First try: Get the stack run associated with this task
            try {
                // Use parent_task_run_id field
                const stackRunUrl = `${baseUrl}/stack_runs?select=*&parent_task_run_id=eq.${taskRunId}&status=eq.completed&order=created_at.desc&limit=1`;
                const stackRunResponse = await fetch(stackRunUrl, {
                    headers: {
                        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (stackRunResponse.ok) {
                    const stackRuns = await stackRunResponse.json();
                    
                    if (stackRuns && stackRuns.length > 0) {
                        const completedStackRun = stackRuns[0];
                        hostLog(logPrefix, 'warn', `Found completed stack run ${completedStackRun.id} with result, updating task run status`);
                        
                        // Update the task run to completed with the result from the stack run
                        const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                        const updateResponse = await fetch(updateUrl, {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                'apikey': SERVICE_ROLE_KEY,
                                'Content-Type': 'application/json',
                                'Prefer': 'return=minimal'
                            },
                            body: JSON.stringify({
                                status: 'completed',
                                result: completedStackRun.result,
                                updated_at: new Date().toISOString(),
                                ended_at: new Date().toISOString()
                            })
                        });
                        
                        if (!updateResponse.ok) {
                            const updateError = await updateResponse.text();
                            hostLog(logPrefix, 'error', `Failed to update task run status: ${updateError}`);
                        } else {
                            hostLog(logPrefix, 'info', `Successfully updated task run ${taskRunId} to completed status`);
                            
                            // Update the taskRun object with the new status and result
                            taskRun.status = 'completed';
                            taskRun.result = completedStackRun.result;
                            taskRun.updated_at = new Date().toISOString();
                            taskRun.ended_at = new Date().toISOString();
                        }
                    } else {
                        // Try a different query using parent_task_run_id field (handles legacy/compatibility)
                        try {
                            const altStackRunUrl = `${baseUrl}/stack_runs?select=*&parent_task_run_id=eq.${taskRunId}&status=eq.completed&order=created_at.desc&limit=1`;
                            const altStackRunResponse = await fetch(altStackRunUrl, {
                                headers: {
                                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                    'apikey': SERVICE_ROLE_KEY
                                }
                            });
                            
                            if (altStackRunResponse.ok) {
                                const altStackRuns = await altStackRunResponse.json();
                                
                                if (altStackRuns && altStackRuns.length > 0) {
                                    const completedStackRun = altStackRuns[0];
                                    hostLog(logPrefix, 'warn', `Found completed stack run ${completedStackRun.id} with result (via parent_task_run_id), updating task run status`);
                                    
                                    // Update the task run to completed with the result from the stack run
                                    const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                                    const updateResponse = await fetch(updateUrl, {
                                        method: 'PATCH',
                                        headers: {
                                            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                            'apikey': SERVICE_ROLE_KEY,
                                            'Content-Type': 'application/json',
                                            'Prefer': 'return=minimal'
                                        },
                                        body: JSON.stringify({
                                            status: 'completed',
                                            result: completedStackRun.result,
                                            updated_at: new Date().toISOString(),
                                            ended_at: new Date().toISOString()
                                        })
                                    });
                                    
                                    if (updateResponse.ok) {
                                        hostLog(logPrefix, 'info', `Successfully updated task run ${taskRunId} to completed status (via parent_task_run_id)`);
                                        
                                        // Update the taskRun object
                                        taskRun.status = 'completed';
                                        taskRun.result = completedStackRun.result;
                                        taskRun.updated_at = new Date().toISOString();
                                        taskRun.ended_at = new Date().toISOString();
                                    }
                                } else {
                                    hostLog(logPrefix, 'info', `No completed stack run found for task run ${taskRunId} with either query method`);
                                    
                                    // For long-running tasks, check if we need a manual cleanup
                                    if (diffInSeconds > 60) {
                                        hostLog(logPrefix, 'warn', `Task has been stuck in ${taskRun.status} state for over 60 seconds, performing manual check`);
                                        
                                        // Fallback: Try to find any stack run related to this task
                                        try {
                                            if (taskRun.waiting_on_stack_run_id) {
                                                // If we have a waiting_on_stack_run_id, just wait for that to complete
                                                hostLog(logPrefix, 'info', `Task is waiting on stack run ${taskRun.waiting_on_stack_run_id}, no manual intervention needed`);
                                                // Continue with normal status return
                                            }
                                            
                                            const allStackRunsUrl = `${baseUrl}/stack_runs?select=*&or=(parent_task_run_id.eq.${taskRunId})&order=created_at.desc&limit=1`;
                                            
                                            hostLog(logPrefix, 'info', `Checking for any stack runs: ${allStackRunsUrl}`);
                                            
                                            const allStackRunsResponse = await fetch(allStackRunsUrl, {
                                                headers: {
                                                    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                                    'Content-Type': 'application/json'
                                                }
                                            });
                                            
                                            if (allStackRunsResponse.ok) {
                                                const allStackRuns = await allStackRunsResponse.json();
                                                
                                                if (allStackRuns && allStackRuns.length > 0) {
                                                    const latestStackRun = allStackRuns[0];
                                                    hostLog(logPrefix, 'warn', `Found stack run ${latestStackRun.id} with status ${latestStackRun.status}, but no completed result`);
                                                    
                                                    // If task has been running too long, mark as error
                                                    if (diffInSeconds > 120) {
                                                        const updateUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}`;
                                                        await fetch(updateUrl, {
                                                            method: 'PATCH',
                                                            headers: {
                                                                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                                                                'apikey': SERVICE_ROLE_KEY,
                                                                'Content-Type': 'application/json',
                                                                'Prefer': 'return=minimal'
                                                            },
                                                            body: JSON.stringify({
                                                                status: 'error',
                                                                error: { message: 'Task execution timed out after 120 seconds' },
                                                                updated_at: new Date().toISOString(),
                                                                ended_at: new Date().toISOString()
                                                            })
                                                        });
                                                        
                                                        taskRun.status = 'error';
                                                        taskRun.error = { message: 'Task execution timed out after 120 seconds' };
                                                        taskRun.updated_at = new Date().toISOString();
                                                        taskRun.ended_at = new Date().toISOString();
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            hostLog(logPrefix, 'error', `Error checking for completed stack runs: ${e instanceof Error ? e.message : String(e)}`);
                                        }
                                    }
                                }
                            }
                        } catch (altError) {
                            hostLog(logPrefix, 'error', `Error checking alternative stack runs query: ${altError instanceof Error ? altError.message : String(altError)}`);
                        }
                    }
                } else {
                    const stackRunError = await stackRunResponse.text();
                    hostLog(logPrefix, 'error', `Failed to check for completed stack runs: ${stackRunError}`);
                }
            } catch (e) {
                hostLog(logPrefix, 'error', `Error checking for completed stack runs: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        
        hostLog(logPrefix, 'info', `Returning task run with status: ${taskRun.status}`);
        
        // Extra handling for error states to make debugging easier
        if (taskRun.status === 'error') {
            hostLog(logPrefix, 'warn', `Task in error state. Error details: ${JSON.stringify(taskRun.error || 'No error details available')}`);
        }
        
        return new Response(
            simpleStringify(taskRun),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in statusHandler: ${errorMessage}`);
        return new Response(
            simpleStringify({ error: `Internal server error: ${errorMessage}` }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
}

// Helper function to handle task logs requests
async function logsHandler(req: Request): Promise<Response> {
    // Extract taskRunId from query params in URL for GET requests
    const url = new URL(req.url);
    const taskRunId = url.searchParams.get('id');
    
    const logPrefix = `[tasks/logs/${taskRunId}]`;
    
    hostLog(logPrefix, 'info', `Received logs request for task run ID: ${taskRunId}`);
    
    if (!taskRunId) {
        return new Response(
            simpleStringify({ error: 'Missing taskRunId parameter' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        // Determine the correct baseUrl for database access
        const extSupabaseUrl = Deno.env.get("EXT_SUPABASE_URL") || "";
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
        
        // Use Kong URL for local development or when EXT_SUPABASE_URL is missing
        const useKong = extSupabaseUrl.includes('localhost') || 
                       extSupabaseUrl.includes('127.0.0.1') || 
                       !extSupabaseUrl;
                       
        const baseUrl = useKong 
            ? 'http://kong:8000/rest/v1' 
            : `${SUPABASE_URL}/rest/v1`;
        
        // Fetch task run from database
        const dbUrl = `${baseUrl}/task_runs?id=eq.${taskRunId}&select=*`;
        hostLog(logPrefix, 'info', `Attempting to fetch task run from: ${dbUrl}`);
        
        const response = await fetch(dbUrl, {
            headers: {
                'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
                'apikey': SERVICE_ROLE_KEY
            }
        });
        
        if (!response.ok) {
            const error = await response.text();
            const errorMessage = `Database query failed: ${error}`;
            hostLog(logPrefix, 'error', errorMessage);
            return new Response(
                simpleStringify({ error: `Failed to fetch task logs: ${errorMessage}` }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const tasks = await response.json();
        hostLog(logPrefix, 'info', `Database query successful. Found ${tasks.length} records.`);
        
        if (tasks.length === 0) {
            return new Response(
                simpleStringify({ error: `Task run with ID ${taskRunId} not found` }),
                { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }
        
        const taskRun = tasks[0];
        
        // Check for long-running tasks or special cases
        if (taskRun.status === 'queued' || taskRun.status === 'processing') {
            const createdAt = new Date(taskRun.created_at);
            const now = new Date();
            const diffInSeconds = Math.floor((now.getTime() - createdAt.getTime()) / 1000);
            
            // For long-running tasks, check if waiting on something
            if (diffInSeconds > 60 && taskRun.waiting_on_stack_run_id) {
                hostLog(logPrefix, 'warn', `Task has been running for ${diffInSeconds}s and is waiting on stack run ${taskRun.waiting_on_stack_run_id}`);
                // Continue processing to return available logs
            }
        }
        
        // Get logs from the task run
        const logs = taskRun.logs || [];
        
        // Also check for vm_logs
        const vmLogs = taskRun.vm_logs || [];
        
        return new Response(
            simpleStringify({ 
                logs,
                vm_logs: vmLogs
            }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        hostLog(logPrefix, 'error', `Exception in logsHandler: ${errorMessage}`);
        return new Response(
            simpleStringify({ error: `Internal server error: ${errorMessage}` }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
}

// Start the Deno server and pass the tasksHandler for incoming requests
serve(async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname.split("/").filter(Boolean); // Remove empty segments
    
    // Log request
    hostLog(LOG_PREFIX_BASE, 'info', `Received request: ${req.method} ${url.pathname}`);
    
    try {
        // Routes handler
        if (path.length >= 2 && path[0] === "tasks") {
            if (path[1] === "execute") {
                // Execute a task: POST /tasks/execute
                return tasksHandler(req);
            } else if (path[1] === "status") {
                // Get task status: GET /tasks/status?id=xyz
                return statusHandler(req);
            } else if (path[1] === "logs") {
                // Get task logs: GET /tasks/logs?id=xyz
                return logsHandler(req);
            } else {
                // Default route for backward compatibility
                return tasksHandler(req);
            }
        }
        
        // Handle root request or unknown paths
        return new Response(simpleStringify({
            service: "Tasker Edge Function",
            version: "1.0.0",
            status: "running",
            endpoints: [
                "/tasks/execute [POST] - Execute a task",
                "/tasks/status [GET] - Get task status",
                "/tasks/logs [GET] - Get task logs"
            ]
        }), {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX_BASE, 'error', "Unhandled error in request handler:", error.message);
        return new Response(simpleStringify({ 
            error: "Internal server error", 
            message: error.message 
        }), {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
    }
});