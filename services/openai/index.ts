import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { corsHeaders } from '../_shared/cors.ts';
import { BaseHttpHandler, HttpStatus, createHealthCheckResponse } from "../_shared/http-handler.ts";
import { config } from "../_shared/config-service.ts";
import { serviceRegistry } from "../_shared/service-registry.ts";

let cachedApiKey: string | null = null;

async function getOpenAIApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  try {
    console.log("[WrappedOpenAI] Attempting to fetch OpenAI API key from keystore...");
    const result = await serviceRegistry.call('keystore', 'getKey', ['global', 'OPENAI_API_KEY']);

    if (!result.success) {
      console.error("[WrappedOpenAI] Failed to retrieve OPENAI_API_KEY from keystore:", result.error);
      throw new Error('OpenAI API key not found in keystore.');
    }

    cachedApiKey = result.data;
    console.log(`[WrappedOpenAI] Retrieved API key (starts with: ${cachedApiKey.substring(0, 5)}...).`);
    return cachedApiKey;
  } catch (error) {
    console.error("[WrappedOpenAI] Error getting OpenAI API key:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get OpenAI API key: ${errorMessage}`);
  }
}

// OpenAI HTTP Handler
class WrappedOpenAIHandler extends BaseHttpHandler {
  protected async routeHandler(req: Request, url: URL): Promise<Response> {
    // Health check endpoint
    if (req.method === "GET" && url.pathname === "/health") {
      return createHealthCheckResponse("wrappedopenai", "healthy", {
        timestamp: new Date().toISOString()
      });
    }

    console.log(`[WrappedOpenAI] Request received { url: "${req.url}", method: "${req.method}" }`);

    const body = await this.parseRequestBody(req);
    console.log("[WrappedOpenAI] Parsed request body:", { action: body.action, chain: body.chain });

    // Handle action format
    if (body.action) {
      return await this.handleAction(body.action, body.args || []);
    }

    // Handle chain format - simplified for common OpenAI operations
    if (body.chain && Array.isArray(body.chain)) {
      return await this.handleChain(body.chain);
    }

    throw new Error('Invalid request format: missing action or chain');
  }

  private async handleAction(action: string, args: any[]): Promise<Response> {
    switch (action) {
      case 'chat.completions.create':
        return await this.makeOpenAIRequest('https://api.openai.com/v1/chat/completions', 'POST', args[0] || {});
      case 'embeddings.create':
        return await this.makeOpenAIRequest('https://api.openai.com/v1/embeddings', 'POST', args[0] || {});
      case 'models.list':
        return await this.makeOpenAIRequest('https://api.openai.com/v1/models', 'GET');
      case 'models.retrieve':
        return await this.makeOpenAIRequest(`https://api.openai.com/v1/models/${args[0]}`, 'GET');
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  private async handleChain(chain: any[]): Promise<Response> {
    // Convert chain to action-based calls
    // Example: ['chat', 'completions', 'create'] -> action: 'chat.completions.create'
    const pathParts: string[] = [];

    for (const link of chain) {
      if (link.type === 'get' || link.type === 'call') {
        pathParts.push(link.property);
      }
    }

    // Convert to action format
    const action = pathParts.join('.');
    const args = chain[chain.length - 1]?.args || [];

    return await this.handleAction(action, args);
  }

  private async makeOpenAIRequest(url: string, method: string, data?: any): Promise<Response> {
    try {
      const apiKey = await getOpenAIApiKey();

      const requestOptions: RequestInit = {
        method,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      };

      if (data && method !== 'GET') {
        requestOptions.body = JSON.stringify(data);
      }

      console.log(`[WrappedOpenAI] Making ${method} request to ${url}`);
      if (data) {
        console.log(`[WrappedOpenAI] Request data:`, JSON.stringify(data, null, 2));
      }

      const response = await fetch(url, requestOptions);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WrappedOpenAI] API error (${response.status}):`, errorText);
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const responseData = await response.json();
      console.log(`[WrappedOpenAI] API response successful`);

      return this.createSuccessResponse(responseData);
    } catch (error) {
      console.error(`[WrappedOpenAI] Request failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(`OpenAI request failed: ${errorMessage}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

// Create handler instance and start serving
const wrappedOpenAIHandler = new WrappedOpenAIHandler();
serve((req) => wrappedOpenAIHandler.handle(req));

console.log("[WrappedOpenAI] Function initialized and server started.");