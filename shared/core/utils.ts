/**
 * Unified Utility Functions
 *
 * Consolidates common utility functions with standardized naming conventions
 * and consistent error handling patterns.
 */

import { hostLog as newHostLog, logger, log, perf, context } from './logging-service.ts';
import { database, fetchTaskFromDatabase as dbFetchTaskFromDatabase, createServiceRoleClient } from './database-service.ts';

// Shared type definitions
export interface ILogEntry {
	level: 'debug' | 'info' | 'warn' | 'error' | 'log';
	message: string;
	timestamp: string;
	data?: any;
}

export interface IApiResponse<T = any> {
	success: boolean;
	data?: T;
	error?: string;
	timestamp: string;
}

export interface IPaginationOptions {
	page?: number;
	limit?: number;
	offset?: number;
}

export interface ISortOptions {
	field?: string;
	direction?: 'asc' | 'desc';
}

// String utilities
export function simpleStringify(object: any): string {
	try {
		const seen = new WeakSet();
		return JSON.stringify(object, (key, value) => {
			if (typeof value === 'object' && value !== null) {
				if (seen.has(value)) {
					return '[Circular]';
				}
				seen.add(value);
			}
			return value;
		}, 2);
	} catch (error) {
		return `[Error stringifying object: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

export function sanitizeString(input: string, maxLength: number = 1000): string {
	if (typeof input !== 'string') {
		return String(input);
	}
	return input.length > maxLength ? input.substring(0, maxLength) + '...' : input;
}

export function generateCorrelationId(): string {
	return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Validation utilities
export function isValidUuid(uuid: string): boolean {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

export function validateRequired(obj: any, requiredFields: string[]): { isValid: boolean; missingFields: string[] } {
	const missingFields: string[] = [];

	for (const field of requiredFields) {
		if (!obj || obj[field] === undefined || obj[field] === null || obj[field] === '') {
			missingFields.push(field);
		}
	}

	return {
		isValid: missingFields.length === 0,
		missingFields
	};
}

// Re-export hostLog from logging service for backward compatibility
export const hostLog = newHostLog;

// Export logging utilities for convenience
export { logger, log, perf, context } from './logging-service.ts';

// Database utilities
export const fetchTaskFromDatabase = async (
	supabaseClient: any, // Keep for backward compatibility but not used
	taskIdOrName: string,
	taskId: string | null = null,
	logger: any = log
): Promise<string | null> => {
	try {
		const taskFunction = await dbFetchTaskFromDatabase(taskIdOrName, taskId);
		return taskFunction?.code || null;
	} catch (error) {
		logger.error(`Database fetch error: ${error instanceof Error ? error.message : String(error)}`, error);
		return null;
	}
};

// Response utilities
export function createApiResponse<T>(
	success: boolean,
	data?: T,
	error?: string,
	statusCode: number = 200
): { response: Response; data: IApiResponse<T> } {
	const apiData: IApiResponse<T> = {
		success,
		data,
		error,
		timestamp: new Date().toISOString()
	};

	const response = new Response(JSON.stringify(apiData), {
		status: statusCode,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization'
		}
	});

	return { response, data: apiData };
}

export function createSuccessApiResponse<T>(data: T, statusCode: number = 200) {
	return createApiResponse(true, data, undefined, statusCode);
}

export function createErrorApiResponse(error: string, statusCode: number = 500) {
	return createApiResponse(false, undefined, error, statusCode);
}

// Legacy response functions (deprecated - use createApiResponse instead)
export function createErrorResponse(
	message: string,
	statusCode: number = 500,
	details?: any
): Response {
	return new Response(
		JSON.stringify({
			error: message,
			details: details,
			timestamp: new Date().toISOString()
		}),
		{
			status: statusCode,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization'
			}
		}
	);
}

export function createSuccessResponse(
	data: any,
	statusCode: number = 200
): Response {
	return new Response(
		JSON.stringify({
			data,
			timestamp: new Date().toISOString()
		}),
		{
			status: statusCode,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization'
			}
		}
	);
}

// Deprecated alias for backward compatibility
export const isUuid = isValidUuid;

// Re-export service role client from database service for backward compatibility
export const getServiceRoleClient = createServiceRoleClient; 