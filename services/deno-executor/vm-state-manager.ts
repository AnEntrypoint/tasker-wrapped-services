/**
 * VM State Manager for Deno Executor
 * Handles state capture, serialization, storage and restoration for task suspend/resume
 */

// Note: This file maintains the vm-state-manager interface for compatibility
// but no longer uses QuickJS - it's purely for Deno-based task state management
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { hostLog, isUuid } from "../_shared/utils.ts";

// ==============================
// Types and Interfaces
// ==============================

export interface StackRun {
  id: number;
  parent_stack_run_id?: number;
  parent_task_run_id?: number;
  service_name: string;
  method_name: string;
  args: any[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'suspended_waiting_child' | 'pending_resume';
  created_at: string;
  updated_at: string;
  result?: any;
  error?: any;
  resume_payload?: any;
  waiting_on_stack_run_id?: number;
  vm_state?: SerializedVMState;
}

export interface SerializedVMState {
  stackRunId: string;
  taskRunId: string;
  suspended: boolean;
  suspendedAt: string;
  resumeFunction?: string;
  vmSnapshot?: string;
  parentStackRunId?: string;
  waitingOnStackRunId?: number;
  taskCode: string;
  taskName: string;
  taskInput: any;
  resume_payload?: any;
  checkpoint?: { [key: string]: any };
  last_call_result?: any;
}

// ==============================
// Configuration
// ==============================

// Environment variables for Supabase
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// ==============================
// Utility Functions
// ==============================

/**
 * Get configuration for Supabase
 */
function getSupabaseConfig(): { url: string; serviceRoleKey: string } {
  const url = Deno.env.get("SUPABASE_URL") || 
    Deno.env.get("EXT_SUPABASE_URL") || 
    "http://127.0.0.1:8000";
  
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || 
    Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || 
    "";
  
  return { url, serviceRoleKey };
}

/**
 * Generate a UUID (v4)
 */
export function _generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Get a direct Supabase client instance (vm-state-manager needs direct access for QuickJS functionality)
 */
export function getSupabaseClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (!url || !serviceRoleKey) {
    hostLog("VM-State-Manager", "error", "Supabase URL or Service Key is missing. Cannot create client.");
    return null;
  }
  
  // Use direct Supabase client for vm-state-manager (critical for QuickJS functionality)
  return createClient(url, serviceRoleKey);
}

// ==============================
// Stack Run Management
// ==============================

/**
 * Saves a stack run to the database and triggers the stack processor
 * 
 * @param stackRunId Unique ID for the stack run
 * @param serviceName Name of the service being called
 * @param methodName Name of the method being called
 * @param args Arguments for the method call
 * @param parentTaskRunId Optional parent task run ID
 * @param parentStackRunId Optional parent stack run ID
 */
export async function saveStackRun(
  serviceName: string,
  methodName: string,
  args: any[],
  vmState: SerializedVMState,
  parentTaskRunId?: string,
  parentStackRunId?: string
): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase client not available for saveStackRun.");

  hostLog("VM-State-Manager", "info", `Saving stack run for ${serviceName}.${methodName}`);
  
  // Convert UUID strings to integers, or null if they're UUIDs (which means no parent)
  const parentTaskRunIdInt = parentTaskRunId && !isUuid(parentTaskRunId) ? parseInt(parentTaskRunId) : null;
  const parentStackRunIdInt = parentStackRunId && !isUuid(parentStackRunId) ? parseInt(parentStackRunId) : null;
  const waitingOnStackRunIdInt = vmState.waitingOnStackRunId;
  
  const record: Omit<StackRun, 'id' | 'created_at' | 'updated_at'> = {
    parent_task_run_id: parentTaskRunIdInt,
    parent_stack_run_id: parentStackRunIdInt,
    service_name: serviceName,
    method_name: methodName,
    args,
    status: "pending",
    vm_state: vmState,
    waiting_on_stack_run_id: waitingOnStackRunIdInt,
  };
  
  const { data, error } = await supabase
    .from("stack_runs")
    .insert(record as any)
    .select('id')
    .single();
  
  if (error) {
    hostLog("VM-State-Manager", "error", `Error saving stack run: ${error.message}`);
    throw new Error(`Error saving stack run: ${error.message}`);
  }
  
  const newStackRunId = data?.id;
  if (!newStackRunId) {
    throw new Error("Failed to get stack run ID from database");
  }
  
  hostLog("VM-State-Manager", "info", `Successfully saved stack run: ${newStackRunId}`);
  
  hostLog("VM-State-Manager", "debug", `Parent update check - parentStackRunId: ${parentStackRunId}, serviceName: ${serviceName}`);
  
  // CRITICAL FIX: Always update parent stack run when child is created, regardless of service type
  if (parentStackRunId) {
    hostLog("VM-State-Manager", "info", `Updating parent stack run ${parentStackRunId} to wait for child ${newStackRunId}`);
    
    const { error: parentUpdateError } = await supabase
      .from("stack_runs")
      .update({
        waiting_on_stack_run_id: newStackRunId,
        status: "suspended_waiting_child",
        updated_at: new Date().toISOString()
      })
      .eq('id', parentStackRunId);
    
    if (parentUpdateError) {
      hostLog("VM-State-Manager", "error", `Error updating parent stack run ${parentStackRunId}: ${parentUpdateError.message}`);
    } else {
      hostLog("VM-State-Manager", "info", `Parent stack run ${parentStackRunId} updated to wait for ${newStackRunId}`);
    }
  }
  
  if (parentTaskRunId && vmState.suspended) {
    hostLog("VM-State-Manager", "info", `Updating parent task run ${parentTaskRunId} to suspended, waiting on ${newStackRunId}`);
    await updateTaskRun(
      parentTaskRunId, 
      'suspended', 
      undefined,
      undefined,
      newStackRunId
    );
  }
  
  if (record.status === 'pending') {
    await triggerStackProcessor();
  }
  
  return newStackRunId;
}

/**
 * Triggers the stack processor to process the next stack run (fire-and-forget)
 */
export function triggerStackProcessor(): void {
  const { url, serviceRoleKey } = getSupabaseConfig();

  if (!serviceRoleKey) {
    hostLog("VM-State-Manager", "error", "Missing service role key");
    return;
  }

  hostLog("VM-State-Manager", "info", "Triggering stack processor (async)...");

  // Fire-and-forget - don't wait for response
  setTimeout(() => {
    fetch(`${url}/functions/v1/simple-stack-processor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        trigger: "process-next"
      })
    }).catch(error => {
      hostLog("VM-State-Manager", "warn", `Async stack processor trigger failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 0);
}

/**
 * Gets a stack run from the database by ID
 */
export async function getStackRun(stackRunId: string): Promise<StackRun | null> {
  hostLog("VM State Manager", "info", `Getting stack run: ${stackRunId}`);
  
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  
  try {
    const { data, error } = await supabase
      .from('stack_runs')
      .select('*')
      .eq('id', stackRunId)
      .maybeSingle();

    if (error) {
      throw new Error(`Error getting stack run: ${error.message}`);
    }
    
    return data ? data as StackRun : null;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error getting stack run: ${errorMessage}`);
    throw new Error(`Failed to get stack run: ${errorMessage}`);
  }
}

/**
 * Updates a stack run's status and optional result/error
 */
export async function updateStackRun(
  stackRunId: string,
  status: StackRun['status'],
  result?: unknown,
  error?: unknown,
  resumePayload?: unknown
): Promise<void> {
  hostLog("VM State Manager", "info", `Updating stack run ${stackRunId} to status: ${status}`);
  const supabase = getSupabaseClient();
  if (!supabase) {
    hostLog("VM-State-Manager", "error", `updateStackRun: Supabase client not available for ${stackRunId}.`);
    throw new Error("Supabase client unavailable for updateStackRun.");
  }

  try {
    const updateData: Partial<StackRun> = {
      status,
      updated_at: new Date().toISOString()
    };
    
    if (result !== undefined) updateData.result = result;
    if (error !== undefined) updateData.error = error;
    if (resumePayload !== undefined) updateData.resume_payload = resumePayload;
    if (status === 'completed' || status === 'failed') {
        // Ensure vm_state is cleared on terminal states if it's large and no longer needed for resume
        // updateData.vm_state = null; // Or set to specific minimal state if required for history
    }
    
    const { error: updateError } = await supabase
      .from('stack_runs')
      .update(updateData)
      .eq('id', stackRunId);
      
    if (updateError) {
      hostLog("VM-State-Manager", "error", `Error updating stack run: ${updateError.message}`);
      throw updateError;
    }
    hostLog("VM-State-Manager", "info", `Stack run ${stackRunId} updated successfully to status: ${status}.`);
  } catch (dbError: unknown) {
    const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
    hostLog("VM-State-Manager", "error", `Exception updating stack run ${stackRunId}: ${errorMessage}`);
    throw dbError;
  }
}

/**
 * Gets pending stack runs from the database
 */
export async function getPendingStackRuns(limit = 10): Promise<StackRun[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('stack_runs')
      .select('*')
      .in('status', ['pending', 'pending_resume'])
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      hostLog("VM State Manager", "error", `Error fetching pending stack runs: ${error.message}`);
      return [];
    }
    return (data as StackRun[]) || [];
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error in getPendingStackRuns: ${errorMessage}`);
    return [];
  }
}

/**
 * Cleans up a completed stack run by deleting it from the database
 */
export async function cleanupStackRun(stackRunId: string): Promise<void> {
  hostLog("VM State Manager", "info", `Cleaning up completed stack run: ${stackRunId}`);
  
  const supabase = getSupabaseClient();
  if (!supabase) return;
  
  try {
    const { error } = await supabase
      .from('stack_runs')
      .delete()
      .eq('id', stackRunId);
      
    if (error) {
      hostLog("VM State Manager", "error", `Error deleting stack run: ${error.message}`);
    } else {
      hostLog("VM State Manager", "info", `Successfully cleaned up stack run ${stackRunId}`);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM State Manager", "error", `Error cleaning up stack run: ${errorMessage}`);
  }
}

// ==============================
// Task Run Management
// ==============================

/**
 * Updates a task run status, result and error
 */
export async function updateTaskRun(
  taskRunId: string,
  status: 'processing' | 'completed' | 'failed' | 'suspended',
  result?: unknown,
  error?: unknown,
  waitingOnStackRunId?: number
): Promise<void> {
  if (!taskRunId) {
    hostLog("VM-State-Manager", "warn", "updateTaskRun: No task run ID provided, skipping update.");
    return;
  }
  hostLog("VM-State-Manager", "info", `Updating task run ${taskRunId} to status: ${status}`);
  const supabase = getSupabaseClient();
  if (!supabase) {
     hostLog("VM-State-Manager", "error", `updateTaskRun: Supabase client not available for ${taskRunId}.`);
     return;
  }
  
  try {
    const updateData: Partial<any> = {
      status,
      updated_at: new Date().toISOString()
    };

    if (result !== undefined) updateData.result = result;
    if (error !== undefined) updateData.error = error;
    if (waitingOnStackRunId !== undefined) updateData.waiting_on_stack_run_id = waitingOnStackRunId;
    else if (status !== 'suspended') updateData.waiting_on_stack_run_id = null;

    if (status === 'completed' || status === 'failed') {
      updateData.ended_at = new Date().toISOString();
      updateData.suspended_at = null;
    } else if (status === 'suspended') {
      updateData.suspended_at = new Date().toISOString();
    }
    
    const { error: updateError } = await supabase
      .from('task_runs')
      .update(updateData)
      .eq('id', taskRunId);

    if (updateError) {
      throw new Error(`DB error updating task run ${taskRunId}: ${updateError.message}`);
    }
    hostLog("VM-State-Manager", "info", `Task run ${taskRunId} updated successfully to ${status}.`);
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    hostLog("VM-State-Manager", "error", `Exception updating task run ${taskRunId}: ${errorMessage}`);
  }
}

// ==============================
// VM State Management
// ==============================

/**
 * Captures VM state information to be serialized and stored
 */
export function captureVMState(
  ctx: any,
  taskRunId: string | undefined, 
  waitingOnStackRunId: number | undefined,
  taskCode?: string,
  taskName?: string,
  taskInput?: any,
  parentStackRunId?: string,
  executionContext?: any,
  currentStackRunId?: string
): SerializedVMState {
  hostLog("VM-State-Manager", "info", `Capturing VM state for taskRun: ${taskRunId}, waitingOn: ${waitingOnStackRunId}, currentStackRunId: ${currentStackRunId}`);
  
  // CRITICAL FIX: Use the actual current stack run ID, not a generated UUID
  // If no currentStackRunId is provided, generate one as fallback but log a warning
  const actualStackRunId = currentStackRunId || (() => {
    const fallbackId = _generateUUID();
    hostLog("VM-State-Manager", "warn", `No currentStackRunId provided, using fallback UUID: ${fallbackId}`);
    return fallbackId;
  })();
  
  // Try to extract execution context from the suspend info if available
  let checkpoint = {};
  if (executionContext) {
    checkpoint = { executionContext };
    hostLog("VM-State-Manager", "info", `Including execution context in checkpoint: ${JSON.stringify(Object.keys(executionContext))}`);
  } else if (ctx && ctx.getProp) {
    // Try to extract from global __suspendInfo__ if context not directly provided
    try {
      const suspendInfoHandle = ctx.getProp(ctx.global, "__suspendInfo__");
      if (ctx.typeof(suspendInfoHandle) === "object") {
        const suspendInfo = ctx.dump(suspendInfoHandle);
        if (suspendInfo?.executionContext) {
          checkpoint = { executionContext: suspendInfo.executionContext };
          hostLog("VM-State-Manager", "info", `Extracted execution context from suspend info: ${JSON.stringify(Object.keys(suspendInfo.executionContext))}`);
        }
        suspendInfoHandle.dispose();
      }
    } catch (extractError) {
      hostLog("VM-State-Manager", "warn", `Failed to extract execution context: ${extractError instanceof Error ? extractError.message : String(extractError)}`);
    }
  }
  
  hostLog("VM-State-Manager", "info", `VM state captured with stackRunId: ${actualStackRunId}, taskRunId: ${taskRunId}, parentStackRunId: ${parentStackRunId}`);
  
  return {
    stackRunId: actualStackRunId,
    taskRunId: taskRunId || _generateUUID(),
    suspended: true,
    suspendedAt: new Date().toISOString(),
    waitingOnStackRunId,
    taskCode: taskCode || "",
    taskName: taskName || "",
    taskInput: taskInput || {},
    parentStackRunId: parentStackRunId,
    checkpoint: checkpoint
  };
}

/**
 * Prepare a stack run for resumption by updating its VM state with the result
 */
export async function prepareStackRunResumption(
  parentStackRunId: string,
  childStackRunId: string | number,
  childResult: any
): Promise<boolean> {
  hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Preparing stack run ${parentStackRunId} for resumption with result from ${childStackRunId}`);
  hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Child result type: ${typeof childResult}, keys: ${childResult && typeof childResult === 'object' ? Object.keys(childResult).join(', ') : 'N/A'}`);
  
  try {
    const parentStackRun = await getStackRun(parentStackRunId);
    if (!parentStackRun) {
      hostLog("VM-State-Manager", "error", `🔧 DEBUGGING: Parent stack run ${parentStackRunId} not found`);
      return false;
    }

    hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Parent stack run found, status: ${parentStackRun.status}`);

    if (!parentStackRun.vm_state) {
      hostLog("VM-State-Manager", "error", `🔧 DEBUGGING: Parent stack run ${parentStackRunId} has no VM state`);
      return false;
    }

    hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Parent VM state keys: ${Object.keys(parentStackRun.vm_state).join(', ')}`);

    // Update the VM state with the resume payload
    const updatedVmState: SerializedVMState = {
      ...parentStackRun.vm_state,
      last_call_result: childResult,
      resume_payload: childResult,
      suspended: true,
      waitingOnStackRunId: typeof childStackRunId === 'string' ? parseInt(childStackRunId) : childStackRunId,
      checkpoint: {
        ...parentStackRun.vm_state.checkpoint,
        completedServiceCall: {
          stackRunId: childStackRunId,
          result: childResult
        }
      }
    };

    // Update the parent stack run with the new VM state and mark it as ready to resume
    hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Updating parent stack run ${parentStackRunId} to pending_resume status`);
    await updateStackRun(parentStackRunId, 'pending_resume', null, null, childResult);
    
    // Update the VM state in the database
    const supabase = getSupabaseClient();
    if (supabase) {
      hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Updating VM state in database for stack run ${parentStackRunId}`);
      const { error } = await supabase
        .from('stack_runs')
        .update({ 
          vm_state: updatedVmState,
          updated_at: new Date().toISOString()
        })
        .eq('id', parentStackRunId);

      if (error) {
        hostLog("VM-State-Manager", "error", `🔧 DEBUGGING: Error updating VM state for stack run ${parentStackRunId}: ${error.message}`);
        return false;
      }
      hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: VM state updated successfully for stack run ${parentStackRunId}`);
    }

    hostLog("VM-State-Manager", "info", `🔧 DEBUGGING: Stack run ${parentStackRunId} prepared for resumption successfully`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    hostLog("VM-State-Manager", "error", `Error preparing stack run resumption: ${errorMessage}`);
    return false;
  }
}
