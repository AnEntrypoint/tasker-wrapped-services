import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import websearch from "./websearch-service.ts";
import { BaseHttpHandler, HttpStatus, createHealthCheckResponse } from "../_shared/http-handler.ts";
import { config } from "../_shared/config-service.ts";

// Define type for websearch service methods
type WebSearchService = typeof websearch;

// WebSearch HTTP Handler
class WrappedWebSearchHandler extends BaseHttpHandler {
  protected async routeHandler(req: Request, url: URL): Promise<Response> {
    // Health check endpoint
    if (req.method === "GET" && url.pathname === "/health") {
      return createHealthCheckResponse("wrappedwebsearch", "healthy", {
        timestamp: new Date().toISOString()
      });
    }

    if (req.method === "POST") {
      const body = await this.parseRequestBody(req);

      try {
        let result;

        // Handle both old-style and new-style requests
        if (body.chain) {
          // Handle chain-style request manually
          let current: any = websearch;
          for (const step of body.chain) {
            if (typeof current[step.property] === 'function') {
              current = await current[step.property](...(step.args || []));
            } else {
              throw new Error(`Method '${step.property}' not found or not callable`);
            }
          }
          result = current;
        } else if (body.method) {
          // Handle direct method call (from QuickJS)
          const method = body.method as keyof WebSearchService;
          const args = body.args || [];

          if (typeof websearch[method] === 'function') {
            // Cast to any to avoid TypeScript errors with dynamic method calls
            result = await (websearch[method] as Function)(...args);
          } else {
            throw new Error(`Method ${String(method)} not found on websearch service`);
          }
        } else {
          throw new Error("Request must include either 'chain' or 'method'");
        }

        return this.createSuccessResponse(result);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return this.createErrorResponse(
          err.message,
          (err as any).status || HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    }

    return this.createErrorResponse("Not found", HttpStatus.NOT_FOUND);
  }
}

// Create handler instance and start serving
const wrappedWebSearchHandler = new WrappedWebSearchHandler();
serve((req) => wrappedWebSearchHandler.handle(req));
