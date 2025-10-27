/**
 * FlowState-Powered Deno Executor for Tasker
 *
 * Integrates FlowState library for automatic pause/resume on external calls
 * while maintaining compatibility with existing HTTP-based stack processing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// No imports from shared dependencies to avoid compilation errors

// No FlowState import - using HTTP-based service calls for all external operations

// ==============================
// Utility Functions
// ==============================

/**
 * Simple logging function to replace hostLog from utils
 */
function hostLog(prefix: string, level: 'info' | 'error' | 'warn', message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [${prefix}] ${message}`);
}

/**
 * Simple stringification function
 */
function simpleStringify(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (error) {
    return String(obj);
  }
}

// ==============================
// Minimal Service Registry
// ==============================

/**
 * Minimal service registry implementation to avoid shared dependency issues
 */
class MinimalServiceRegistry {
  private supabaseUrl: string;
  private serviceKey: string;

  constructor() {
    this.supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    this.serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  }

  /**
   * Make a direct HTTP call to a wrapped service
   */
  async call(serviceName: string, method: string, params: any): Promise<any> {
    const logPrefix = `ServiceRegistry-${serviceName}`;

    try {
      // Map service names to actual function names
      const serviceMap: Record<string, string> = {
        'database': 'wrappedsupabase',
        'keystore': 'wrappedkeystore',
        'openai': 'wrappedopenai',
        'websearch': 'wrappedwebsearch',
        'gapi': 'wrappedgapi'
      };

      const actualServiceName = serviceMap[serviceName] || serviceName;
      const url = `${this.supabaseUrl}/functions/v1/${actualServiceName}`;

      hostLog(logPrefix, "info", `Calling ${serviceName}.${method} via HTTP`);

      // Special handling for processChain - unwrap params if it's wrapped in an object
      let requestBody;
      if (method === 'processChain') {
        // params might be [{ chain: [...] }] or just the chain array
        const actualChain = (Array.isArray(params) && params.length === 1 && params[0].chain)
          ? params[0].chain
          : params;
        requestBody = { chain: actualChain };
      } else {
        requestBody = { chain: [{ property: method, args: params }] };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Service call failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      hostLog(logPrefix, "info", `${serviceName}.${method} call completed successfully`);
      return result;

    } catch (error) {
      hostLog(logPrefix, "error", `Service call failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Make database calls directly to avoid service registry complexity
   */
  async databaseCall(table: string, action: string, params: any): Promise<any> {
    const logPrefix = `DatabaseCall-${table}`;

    try {
      const url = `${this.supabaseUrl}/functions/v1/wrappedsupabase`;

      hostLog(logPrefix, "info", `Database ${action} on ${table}`);

      // wrappedsupabase expects { chain: [...] } format, not { action, table, ...params }
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chain: params  // params is already the chain array from the caller
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Database call failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      hostLog(logPrefix, "info", `Database ${action} on ${table} completed`);
      return result;

    } catch (error) {
      hostLog(logPrefix, "error", `Database call failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

// Create minimal service registry instance
const serviceRegistry = new MinimalServiceRegistry();

// HTTP-based execution result types
interface ExecutionResult {
  status: 'completed' | 'paused' | 'error';
  result?: any;
  error?: string;
  suspensionData?: any;
}

// Simple types
interface SerializedVMState {
  [key: string]: any;
}

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Simple UUID generator
function generateUUID(): string {
  return crypto.randomUUID();
}





// ==============================
// Configuration
// ==============================

// Define CORS headers for HTTP responses
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ==============================
// External Call System
// ==============================

/**
 * Make an external service call using the service registry
 * Creates a child stack run and returns suspension data
 */
async function makeExternalCall(
  serviceName: string,
  methodPath: string[],
  args: any[],
  taskRunId: string,
  stackRunId: string
): Promise<any> {
  const logPrefix = `DenoExecutor-${taskRunId}`;

  hostLog(logPrefix, "info", `External call requested: ${serviceName}.${methodPath.join('.')} - creating child stack run`);

  // Map service names to actual function names
  const serviceMap: Record<string, string> = {
    'database': 'wrappedsupabase',
    'keystore': 'wrappedkeystore',
    'openai': 'wrappedopenai',
    'websearch': 'wrappedwebsearch',
    'gapi': 'wrappedgapi'
  };

  const actualServiceName = serviceMap[serviceName] || serviceName;

  // Call wrappedsupabase directly using proper Supabase chain format
  const insertResult = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/wrappedsupabase`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chain: [
        { property: 'from', args: ['stack_runs'] },
        { property: 'insert', args: [[{
          parent_task_run_id: parseInt(taskRunId),
          parent_stack_run_id: parseInt(stackRunId),
          service_name: actualServiceName,
          method_name: methodPath.join('.'),
          args: args,
          status: 'pending',
          vm_state: null,
          waiting_on_stack_run_id: null,
          resume_payload: null
        }]] },
        { property: 'select', args: [] }
      ]
    })
  }).then(r => r.json());

  if (!insertResult.success || !insertResult.data) {
    throw new Error(`Failed to save stack run via service registry: ${insertResult.error || 'Unknown error'}`);
  }

  hostLog(logPrefix, "info", `Insert result: ${JSON.stringify(insertResult)}`);

  // The response structure varies - try different unwrapping paths
  let insertedRecords = insertResult.data?.data?.data ||  // Full wrapping
                        insertResult.data?.data ||         // Single wrapping
                        insertResult.data;                 // No wrapping

  hostLog(logPrefix, "info", `Inserted records: ${JSON.stringify(insertedRecords)}`);

  if (!insertedRecords || !Array.isArray(insertedRecords) || insertedRecords.length === 0) {
    throw new Error(`Failed to get inserted stack run from service registry response. insertResult structure: ${JSON.stringify(insertResult)}`);
  }

  const actualChildStackRunId = insertedRecords[0]?.id;

  if (!actualChildStackRunId) {
    throw new Error('Failed to get child stack run ID from inserted record');
  }

  hostLog(logPrefix, "info", `Created child stack run ${actualChildStackRunId} for ${serviceName}.${methodPath.join('.')}`);

  // Call wrappedsupabase directly using proper Supabase chain format
  const updateResult = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/wrappedsupabase`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chain: [
        { property: 'from', args: ['stack_runs'] },
        { property: 'update', args: [{
          status: 'suspended_waiting_child',
          waiting_on_stack_run_id: actualChildStackRunId,
          updated_at: new Date().toISOString()
        }] },
        { property: 'eq', args: ['id', parseInt(stackRunId)] }
      ]
    })
  }).then(r => r.json());

  if (!updateResult.success || !updateResult.data) {
    throw new Error(`Failed to update stack run status: ${updateResult.error || 'Unknown error'}`);
  }

  hostLog(logPrefix, "info", `Updated stack run ${stackRunId} to suspended_waiting_child, waiting on ${actualChildStackRunId}`);

  // Create a suspension object that tells the stack processor to wait for this child
  const suspensionData = {
    __hostCallSuspended: true,
    serviceName,
    methodPath,
    args,
    taskRunId,
    stackRunId: actualChildStackRunId  // Return the child stack run ID
  };

  // Throw a special error that contains the suspension data
  // This will stop task execution immediately and be caught by the executor
  const suspensionError = new Error(`TASK_SUSPENDED`);
  (suspensionError as any).suspensionData = suspensionData;
  throw suspensionError;
}

// ==============================
// Secure Sandbox Environment
// ==============================

/**
 * Secure sandbox for executing task code with proper isolation
 */
class SecureSandbox {
  private taskRunId: string;
  private stackRunId: string;
  private taskName: string;
  private logPrefix: string;

  constructor(taskRunId: string, stackRunId: string, taskName: string) {
    this.taskRunId = taskRunId;
    this.stackRunId = stackRunId;
    this.taskName = taskName;
    this.logPrefix = `Sandbox-${taskName}`;
  }

  /**
   * Execute task code in a secure environment
   */
  async execute(taskCode: string, taskInput: any, initialVmState?: SerializedVMState, taskGlobal?: any): Promise<any> {
    hostLog(this.logPrefix, "info", `Executing task in secure sandbox`);

    try {
      // Create a fresh global context for the task if not provided
      if (!taskGlobal) {
        taskGlobal = this.createTaskGlobal();
      }

      // Handle resume payload if present
      if (initialVmState?.resume_payload) {
        taskGlobal._resume_payload = initialVmState.resume_payload;
        hostLog(this.logPrefix, "info", `Resume payload available for task execution`);
      }

      taskGlobal.__callHostTool__ = async function(serviceName: string, methodPath: string | string[], args: any[]) {
        const methodArray = Array.isArray(methodPath) ? methodPath : [methodPath];
        return await makeExternalCall(serviceName, methodArray, args, taskGlobal._taskRunId, taskGlobal._stackRunId);
      };

      // Execute the task code in the sandbox
      const taskFunction = this.compileTaskCode(taskCode, taskGlobal);

      // Execute the task with input
      const result = await taskFunction(taskInput);

      hostLog(this.logPrefix, "info", `Task execution completed successfully`);
      return result;

    } catch (error) {
      hostLog(this.logPrefix, "error", `Task execution failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Create a secure global context for task execution
   */
  private createTaskGlobal(): any {
    return {
      // Console that forwards to host logging
      console: {
        log: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "info", message);
        },
        error: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "error", message);
        },
        warn: (...args: any[]) => {
          const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
          hostLog(this.logPrefix, "warn", message);
        }
      },

      // Host logging function
      _hostLog: (level: string, message: string) => {
        hostLog(this.logPrefix, level as any, message);
      },

      // Global context for call tracking
      _taskRunId: this.taskRunId,
      _stackRunId: this.stackRunId,

      // Resume payload (will be set if available)
      _resume_payload: undefined,

      // Safe standard objects
      Object,
      Array,
      String,
      Number,
      Boolean,
      Date,
      Math,
      JSON,
      RegExp,

      // Async utilities
      Promise,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,

      // Crypto utilities
      crypto: {
        randomUUID: () => crypto.randomUUID()
      },

      // Module exports
      module: { exports: {} },
      exports: {}
    };
  }

  /**
   * Compile and prepare task code for execution
   */
  private compileTaskCode(taskCode: string, taskGlobal: any): (input: any) => Promise<any> {
    try {
      hostLog(this.logPrefix, "info", `Compiling task code...`);

      // Initialize module object in global scope
      taskGlobal.module = { exports: {} };
      taskGlobal.exports = taskGlobal.module.exports;

      // Execute the task code directly in the global context to set up module.exports
      hostLog(this.logPrefix, "info", `Evaluating task code to set up module.exports...`);

      // Create a function that will execute the task code in the proper context
      // We need to provide module, exports, console, and __callHostTool__ as parameters
      const executeTaskCode = new Function(
        'module',
        'exports',
        'console',
        '__callHostTool__',
        `
        try {
          // The task code should have access to module and exports
          ${taskCode}
          return module.exports;
        } catch (error) {
          console.error('Task code execution error:', error);
          throw error;
        }
      `);

      // Execute the task code to set up module.exports with the proper context
      const moduleExports = executeTaskCode(
        taskGlobal.module,
        taskGlobal.exports,
        taskGlobal.console,
        taskGlobal.__callHostTool__
      );
      hostLog(this.logPrefix, "info", `Task code executed, module.exports type: ${typeof moduleExports}`);

      // Find the actual task function
      let taskHandler = moduleExports;

      // If module.exports is not a function, look for a function property
      if (typeof taskHandler !== 'function') {
        if (typeof moduleExports === 'object' && moduleExports !== null) {
          const functionNames = Object.keys(moduleExports);
          for (const name of functionNames) {
            if (typeof moduleExports[name] === 'function') {
              taskHandler = moduleExports[name];
              hostLog(this.logPrefix, "info", `Found function '${name}' in module.exports`);
              break;
            }
          }
        }
      }

      // If still not a function, check the global scope for any exported functions
      if (typeof taskHandler !== 'function') {
        const globalFunctionNames = Object.keys(taskGlobal);
        for (const name of globalFunctionNames) {
          if (name !== 'module' && name !== 'exports' && typeof taskGlobal[name] === 'function') {
            taskHandler = taskGlobal[name];
            hostLog(this.logPrefix, "info", `Found function '${name}' in global scope`);
            break;
          }
        }
      }

      if (typeof taskHandler !== 'function') {
        throw new Error(`No valid function found in task code. Module exports type: ${typeof moduleExports}, Available functions: ${Object.keys(taskGlobal).filter(k => typeof taskGlobal[k] === 'function').join(', ')}`);
      }

      hostLog(this.logPrefix, "info", `Task handler extracted successfully: ${typeof taskHandler}`);
      return taskHandler;
    } catch (error) {
      hostLog(this.logPrefix, "error", `Failed to compile task code: ${error instanceof Error ? error.message : String(error)}`);
      hostLog(this.logPrefix, "error", `Task code preview: ${taskCode.substring(0, 200)}...`);
      throw error;
    }
  }
}

/**
 * Create a secure sandbox for task execution
 */
function createSecureSandbox(taskRunId: string, stackRunId: string, taskName: string): SecureSandbox {
  return new SecureSandbox(taskRunId, stackRunId, taskName);
}

/**
 * Extract suspension data from a suspension error
 */
async function extractSuspensionDataFromError(error: Error, taskRunId: string, stackRunId: string): Promise<any> {
  const logPrefix = `SuspensionExtractor-${taskRunId}`;

  try {
    hostLog(logPrefix, "info", `Extracting suspension data from error: ${error.message}`);

    // Check if the error already has suspensionData attached (from makeExternalCall)
    if ((error as any).suspensionData) {
      hostLog(logPrefix, "info", `Found suspension data attached to error`);
      return (error as any).suspensionData;
    }

    // Parse the suspension error to extract call context
    const errorMatch = error.message.match(/TASK_SUSPENDED: External call to (\w+)\.([^ ]+) needs suspension/);
    if (!errorMatch) {
      throw new Error('Invalid suspension error format');
    }

    const serviceName = errorMatch[1];
    const methodPath = errorMatch[2].split('.');

    hostLog(logPrefix, "info", `Parsed external call: ${serviceName}.${methodPath.join('.')}`);

    // For now, we'll create a basic suspension structure
    // In a real implementation, you'd extract this from the call context
    const suspensionData = await makeExternalCall(serviceName, methodPath, [], taskRunId, stackRunId);

    return suspensionData;

  } catch (extractError) {
    hostLog(logPrefix, "error", `Failed to extract suspension data: ${extractError instanceof Error ? extractError.message : String(extractError)}`);
    throw extractError;
  }
}

// ==============================
// Task Execution
// ==============================

/**
 * Execute a task using HTTP-based FlowState with enhanced pause/resume capabilities
 */
async function executeTask(
  taskCode: string,
  taskName: string,
  taskInput: any,
  taskRunId: string,
  stackRunId: string,
  toolNames?: string[],
  initialVmState?: SerializedVMState
): Promise<any> {
  const logPrefix = `FlowStateExecutor-${taskName}`;

  try {
    const startTime = Date.now();
    hostLog(logPrefix, "info", `Executing HTTP-based FlowState task: ${taskName}`);

    // Monitor memory usage if available
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    // Create a secure sandbox environment
    const sandbox = createSecureSandbox(taskRunId, stackRunId, taskName);

    // Execute the task in the sandbox
    const result = await sandbox.execute(taskCode, taskInput, initialVmState);

    hostLog(logPrefix, "info", `HTTP-based FlowState execution completed`);

    // Monitor memory usage after execution
    if (typeof Deno !== 'undefined' && Deno.memoryUsage) {
      const memUsage = Deno.memoryUsage();
      hostLog(logPrefix, "info", `Final memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);
    }

    return result;

  } catch (error) {
    hostLog(logPrefix, "error", `HTTP-based FlowState execution failed: ${error instanceof Error ? error.message : String(error)}`);

    // Check if this is a suspension error
    if (error instanceof Error && error.message.includes('TASK_SUSPENDED')) {
      // Extract suspension data from the error
      const suspensionData = await extractSuspensionDataFromError(error, taskRunId, stackRunId);
      return suspensionData;
    }

    throw error;
  }
}

// ==============================
// HTTP Handlers
// ==============================

/**
 * Handle execute requests
 */
async function handleExecuteRequest(req: Request): Promise<Response> {
  const logPrefix = "DenoExecutor-HandleExecute";
  
  try {
    // Handle GET requests for health checks
    if (req.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'Deno Task Executor',
        version: '1.0.0',
        serviceRegistry: 'minimal'
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    const requestData = await req.json();
    const { taskCode, taskName, taskInput, taskRunId, stackRunId, toolNames, initialVmState } = requestData;
    
    hostLog(logPrefix, "info", `Received request data: ${JSON.stringify({ taskName, taskRunId, stackRunId })}`);
    
    if (!taskCode || !taskName) {
      return new Response(JSON.stringify({
        error: "Missing taskCode or taskName"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    const result = await executeTask(taskCode, taskName, taskInput, taskRunId, stackRunId, toolNames, initialVmState);
    
    return new Response(JSON.stringify({
      status: 'completed',
      result: result
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    hostLog(logPrefix, "error", `Error in handleExecuteRequest: ${errorMsg}`);
    
    return new Response(JSON.stringify({
      error: errorMsg
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

/**
 * Handle resume requests - resume a suspended task with external call result
 */
async function handleResumeRequest(req: Request): Promise<Response> {
  const logPrefix = "DenoExecutor-Resume";

  try {
    const requestData = await req.json();
    // Accept either naming convention (stackRunId or stackRunIdToResume)
    const stackRunId = requestData.stackRunId || requestData.stackRunIdToResume;
    const result = requestData.result || requestData.resultToInject;

    const resultPreview = result ? JSON.stringify(result).substring(0, 100) : 'undefined';
    hostLog(logPrefix, "info", `Resuming stack run ${stackRunId} with result: ${resultPreview}`);

    // Get the stack run to resume
    const stackRunResult = await serviceRegistry.call('database', 'processChain', [{
      chain: [
        { property: 'from', args: ['stack_runs'] },
        { property: 'select', args: [] },
        { property: 'eq', args: ['id', parseInt(stackRunId)] },
        { property: 'single', args: [] }
      ]
    }]);

    // Check both HTTP success AND inner service success
    // wrappedsupabase returns HTTP 200 with { success: false, error: {...} } on database errors
    const innerServiceResponse = stackRunResult.data;
    const hasInnerError = innerServiceResponse && typeof innerServiceResponse === 'object' &&
                         'success' in innerServiceResponse && innerServiceResponse.success === false;

    // Unwrap triple-wrapped response - .single() returns an object, not an array
    const stackRun = stackRunResult.data?.data?.data || stackRunResult.data?.data || stackRunResult.data;

    if (!stackRunResult.success || hasInnerError || !stackRun) {
      const errorMessage = hasInnerError && innerServiceResponse.error ?
        (typeof innerServiceResponse.error === 'string' ? innerServiceResponse.error : innerServiceResponse.error.message) :
        'Unknown error';

      hostLog(logPrefix, "error", `Stack run query failed:`, {
        httpSuccess: stackRunResult.success,
        innerSuccess: innerServiceResponse?.success,
        innerError: innerServiceResponse?.error,
        errorMessage,
        stackRun,
        fullResult: JSON.stringify(stackRunResult).substring(0, 500)
      });
      throw new Error(`Stack run ${stackRunId} not found: ${errorMessage}`);
    }

    // Get the task run to get task code and input
    const taskRunResult = await serviceRegistry.call('database', 'processChain', [{
      chain: [
        { property: 'from', args: ['task_runs'] },
        { property: 'select', args: [] },
        { property: 'eq', args: ['id', stackRun.parent_task_run_id] },
        { property: 'single', args: [] }
      ]
    }]);

    const innerTaskRunResponse = taskRunResult.data;
    const hasTaskRunError = innerTaskRunResponse && typeof innerTaskRunResponse === 'object' &&
                           'success' in innerTaskRunResponse && innerTaskRunResponse.success === false;

    const taskRun = taskRunResult.data?.data?.data || taskRunResult.data?.data || taskRunResult.data;

    if (!taskRunResult.success || hasTaskRunError || !taskRun) {
      const errorMessage = hasTaskRunError && innerTaskRunResponse.error ?
        (typeof innerTaskRunResponse.error === 'string' ? innerTaskRunResponse.error : innerTaskRunResponse.error.message) :
        'Unknown error';

      hostLog(logPrefix, "error", `Task run query failed:`, {
        httpSuccess: taskRunResult.success,
        innerSuccess: innerTaskRunResponse?.success,
        innerError: innerTaskRunResponse?.error,
        errorMessage
      });
      throw new Error(`Task run ${stackRun.parent_task_run_id} not found: ${errorMessage}`);
    }

    // Get task function code
    const taskFunctionResult = await serviceRegistry.call('database', 'processChain', [{
      chain: [
        { property: 'from', args: ['task_functions'] },
        { property: 'select', args: [] },
        { property: 'eq', args: ['name', taskRun.task_name] },
        { property: 'single', args: [] }
      ]
    }]);

    const innerTaskFunctionResponse = taskFunctionResult.data;
    const hasTaskFunctionError = innerTaskFunctionResponse && typeof innerTaskFunctionResponse === 'object' &&
                                 'success' in innerTaskFunctionResponse && innerTaskFunctionResponse.success === false;

    const taskFunction = taskFunctionResult.data?.data?.data || taskFunctionResult.data?.data || taskFunctionResult.data;

    if (!taskFunctionResult.success || hasTaskFunctionError || !taskFunction) {
      const errorMessage = hasTaskFunctionError && innerTaskFunctionResponse.error ?
        (typeof innerTaskFunctionResponse.error === 'string' ? innerTaskFunctionResponse.error : innerTaskFunctionResponse.error.message) :
        'Unknown error';

      hostLog(logPrefix, "error", `Task function query failed:`, {
        httpSuccess: taskFunctionResult.success,
        innerSuccess: innerTaskFunctionResponse?.success,
        innerError: innerTaskFunctionResponse?.error,
        errorMessage
      });
      throw new Error(`Task function ${taskRun.task_name} not found: ${errorMessage}`);
    }

    // Execute the task with the injected result
    const taskResult = await executeTask(
      taskFunction.code,
      taskRun.task_name,
      taskRun.input,
      stackRun.parent_task_run_id.toString(),
      stackRunId.toString(),
      ["gapi", "keystore", "database"], // Standard tool names
      {
        taskCode: taskFunction.code,
        taskName: taskRun.task_name,
        taskInput: taskRun.input,
        toolNames: ["gapi", "keystore", "database"],
        resume_payload: result
      }
    );

    // Check if the result is a suspension (task paused again)
    if (taskResult && taskResult.__hostCallSuspended === true) {
      hostLog(logPrefix, "info", `Task suspended again during resume, child stack run: ${taskResult.stackRunId}`);

      return new Response(JSON.stringify({
        status: 'paused',
        suspensionData: taskResult
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Task completed successfully
    hostLog(logPrefix, "info", `Task resumed and completed successfully`);

    return new Response(JSON.stringify({
      status: 'completed',
      result: taskResult
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    hostLog(logPrefix, "error", `Task resume failed: ${error instanceof Error ? error.message : String(error)}`);

    // Check if this is a suspension error
    if (error instanceof Error && error.message.includes('TASK_SUSPENDED')) {
      const suspensionData = await extractSuspensionDataFromError(error, stackRun.parent_task_run_id.toString(), stackRunId);

      return new Response(JSON.stringify({
        status: 'paused',
        suspensionData: suspensionData
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

// ==============================
// Main Server
// ==============================

serve(async (req: Request) => {
  try {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    const url = new URL(req.url);
    const path = url.pathname.split('/').pop();
    
    if (path === 'resume') {
      return handleResumeRequest(req);
    } else {
      return handleExecuteRequest(req);
    }
  } catch (error) {
    hostLog("DenoExecutorHandler", "error", `Error in serve function: ${error instanceof Error ? error.message : String(error)}`);
    
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});

console.log("🚀 Deno Task Executor with Unified Service Registry started successfully");
