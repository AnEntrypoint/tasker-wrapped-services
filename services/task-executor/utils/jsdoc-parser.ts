import { ParsedInfo } from '../types/index.ts';

/**
 * Parse JSDoc comments from task code
 */
export function parseJSDocComments(code: string, name: string): ParsedInfo {
  const description = code.match(/\/\*\*\s*([\s\S]*?)\s*\*\//)?.[1]
    ?.split('\n')
    .map(line => line.trim().replace(/^\* ?/, ''))
    .filter(line => line && !line.startsWith('@'))
    .join(' ')
    .trim() || '';
  
  // Parse @param tags - handle complex nested parameters
  const paramRegex = /@param\s+\{([^}]+)\}\s+([^\s-]+)\s*-\s*([^\n]+)/g;
  const params = [];
  let match;
  
  while ((match = paramRegex.exec(code)) !== null) {
    const type = match[1];
    const paramName = match[2].trim();
    const description = match[3].trim();
    
    // Determine if parameter is optional from the type or name
    const isOptional = type.includes('[') || paramName.includes('[');
    
    // Clean the parameter name by removing brackets
    const cleanParamName = paramName.replace(/[[\]]/g, '');
    
    // Parse the parameter path - handle array indices like messages.0.role
    // Also handle input prefix properly
    const parts = cleanParamName.split('.').map(part => {
      // Check if the part is a numeric index and preserve it
      return !isNaN(Number(part)) ? parseInt(part, 10) : part;
    });
    
    params.push({
      name: cleanParamName,
      type: type.replace(/[[\]]/g, ''), // Clean up type
      description,
      optional: isOptional,
      parts: parts,
      isArrayIndex: parts.some(p => typeof p === 'number')
    });
  }
  
  // Parse @returns tags - handle multiple return specifications
  const returnsRegex = /@returns\s+\{([^}]+)\}\s+(?:([^\s.-]+(?:\.[^\s.-]+)*)\s*-?\s*)?([^\n]+)/g;
  const returns = [];
  
  while ((match = returnsRegex.exec(code)) !== null) {
    const type = match[1];
    const propPath = match[2] ? match[2].trim() : '';
    const description = match[3].trim();
    
    // Handle optional brackets in property paths for returns
    const isOptional = type.includes('[') || propPath.includes('[');
    const cleanPropPath = propPath.replace(/[[\]]/g, '');
    
    // If it's a property path like returns.success, parse it
    if (cleanPropPath) {
      const parts = cleanPropPath.split('.').map(part => {
        return !isNaN(Number(part)) ? parseInt(part, 10) : part;
      });
      
      returns.push({
        type: type.replace(/[[\]]/g, ''),
        propPath: cleanPropPath,
        parts,
        description,
        optional: isOptional,
        isProperty: true
      });
    } else {
      // Main return type
      returns.push({
        type: type.replace(/[[\]]/g, ''),
        description,
        optional: isOptional,
        isProperty: false
      });
    }
  }
  
  // Also check for @throws tags
  const throwsRegex = /@throws\s+\{([^}]+)\}\s+([^\n]+)/g;
  const throws = [];
  
  while ((match = throwsRegex.exec(code)) !== null) {
    throws.push({
      type: match[1],
      description: match[2].trim()
    });
  }
  
  // Try to extract function name from code
  const taskName = code.match(/(?:async\s+)?function\s+(\w+)/)?.[1] 
                || code.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/)?.[1]
                || code.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/)?.[1]
                || name;
                
  return {
    name: taskName,
    description,
    params,
    returns,
    throws
  };
} 