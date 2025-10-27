export function createResponse(data: any, logs: string[] = [], status = 200): Response {
    const response: any = { success: true, data };

    if (logs.length > 0) {
        response.logs = logs;
    }

    return new Response(JSON.stringify(response), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS
        }
    });
}

export function createErrorResponse(errorMessage: string, logs: string[] = [], status = 500): Response {
    const response: any = { success: false, error: errorMessage };

    if (logs.length > 0) {
        response.logs = logs;
    }

    return new Response(JSON.stringify(response), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS
        }
    });
}

export function createCorsPreflightResponse(): Response {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE'
};

export const LOG_PREFIX_BASE = "[TasksHandlerEF]"; // Tasks Handler Edge Function