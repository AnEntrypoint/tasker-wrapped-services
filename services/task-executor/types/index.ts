/**
 * Core type definitions for the Tasks edge function
 */


/**
 * Task information from database
 */
export interface TaskInfo {
  id: string;
  name: string;
  code?: string;
  taskCode?: string;
  [key: string]: any;
}

/**
 * Task execution result
 */
export interface TaskResult {
  success: boolean;
  data?: any;
  error?: string;
  logs: string[];
  timestamp: number;
}

/**
 * Schema property definition
 */
export interface SchemaProperty {
  type: string;
  description?: string;
  format?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  enum?: any[];
}

/**
 * Parsed JSDoc information
 */
export interface ParsedInfo {
  name: string;
  description: string;
  params: any[];
  returns: any[];
  throws?: any[];
}

/**
 * Generated schema
 */
export interface GeneratedSchema {
  name: string;
  description: string;
  parameters: SchemaProperty;
  returns: SchemaProperty;
  errors?: Array<{ type: string; description: string }>;
}

/**
 * OpenAPI schema
 */
export interface OpenAPISchema {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  paths: Record<string, any>;
}

/**
 * OpenAI schema
 */
export interface OpenAISchema {
  name: string;
  description: string;
  parameters: SchemaProperty;
  returns: SchemaProperty;
}

export type FormattedSchema = GeneratedSchema | OpenAPISchema | OpenAISchema;

/**
 * Module code packages
 */
export interface ModuleCode {
  tools: string;
  tasks: string;
} 