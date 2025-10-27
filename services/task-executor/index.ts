import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve, ConnInfo } from "https://deno.land/std@0.201.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { jsonResponse, formatTaskResult, formatLogMessage } from "./utils/response-formatter.ts";
import { TaskRegistry } from "./registry/task-registry.ts";
import { generateSchema, formatSchema } from './services/schema-generator.ts';
import { parseJSDocComments } from './utils/jsdoc-parser.ts';
import { GeneratedSchema } from "./types/index.ts";
import { hostLog, simpleStringify } from '../_shared/utils.ts';
import { supabaseClient, SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_ROLE_KEY } from './config/supabase-config.ts';
import { tasksService } from './services/tasks-service.ts';
import { createResponse, createErrorResponse, createCorsPreflightResponse, CORS_HEADERS, LOG_PREFIX_BASE } from './utils/response-utils.ts';
import { checkQueueBusy, executeStackRunSynchronously, triggerFIFOProcessingChain, triggerNextQueuedTask } from './services/stack-processor.ts';
import { serviceRegistry } from "../_shared/service-registry.ts";

declare global {
  var __updatedFields: Record<string, any>;
}

// Route mapping - extract just the pathname part for routing
const routes: Record<string, (req: Request) => Promise<Response>> = {
    '/': tasksHandler,
    '/execute': executeHandler,
    '/status': statusHandler,
    '/logs': logsHandler,
    '/schema': schemaHandler,
    '/list': listHandler
};

// Main handler
async function handler(req: Request): Promise<Response> {
    hostLog(LOG_PREFIX_BASE, `${req.method} ${req.url}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return createCorsPreflightResponse();
    }

    try {
        const url = new URL(req.url);
        const pathname = url.pathname;

        // Extract the last part of the path for routing
        const pathParts = pathname.split('/');
        const routePath = '/' + pathParts[pathParts.length - 1];

        // Route to appropriate handler
        const routeHandler = routes[routePath] || tasksHandler;
        return await routeHandler(req);
    } catch (error) {
        hostLog(LOG_PREFIX_BASE, `Unhandled error: ${error}`);
        return createErrorResponse(
            `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
            [],
            500
        );
    }
}

// Task execution handler
async function executeHandler(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
        return createErrorResponse('Method not allowed', [], 405);
    }

    try {
        const body = await req.json();
        const { task_identifier, input, options = {} } = body;

        if (!task_identifier) {
            return createErrorResponse('Missing task_identifier', [], 400);
        }

        const { success, result, error, logs } = await tasksService.execute(
            task_identifier,
            input,
            { ...options, include_logs: true }
        );

        if (success) {
            return createResponse({ result, task_identifier }, logs);
        } else {
            return createErrorResponse(error || 'Task execution failed', logs, 500);
        }
    } catch (error) {
        return createErrorResponse(
            `Request parsing error: ${error instanceof Error ? error.message : String(error)}`,
            [],
            400
        );
    }
}

// Main tasks handler (legacy)
async function tasksHandler(req: Request): Promise<Response> {
    return createErrorResponse('Use /execute endpoint for task execution', [], 404);
}

// Status handler
async function statusHandler(req: Request): Promise<Response> {
    try {
        // Use service registry to query database
        const result = await serviceRegistry.call('database', 'select', [
            'task_runs',
            'id, status, created_at, updated_at'
        ]);

        if (!result.success) {
            return createErrorResponse(`Database error: ${result.error}`, [], 500);
        }

        // Order and limit the results
        const taskRuns = (result.data || [])
            .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, 10);

        return createResponse({ task_runs: taskRuns });
    } catch (error) {
        return createErrorResponse(
            `Error fetching status: ${error instanceof Error ? error.message : String(error)}`,
            [],
            500
        );
    }
}

// Logs handler
async function logsHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url);
        const taskId = url.searchParams.get('task_id');
        const limit = parseInt(url.searchParams.get('limit') || '50');

        if (!taskId) {
            return createErrorResponse('Missing task_id parameter', [], 400);
        }

        // This would need to be implemented based on your logging structure
        return createResponse({ logs: [], message: 'Logs handler not fully implemented' });
    } catch (error) {
        return createErrorResponse(
            `Error fetching logs: ${error instanceof Error ? error.message : String(error)}`,
            [],
            500
        );
    }
}

// Schema handler
async function schemaHandler(req: Request): Promise<Response> {
    try {
        const tasks = tasksService.list();
        const schema = generateSchema(tasks);
        return createResponse({ schema: formatSchema(schema) });
    } catch (error) {
        return createErrorResponse(
            `Error generating schema: ${error instanceof Error ? error.message : String(error)}`,
            [],
            500
        );
    }
}

// List handler
async function listHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url);
        const type = url.searchParams.get('type') as 'basic' | 'special' | 'database' | undefined;

        const { success, tasks, error } = await tasksService.list({ type });

        if (success) {
            return createResponse({ tasks });
        } else {
            return createErrorResponse(error || 'Failed to list tasks', [], 500);
        }
    } catch (error) {
        return createErrorResponse(
            `Error listing tasks: ${error instanceof Error ? error.message : String(error)}`,
            [],
            500
        );
    }
}

// Start the server
serve(handler);