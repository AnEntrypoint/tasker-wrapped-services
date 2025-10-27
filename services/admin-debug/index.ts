// supabase/functions/admin-debug/index.ts
// Admin debugging endpoint to test various edge functions directly

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.1";

// CORS headers for the response
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
  try {
    // Get query parameters 
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    
    // Get config
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
    
    // Configure for local development
    if (Deno.env.get("SUPABASE_EDGE_RUNTIME_IS_LOCAL") === "true") {
      supabaseUrl = "http://kong:8000";
    }
    
    if (!serviceRoleKey) {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    }
    
    // Create Supabase client with service key
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    
    // Handle action: Test direct GAPI call
    if (action === "test-direct-gapi") {
      console.log("Testing direct GAPI call");
      
      const response = await fetch(`${supabaseUrl}/functions/v1/wrappedgapi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({
          chain: [
            { type: "get", property: "admin" },
            { type: "get", property: "domains" },
            { type: "call", property: "list", args: [{ customer: "my_customer" }] }
          ]
        })
      });
      
      if (!response.ok) {
        throw new Error(`Direct GAPI call failed: ${response.status} ${await response.text()}`);
      }
      
      const result = await response.json();
      
      return new Response(JSON.stringify({
        success: true,
        message: "Direct GAPI call successful",
        resultType: typeof result,
        resultKeys: Object.keys(result),
        domainsCount: result.domains?.length,
        itemsCount: result.items?.length,
        fullResult: result
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    // Handle action: Test stack processor
    if (action === "test-stack-processor") {
      console.log("Testing stack processor with GAPI call");
      
      // Create a stack run for the GAPI call
      const { data: stackRun, error: createError } = await supabase
        .from("stack_runs")
        .insert({
          service_name: "gapi",
          method_name: "admin.domains.list",
          args: [{ customer: "my_customer" }],
          status: "pending",
          created_at: new Date().toISOString()
        })
        .select()
        .single();
        
      if (createError) {
        throw new Error(`Failed to create stack run: ${createError.message}`);
      }
      
      console.log(`Created stack run with ID: ${stackRun.id}`);
      
      // Trigger stack processor
      const procResponse = await fetch(`${supabaseUrl}/functions/v1/simple-stack-processor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({
          stackRunId: stackRun.id
        })
      });
      
      if (!procResponse.ok) {
        throw new Error(`Stack processor call failed: ${procResponse.status} ${await procResponse.text()}`);
      }
      
      // Wait for a bit
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check stack run status
      const { data: updatedRun, error: fetchError } = await supabase
        .from("stack_runs")
        .select("*")
        .eq("id", stackRun.id)
        .single();
        
      if (fetchError) {
        throw new Error(`Failed to fetch updated stack run: ${fetchError.message}`);
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: "Stack processor test completed",
        stackRunId: stackRun.id,
        stackRunStatus: updatedRun.status,
        resultType: typeof updatedRun.result,
        resultKeys: updatedRun.result ? Object.keys(updatedRun.result) : [],
        domainsCount: updatedRun.result?.domains?.length,
        itemsCount: updatedRun.result?.items?.length,
        fullResult: updatedRun.result
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    // Default response for unknown actions
    return new Response(JSON.stringify({
      success: false,
      message: "Unknown action",
      availableActions: ["test-direct-gapi", "test-stack-processor"]
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    
    return new Response(JSON.stringify({
      success: false,
      error: errorMessage
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}); 