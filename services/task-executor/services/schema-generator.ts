import { ParsedInfo, GeneratedSchema, SchemaProperty, OpenAPISchema, OpenAISchema, FormattedSchema } from '../types/index.ts';

/**
 * Generate schema from parsed JSDoc
 */
export function generateSchema(parsedInfo: ParsedInfo): GeneratedSchema {
  // Helper function to get type from JSDoc type
  const getSchemaType = (type: string): SchemaProperty => {
    type = type.toLowerCase();
    
    if (type.includes('string')) return { type: 'string' };
    if (type.includes('number') || type.includes('float') || type.includes('integer')) return { type: 'number' };
    if (type.includes('boolean')) return { type: 'boolean' };
    if (type.includes('date')) return { type: 'string', format: 'date-time' };
    if (type.includes('object')) return { type: 'object', properties: {} };
    if (type.includes('array')) {
      // Try to extract the array item type from Array<Type>
      const itemTypeMatch = type.match(/array<([^>]+)>/i);
      if (itemTypeMatch) {
        return { 
          type: 'array', 
          items: getSchemaType(itemTypeMatch[1])
        };
      }
      return { type: 'array', items: { type: 'object' } };
    }
    
    // Default to string for unknown types
    return { type: 'string' };
  };
  
  // Create a hierarchical schema structure
  const schemaBuilder = () => {
    const schema: SchemaProperty = {
      type: 'object',
      properties: {},
      required: []
    };
    
    // Add a property to the schema at the given path
    const addProperty = (path: (string | number)[], property: SchemaProperty, isRequired?: boolean) => {
      if (path.length === 0) return;
      
      let current = schema;
      
      // Navigate through the path, creating objects as needed
      for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i];
        const nextSegment = path[i + 1];
        const isNextSegmentNumeric = typeof nextSegment === 'number';
        
        // Ensure the current segment exists
        if (typeof segment === 'string') {
          if (!current.properties) {
            current.properties = {};
          }
          
          if (!current.properties[segment]) {
            // Check if we need an array or object for the next segment
            if (isNextSegmentNumeric) {
              current.properties[segment] = {
                type: 'array',
                items: { type: 'object', properties: {} }
              };
            } else {
              current.properties[segment] = {
                type: 'object',
                properties: {}
              };
            }
          }
          
          // Move to the next level
          if (isNextSegmentNumeric && current.properties[segment].items) {
            current = current.properties[segment].items as SchemaProperty;
          } else {
            current = current.properties[segment];
          }
        } else if (typeof segment === 'number') {
          // For numeric indices, we're already in an array's items
          // Just ensure properties exists
          if (!current.properties) {
            current.properties = {};
          }
        }
      }
      
      // Add the final property
      const finalSegment = path[path.length - 1];
      
      if (typeof finalSegment === 'string') {
        if (!current.properties) {
          current.properties = {};
        }
        
        current.properties[finalSegment] = {
          type: property.type,
          description: property.description
        };
        
        if (property.format) {
          current.properties[finalSegment].format = property.format;
        }
        
        if (property.items) {
          current.properties[finalSegment].items = property.items;
        }
        
        // Add to required list if not optional
        if (isRequired) {
          if (!current.required) current.required = [];
          current.required.push(finalSegment);
        }
      }
    };
    
    return {
      schema,
      addProperty
    };
  };
  
  // Process parameters
  const inputSchemaResult = schemaBuilder();
  const { schema: parametersSchema, addProperty } = inputSchemaResult;
  
  // Organize parameters by their parent path to build a proper hierarchy
  interface ParamWithFinalSegment extends Record<string, any> {
    parts: (string | number)[];
    finalSegment: string | number;
    type: string;
    description: string;
    optional: boolean;
  }
  
  const paramsByPath: Record<string, ParamWithFinalSegment[]> = {};
  parsedInfo.params.forEach((param: any) => {
    if (!param.parts || param.parts.length === 0) return;
    
    // Skip function or module
    if (param.parts[0] === 'function' || param.parts[0] === 'module') return;
    
    // Create a key for grouping
    const parentPath = param.parts.slice(0, -1).join('.');
    const finalSegment = param.parts[param.parts.length - 1];
    
    if (!paramsByPath[parentPath]) {
      paramsByPath[parentPath] = [];
    }
    
    paramsByPath[parentPath].push({
      ...param,
      finalSegment
    });
  });
  
  // Process each parameter group
  Object.keys(paramsByPath).forEach(pathKey => {
    const params = paramsByPath[pathKey];
    
    params.forEach((param: ParamWithFinalSegment) => {
      // Create the property schema
      const propertySchema = getSchemaType(param.type);
      
      // Add description
      propertySchema.description = param.description;
      
      // Add the property to the schema
      const propWithMeta = { ...propertySchema };
      const isRequired = !param.optional;
      
      addProperty(param.parts, propWithMeta, isRequired);
    });
  });
  
  // Process return information
  let returnSchema: SchemaProperty = {
    type: 'object',
    properties: {}
  };
  
  // First find the main return type
  const mainReturn = parsedInfo.returns.find((ret: any) => !ret.isProperty);
  
  if (mainReturn) {
    returnSchema = getSchemaType(mainReturn.type);
    returnSchema.description = mainReturn.description;
  }
  
  // Process return properties
  const returnsByPath: Record<string, any[]> = {};
  parsedInfo.returns.filter((ret: any) => ret.isProperty).forEach((ret: any) => {
    if (!ret.parts || ret.parts.length === 0) return;
    
    // Create a key for grouping
    const parentPath = ret.parts.slice(0, -1).join('.');
    const finalSegment = ret.parts[ret.parts.length - 1];
    
    if (!returnsByPath[parentPath]) {
      returnsByPath[parentPath] = [];
    }
    
    returnsByPath[parentPath].push({
      ...ret,
      finalSegment
    });
  });
  
  // Create a builder for return schema similar to parameters
  const returnSchemaBuilder = schemaBuilder();
  
  // Process each return property group
  Object.keys(returnsByPath).forEach(pathKey => {
    const rets = returnsByPath[pathKey];
    
    rets.forEach((ret: any) => {
      // Create the property schema
      const propertySchema = getSchemaType(ret.type);
      
      // Add description
      propertySchema.description = ret.description;
      
      // Add the property to the schema
      const propWithMeta = { ...propertySchema };
      const isRequired = !ret.optional;
      
      returnSchemaBuilder.addProperty(ret.parts, propWithMeta, isRequired);
    });
  });
  
  // Use the built return schema if it has properties
  if (Object.keys(returnSchemaBuilder.schema.properties || {}).length > 0) {
    // Preserve the main return type description if available
    if (mainReturn && mainReturn.description) {
      returnSchemaBuilder.schema.description = mainReturn.description;
    }
    returnSchema = returnSchemaBuilder.schema;
  }
  
  // Final schema with all components
  const finalSchema: GeneratedSchema = {
    name: parsedInfo.name,
    description: parsedInfo.description,
    parameters: parametersSchema,
    returns: returnSchema
  };
  
  // Add errors information if available
  if (parsedInfo.throws && parsedInfo.throws.length > 0) {
    finalSchema.errors = parsedInfo.throws.map((t: any) => ({
      type: t.type,
      description: t.description
    }));
  }
  
  return finalSchema;
}

/**
 * Format schema according to requested format
 */
export function formatSchema(schema: GeneratedSchema, format: string): FormattedSchema {
  switch (format.toLowerCase()) {
    case 'openapi':
      return {
        openapi: '3.0.0',
        info: {
          title: schema.name,
          description: schema.description,
          version: '1.0.0'
        },
        paths: {
          '/execute': {
            post: {
              description: `Execute the ${schema.name} task`,
              requestBody: {
                content: {
                  'application/json': {
                    schema: schema.parameters
                  }
                }
              },
              responses: {
                '200': {
                  description: 'Successful response',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          success: {
                            type: 'boolean',
                            description: 'Whether the operation was successful'
                          },
                          data: schema.returns,
                          logs: {
                            type: 'array',
                            description: 'Execution logs',
                            items: {
                              type: 'string'
                            }
                          },
                          timestamp: {
                            type: 'number',
                            description: 'Execution timestamp'
                          }
                        }
                      }
                    }
                  }
                },
                '400': {
                  description: 'Bad request',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          success: {
                            type: 'boolean',
                            enum: [false]
                          },
                          error: {
                            type: 'string'
                          },
                          logs: {
                            type: 'array',
                            items: {
                              type: 'string'
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } as OpenAPISchema;
      
    case 'openai':
      // Format for OpenAI function calling
      return {
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        returns: schema.returns
      } as OpenAISchema;
      
    case 'json':
    default:
      return schema;
  }
} 