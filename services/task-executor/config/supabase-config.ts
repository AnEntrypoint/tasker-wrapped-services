/**
 * Supabase Configuration Adapter
 *
 * This file provides backward compatibility while delegating to the unified database service.
 * All new code should use the unified database service directly.
 */

import { database, createServiceRoleClient, createAnonClient } from '../../_shared/database-service.ts';

// Get database configuration
const dbConfig = database.databaseConfig;

// Export configuration variables for backward compatibility
export const SUPABASE_URL = dbConfig.url;
export const SUPABASE_ANON_KEY = dbConfig.anonKey;
export const SERVICE_ROLE_KEY = dbConfig.serviceRoleKey;

// Export clients using the unified database service
export const supabaseClient = createServiceRoleClient();

// Export convenience functions
export const getServiceRoleClient = createServiceRoleClient;
export const getAnonClient = createAnonClient;