/**
 * Utilities for formatting responses
 */

/**
 * Safely stringify objects including handling of:
 * - Circular references
 * - Error objects
 * - BigInt values
 * - Set/Map objects
 * - Standard JSON serialization issues
 * 
 * @param obj Any object to stringify
 * @param space Number of spaces for indentation (default: 2)
 * @returns Safely stringified representation of the object
 */
function safeStringify(obj: unknown, space: number = 2): string {
  if (obj === undefined) {
    return 'undefined';
  }
  
  if (obj === null) {
    return 'null';
  }
  
  try {
    const seen = new Set();
    
    const replacer = (key: string, value: any): any => {
      // Handle Error objects
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
          ...(value as any) // Include any custom properties
        };
      }
      
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      
      // Handle BigInt
      if (typeof value === 'bigint') {
        return value.toString() + 'n';
      }
      
      // Handle Map
      if (value instanceof Map) {
        return {
          _type: 'Map',
          data: Array.from(value.entries())
        };
      }
      
      // Handle Set
      if (value instanceof Set) {
        return {
          _type: 'Set',
          data: Array.from(value.values())
        };
      }
      
      // Handle Date
      if (value instanceof Date) {
        return {
          _type: 'Date',
          iso: value.toISOString()
        };
      }
      
      // Handle functions (return their string representation)
      if (typeof value === 'function') {
        return `[Function: ${value.name || 'anonymous'}]`;
      }
      
      // Handle symbols
      if (typeof value === 'symbol') {
        return value.toString();
      }
      
      return value;
    };
    
    return JSON.stringify(obj, replacer, space);
  } catch (err) {
    return `[Error stringifying object: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * Standard response format interface 
 */
export interface StandardResponse {
  success: boolean;
  result?: any;
  error?: string;
  errorType?: string;
  stack?: string;
  logs: string[];
  timestamp: number;
}

/**
 * Helper function to create a JSON response
 */
export function jsonResponse(data: any, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
}

/**
 * Format a task result response
 */
export function formatTaskResult(
  success: boolean, 
  result?: any,
  error?: string, 
  logs: string[] = [], 
  errorType?: string, 
  stack?: string
): StandardResponse {
  return {
    success,
    ...(result !== undefined ? { result } : {}),
    ...(error ? { error } : {}),
    ...(errorType ? { errorType } : {}),
    ...(stack ? { stack } : {}),
    logs,
    timestamp: Date.now()
  };
}

/**
 * Format an error response for return to the client
 * @param error The error message
 * @returns Formatted error response
 */
export function formatErrorResponse(error: string, logs?: string[]): StandardResponse {
  return formatTaskResult(false, undefined, error, logs);
}

/**
 * Format a log message with ISO timestamp
 */
export function formatLogMessage(level: string, message: string, context?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  let formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (context && Object.keys(context).length > 0) {
    formattedMessage += ` ${safeStringify(context)}`;
  }
  
  return formattedMessage;
} 