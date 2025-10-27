import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { BaseHttpHandler, HttpStatus, createHealthCheckResponse } from "../_shared/http-handler.ts"
import { config } from "../_shared/config-service.ts"
import { serviceRegistry } from "../_shared/service-registry.ts"

// In-memory token cache by scope - persists between requests
const tokenCache = new Map<string, {
  token: string;
  expiry: number;
}>();

// Cached credentials and admin email
let cachedCreds: any = null;
let cachedAdminEmail: string | null = null;

// Keystore service is accessed through service registry

// Cache control values
const TOKEN_REFRESH_BUFFER = 300000; // Refresh token 5 minutes before expiry

/**
 * Get credentials from keystore with caching
 */
async function getCredentials(): Promise<any> {
  if (cachedCreds) return cachedCreds;

  try {
    const result = await serviceRegistry.call('keystore', 'getKey', ['default', 'GAPI_KEY']);

    if (!result.success) {
      throw new Error(`Failed to get credentials: ${result.error}`);
    }

    console.log(`Got credentials response from keystore`);
    console.log(`Credentials result structure: ${JSON.stringify({
      hasData: !!result.data,
      dataType: typeof result.data,
      hasDataData: !!result.data?.data,
      dataDataType: typeof result.data?.data,
      hasDataDataData: !!result.data?.data?.data,
      dataDataDataType: typeof result.data?.data?.data,
      dataDataDataPreview: typeof result.data?.data?.data === 'string' ? result.data.data.data.substring(0, 50) : result.data?.data?.data
    })}`);

    // Service registry triple wraps: { success, data: { success, data: { success, data: "json" } } }
    const credentialsJson = result.data?.data?.data;

    if (!credentialsJson || typeof credentialsJson !== 'string') {
      console.error(`Invalid credentials format. Type: ${typeof credentialsJson}, Value: ${credentialsJson}`);
      throw new Error('No credentials returned from keystore');
    }

    cachedCreds = JSON.parse(credentialsJson);

    console.log(`Loaded credentials for ${cachedCreds.client_email}`);
    return cachedCreds;
  } catch (error) {
    console.error(`Credential parsing error: ${(error as Error).message}`);
    throw new Error(`Failed to parse credentials: ${(error as Error).message}`);
  }
}


/**
 * Get admin email with caching
 */
async function getAdminEmail(): Promise<string> {
  if (cachedAdminEmail) return cachedAdminEmail;

  try {
    const result = await serviceRegistry.call('keystore', 'getKey', ['default', 'GAPI_ADMIN_EMAIL']);

    if (!result.success) {
      throw new Error(`Failed to get admin email: ${result.error}`);
    }

    console.log(`Got admin email response from keystore`);

    // Service registry triple wraps: { success, data: { success, data: { success, data: "email" } } }
    const emailValue = result.data?.data?.data;

    if (!emailValue || typeof emailValue !== 'string' || emailValue.trim() === '') {
      throw new Error(`Empty or invalid admin email received`);
    }

    cachedAdminEmail = emailValue;
    console.log(`Loaded admin email: ${cachedAdminEmail}`);
    return cachedAdminEmail;
  } catch (error) {
    console.error(`Admin email parsing error: ${(error as Error).message}`);
    throw new Error(`Failed to parse admin email: ${(error as Error).message}`);
  }
}

/**
 * Get access token with caching - supports impersonation
 * Note: This function now makes HTTP-based OAuth calls instead of using JWT library
 */
async function getAccessToken(scopes: string[], impersonateUser?: string): Promise<string> {

  // Sort scopes to ensure consistent cache key, include impersonation user
  const scopeKey = [...scopes].sort().join(',') + (impersonateUser ? `|${impersonateUser}` : '');

  // Check cache first
  const now = Date.now();
  const cachedData = tokenCache.get(scopeKey);

  if (cachedData && cachedData.expiry > now + TOKEN_REFRESH_BUFFER) {
    console.log(`Using cached token for ${scopeKey}`);
    return cachedData.token;
  }

  console.log(`Generating new token for ${scopeKey}`);
  const creds = await getCredentials();
  const adminEmail = await getAdminEmail();

  // Use impersonation user if specified, otherwise use admin email
  const subjectEmail = impersonateUser || adminEmail;
  console.log(`Impersonating user: ${subjectEmail}`);

  try {
    // Create JWT assertion for OAuth 2.0 flow
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: creds.client_email,
      scope: scopes.join(' '),
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
      sub: subjectEmail
    };

    // Encode JWT components
    const encodeBase64 = (str: string) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const jwtHeader = encodeBase64(JSON.stringify(header));
    const jwtPayload = encodeBase64(JSON.stringify(payload));

    // Create signature using Web Crypto API
    const jwtData = `${jwtHeader}.${jwtPayload}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(jwtData);

    // Import private key
    const privateKeyPem = creds.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
    const privateKeyDer = Uint8Array.from(atob(privateKeyPem), c => c.charCodeAt(0));

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyDer.buffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

    // Sign the data
    const signatureArrayBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const jwt = `${jwtData}.${signature}`;

    // Exchange JWT for access token
    console.log('Exchanging JWT for access token...');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to get access token: ${tokenResponse.status} - ${errorText}`);
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new Error('No access token received');
    }

    // Cache the token
    const expiresAt = Date.now() + (tokenData.expires_in * 1000);
    tokenCache.set(scopeKey, {
      token: tokenData.access_token,
      expiry: expiresAt
    });

    const expiryDate = new Date(expiresAt).toISOString();
    console.log(`Generated new token, expires at ${expiryDate}`);
    return tokenData.access_token;

  } catch (error) {
    console.error(`Token generation failed:`, error);
    throw new Error(`Failed to generate access token: ${(error as Error).message}`);
  }
}

// Google API HTTP Handler
class WrappedGapiHandler extends BaseHttpHandler {
  protected async routeHandler(req: Request, url: URL): Promise<Response> {
    // Fast health check
    if (url.pathname.endsWith('/health')) {
      return createHealthCheckResponse("wrappedgapi", "healthy", {
        cache_size: tokenCache.size,
        timestamp: new Date().toISOString()
      });
    }
  
    try {
      // Get request body - read as text first to avoid consuming it
      console.log('🔍 [TRACE] About to read request body...');
      const bodyText = await req.text().catch(() => '{"method":"unknown"}');
      console.log('🔍 [TRACE] Request body read successfully, length:', bodyText.length);
      const body = JSON.parse(bodyText);
      console.log('🔍 [TRACE] Request body parsed, method:', body?.method);
    
    // Echo for testing
    if (body?.method === 'echo') {
      return new Response(
        JSON.stringify({ echo: body.args[0] || {} }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Test method for debugging resume payload
    if (body?.chain?.[0]?.property === 'test' && 
        body.chain[1]?.property === 'getStepData') {
      
      const args = body.chain[1]?.args?.[0] || {};
      console.log(`Test getStepData called with:`, args);
      
      return new Response(
        JSON.stringify({
          stepNumber: args.stepNumber,
          timestamp: args.timestamp,
          testData: `Step ${args.stepNumber} data`,
          responseAt: new Date().toISOString()
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Handle credentials check
    if (body?.method === 'checkCredentials') {
      try {
        const adminEmail = await getAdminEmail();
        const creds = await getCredentials();
        
        return new Response(
          JSON.stringify({
            status: 'ok',
            adminEmail: adminEmail,
            clientEmail: creds.client_email,
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: 'error',
            error: (error as Error).message,
            timestamp: new Date().toISOString()
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Handle token info - returns info about cached tokens
    if (body?.method === 'getTokenInfo') {
      const tokenInfo = Array.from(tokenCache.entries()).map(([scope, data]) => ({
        scope,
        expires: new Date(data.expiry).toISOString(),
        valid: data.expiry > Date.now()
      }));
      
      return new Response(
        JSON.stringify({
          tokens: tokenInfo,
          count: tokenInfo.length,
          timestamp: new Date().toISOString()
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    
    // Handle clear token cache
    if (body?.method === 'clearTokenCache') {
      const scope = body.args?.[0];
      
      if (scope) {
        tokenCache.delete(scope);
        return new Response(
          JSON.stringify({
            status: 'ok',
            message: `Cleared token cache for scope: ${scope}`,
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } else {
        tokenCache.clear();
        return new Response(
          JSON.stringify({ 
            status: 'ok',
            message: 'Cleared all token caches',
            timestamp: new Date().toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Admin domains direct implementation with token caching
    if (body?.chain?.[0]?.property === 'admin' && 
        body.chain[1]?.property === 'domains' && 
        body.chain[2]?.property === 'list') {
      
      try {
        // Get admin email - cached after first call
        const adminEmail = await getAdminEmail();
        
        // Get token - will use cache if available
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/admin.directory.domain.readonly'
        ]);
        
        // Get customer ID from request or use 'my_customer' as default
        // IMPORTANT: For Google Admin API, use 'my_customer' to refer to the customer
        // that the authenticated admin belongs to. Do not use admin email as customer ID.
        // Only use specific customer ID values for multi-tenant situations.
        const customerArgs = body.chain[2]?.args?.[0] || {};
        let customerId: string;
        
        if (customerArgs.customer) {
          if (customerArgs.customer === adminEmail) {
            // If someone passed the admin email as customer, convert it to my_customer
            customerId = 'my_customer';
            console.log(`Converting admin email to my_customer`);
          } else {
            customerId = encodeURIComponent(customerArgs.customer);
          }
        } else {
          customerId = 'my_customer';
        }
        
        console.log(`Using customer ID: ${customerId}`);
        

        
        // Make direct API call using cached token
        const domainsUrl = `https://admin.googleapis.com/admin/directory/v1/customer/${customerId}/domains`;
        const response = await fetch(domainsUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        // Read response body once to avoid "Body already consumed" error
        console.log('🔍 [TRACE] Reading Google API response body...');
        const responseBody = await response.text();
        console.log('🔍 [TRACE] Response body read, status:', response.status);
        
        if (response.ok) {
          // Parse as JSON for successful responses
          const data = JSON.parse(responseBody);
          console.log('🔍 [TRACE] Response parsed successfully');
          
          // Clean response - return only the domains data without Google API metadata
          const cleanedResponse = {
            domains: data.domains || []
          };
          
          console.log(`🔍 [TRACE] Returning cleaned domains response with ${cleanedResponse.domains.length} domains`);
          return new Response(
            JSON.stringify(cleanedResponse),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          console.log('🔍 [TRACE] API error response:', responseBody);
          throw new Error(`Google API returned ${response.status}: ${responseBody}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `Domain list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Admin users direct implementation with token caching
    if (body?.chain?.[0]?.property === 'admin' && 
        body.chain[1]?.property === 'users' && 
        body.chain[2]?.property === 'list') {
      
      try {
        // Get admin email - cached after first call
        const adminEmail = await getAdminEmail();
        
        // Get token with appropriate scopes for user management
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/admin.directory.user.readonly'
        ]);
        
        // Get parameters from the request
        const usersArgs = body.chain[2]?.args?.[0] || {};
        
        // Build query parameters
        const queryParams = new URLSearchParams();
        
        // Add domain parameter if specified
        if (usersArgs.domain) {
          queryParams.set('domain', usersArgs.domain);
          console.log(`Filtering users by domain: ${usersArgs.domain}`);
        }
        
        // Add maxResults parameter if specified (default to 100 if not specified)
        const maxResults = usersArgs.maxResults || 100;
        queryParams.set('maxResults', maxResults.toString());
        
        // Add customer parameter - use my_customer if not specified
        if (usersArgs.customer) {
          queryParams.set('customer', usersArgs.customer);
        } else {
          queryParams.set('customer', 'my_customer');
        }
        
        // Add orderBy parameter if specified
        if (usersArgs.orderBy) {
          queryParams.set('orderBy', usersArgs.orderBy);
        }
        
        // Add query parameter if specified
        if (usersArgs.query) {
          queryParams.set('query', usersArgs.query);
        }
        
        // Add showDeleted parameter if specified
        if (usersArgs.showDeleted) {
          queryParams.set('showDeleted', usersArgs.showDeleted.toString());
        }
        
        // Add viewType parameter if specified
        if (usersArgs.viewType) {
          queryParams.set('viewType', usersArgs.viewType);
        }
        
        console.log(`Listing users with params: ${queryParams.toString()}`);
        

        
        // Make direct API call using cached token
        const usersUrl = `https://admin.googleapis.com/admin/directory/v1/users?${queryParams.toString()}`;
        const response = await fetch(usersUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        // Read response body once to avoid "Body already consumed" error
        console.log('🔍 [TRACE] Reading Google API response body...');
        const responseBody = await response.text();
        console.log('🔍 [TRACE] Response body read, status:', response.status);
        
        if (response.ok) {
          // Parse as JSON for successful responses
          const data = JSON.parse(responseBody);
          console.log('🔍 [TRACE] Response parsed successfully');
          
          // Clean response - return only the users data without Google API metadata
          const cleanedResponse = {
            users: data.users || []
          };
          
          console.log(`🔍 [TRACE] Returning cleaned users response with ${cleanedResponse.users.length} users`);
          return new Response(
            JSON.stringify(cleanedResponse),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          console.log('🔍 [TRACE] API error response:', responseBody);
          throw new Error(`Google API returned ${response.status}: ${responseBody}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `User list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Gmail messages direct implementation with token caching
    if (body?.chain?.[0]?.property === 'gmail' && 
        body.chain[1]?.property === 'users' && 
        body.chain[2]?.property === 'messages' && 
        body.chain[3]?.property === 'list') {
      
      try {
        // Get parameters from the request
        const listArgs = body.chain[3]?.args?.[0] || {};
        const userId = listArgs.userId || 'me';
        
        // Get token with appropriate scopes for Gmail - IMPERSONATE the specific user
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://mail.google.com/'
        ], userId);
        
        // Build query parameters
        const queryParams = new URLSearchParams();
        
        if (listArgs.q) {
          queryParams.set('q', listArgs.q);
        }
        if (listArgs.maxResults) {
          queryParams.set('maxResults', listArgs.maxResults.toString());
        }
        if (listArgs.pageToken) {
          queryParams.set('pageToken', listArgs.pageToken);
        }
        if (listArgs.labelIds) {
          queryParams.set('labelIds', listArgs.labelIds.join(','));
        }
        
        console.log(`Listing Gmail messages for user ${userId} with params: ${queryParams.toString()}`);
        

        
        // Make direct API call using cached token
        const messagesUrl = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages?${queryParams.toString()}`;
        const response = await fetch(messagesUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        const responseBody = await response.text();
        console.log('Gmail API response status:', response.status);
        
        if (response.ok) {
          const data = JSON.parse(responseBody);
          console.log('Gmail messages list success');
          return new Response(
            JSON.stringify(data),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          console.log('Gmail API error response:', responseBody);
          throw new Error(`Gmail API returned ${response.status}: ${responseBody}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `Gmail messages list error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // Gmail message get direct implementation with token caching
    if (body?.chain?.[0]?.property === 'gmail' && 
        body.chain[1]?.property === 'users' && 
        body.chain[2]?.property === 'messages' && 
        body.chain[3]?.property === 'get') {
      
      try {
        // Get parameters from the request
        const getArgs = body.chain[3]?.args?.[0] || {};
        const userId = getArgs.userId || 'me';
        
        // Get token with appropriate scopes for Gmail - IMPERSONATE the specific user
        const token = await getAccessToken([
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://mail.google.com/'
        ], userId);
        const messageId = getArgs.id;
        
        if (!messageId) {
          throw new Error('Message ID is required');
        }
        
        // Build query parameters
        const queryParams = new URLSearchParams();
        
        if (getArgs.format) {
          queryParams.set('format', getArgs.format);
        }
        if (getArgs.metadataHeaders) {
          queryParams.set('metadataHeaders', getArgs.metadataHeaders.join(','));
        }
        
        console.log(`Getting Gmail message ${messageId} for user ${userId} with params: ${queryParams.toString()}`);
        

        
        // Make direct API call using cached token
        const messageUrl = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?${queryParams.toString()}`;
        const response = await fetch(messageUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });
        
        const responseBody = await response.text();
        console.log('Gmail API response status:', response.status);
        
        if (response.ok) {
          const data = JSON.parse(responseBody);
          console.log('Gmail message get success');
          return new Response(
            JSON.stringify(data),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } else {
          console.log('Gmail API error response:', responseBody);
          throw new Error(`Gmail API returned ${response.status}: ${responseBody}`);
        }
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `Gmail message get error: ${(error as Error).message}`,
            timestamp: new Date().toISOString() 
          }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    
    // For all other Google API requests, handle manually
    // Since we removed the SDK processor, we only support the direct implementations above
    console.log('🔍 [TRACE] No direct implementation found for request, returning error...');

    return new Response(
      JSON.stringify({
        error: `Unsupported Google API request. The wrappedgapi service now only supports specific direct implementations: admin.domains.list, admin.users.list, gmail.users.messages.list, gmail.users.messages.get`,
        received_method: body?.method,
        received_chain: body?.chain?.map((item: any) => item.property),
        supported_methods: [
          'admin.domains.list',
          'admin.users.list',
          'gmail.users.messages.list',
          'gmail.users.messages.get',
          'echo',
          'checkCredentials',
          'getTokenInfo',
          'clearTokenCache'
        ],
        timestamp: new Date().toISOString()
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
    } catch (error) {
      return this.handleError(error, 'Error in wrappedgapi');
    }
  }
}

// Create handler instance and start serving
const wrappedGapiHandler = new WrappedGapiHandler();
serve((req) => wrappedGapiHandler.handle(req));
