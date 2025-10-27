import { supabaseClient } from "../config/supabase-config.ts";
import { LOG_PREFIX_BASE } from "../utils/response-utils.ts";
import { hostLog } from "../../_shared/utils.ts";

export async function checkQueueBusy(baseUrl: string, serviceRoleKey: string): Promise<boolean> {
    try {
        const response = await fetch(`${baseUrl}/rest/v1/task_runs?select=id,status&status=eq.running&limit=1`, {
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            hostLog(LOG_PREFIX_BASE, `Failed to check queue status: ${response.status} ${response.statusText}`);
            return false;
        }

        const runningTasks = await response.json();
        return runningTasks.length > 0;
    } catch (error) {
        hostLog(LOG_PREFIX_BASE, `Error checking queue status: ${error}`);
        return false;
    }
}

export async function executeStackRunSynchronously(stackRunId: string, baseUrl: string, serviceRoleKey: string): Promise<{success: boolean, result?: any, error?: string}> {
    hostLog(LOG_PREFIX_BASE, `Starting synchronous execution of stack run: ${stackRunId}`);

    try {
        // 1. Get the stack run details
        const stackRunResponse = await fetch(`${baseUrl}/rest/v1/stack_runs?id=eq.${stackRunId}&select=*`, {
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!stackRunResponse.ok) {
            throw new Error(`Failed to fetch stack run: ${stackRunResponse.status}`);
        }

        const stackRuns = await stackRunResponse.json();
        if (!stackRuns || stackRuns.length === 0) {
            throw new Error(`Stack run not found: ${stackRunId}`);
        }

        const stackRun = stackRuns[0];
        const { service_name, method_name, args } = stackRun;

        hostLog(LOG_PREFIX_BASE, `Executing ${service_name}.${method_name} with args: ${JSON.stringify(args)}`);

        // 2. Execute the service call
        const serviceUrl = `http://localhost:8001`;
        const serviceResponse = await fetch(`${serviceUrl}/${service_name}/${method_name}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ args })
        });

        if (!serviceResponse.ok) {
            const errorText = await serviceResponse.text();
            throw new Error(`Service call failed: ${serviceResponse.status} - ${errorText}`);
        }

        const result = await serviceResponse.json();
        hostLog(LOG_PREFIX_BASE, `Service call completed successfully`);

        // 3. Update stack run with result
        const updateResponse = await fetch(`${baseUrl}/rest/v1/stack_runs?id=eq.${stackRunId}`, {
            method: 'PATCH',
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                status: 'completed',
                result: result,
                updated_at: new Date().toISOString()
            })
        });

        if (!updateResponse.ok) {
            throw new Error(`Failed to update stack run: ${updateResponse.status}`);
        }

        hostLog(LOG_PREFIX_BASE, `Stack run ${stackRunId} completed successfully`);
        return { success: true, result };

    } catch (error) {
        hostLog(LOG_PREFIX_BASE, `Stack run ${stackRunId} failed: ${error}`);

        // Update with error
        try {
            await fetch(`${baseUrl}/rest/v1/stack_runs?id=eq.${stackRunId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': serviceRoleKey,
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                    updated_at: new Date().toISOString()
                })
            });
        } catch (updateError) {
            hostLog(LOG_PREFIX_BASE, `Failed to update stack run with error: ${updateError}`);
        }

        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function triggerFIFOProcessingChain(baseUrl: string, serviceRoleKey: string): Promise<void> {
    try {
        // Use internal kong URL for inter-function communication
        const internalUrl = 'http://kong:8000/functions/v1/simple-stack-processor';

        hostLog(LOG_PREFIX_BASE, `🚀 Triggering FIFO processing chain at ${internalUrl}`);

        const response = await fetch(internalUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trigger: 'process-next' })
        });

        if (!response.ok) {
            const errorText = await response.text();
            hostLog(LOG_PREFIX_BASE, `❌ Failed to trigger FIFO processing: ${response.status} ${response.statusText} - ${errorText}`);
        } else {
            const result = await response.text();
            hostLog(LOG_PREFIX_BASE, `✅ FIFO processing chain triggered successfully: ${result}`);
        }
    } catch (error) {
        hostLog(LOG_PREFIX_BASE, `❌ Error triggering FIFO processing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function triggerNextQueuedTask(baseUrl: string, serviceRoleKey: string): Promise<void> {
    try {
        // Get the next pending task
        const response = await fetch(`${baseUrl}/rest/v1/task_runs?select=id&status=eq.pending&order=created_at.asc&limit=1`, {
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            hostLog(LOG_PREFIX_BASE, `Failed to fetch next queued task: ${response.status}`);
            return;
        }

        const tasks = await response.json();
        if (tasks.length === 0) {
            hostLog(LOG_PREFIX_BASE, `No queued tasks found`);
            return;
        }

        const taskId = tasks[0].id;
        hostLog(LOG_PREFIX_BASE, `Triggering execution for task: ${taskId}`);

        // Update task status to running
        await fetch(`${baseUrl}/rest/v1/task_runs?id=eq.${taskId}`, {
            method: 'PATCH',
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                status: 'running',
                updated_at: new Date().toISOString()
            })
        });

        // Trigger the task execution
        const executeResponse = await fetch(`${baseUrl}/functions/v1/tasks/execute`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                task_identifier: 'comprehensive-gmail-search',
                input: { customer: 'my_customer' }
            })
        });

        if (!executeResponse.ok) {
            hostLog(LOG_PREFIX_BASE, `Failed to execute task: ${executeResponse.status}`);
            // Reset status to pending
            await fetch(`${baseUrl}/rest/v1/task_runs?id=eq.${taskId}`, {
                method: 'PATCH',
                headers: {
                    'apikey': serviceRoleKey,
                    'Authorization': `Bearer ${serviceRoleKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: 'pending',
                    updated_at: new Date().toISOString()
                })
            });
        } else {
            hostLog(LOG_PREFIX_BASE, `Task ${taskId} execution triggered successfully`);
        }

    } catch (error) {
        hostLog(LOG_PREFIX_BASE, `Error triggering next queued task: ${error}`);
    }
}