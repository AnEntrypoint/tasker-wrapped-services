/**
 * Web Search Service
 * 
 * Provides a basic web search functionality using DuckDuckGo
 */

// Define the search result interface
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Define the search response interface
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  timestamp: string;
}

/**
 * DuckDuckGo search implementation
 * Uses the HTML API which doesn't require an API key
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract search results using regex (simple parsing)
    const results: SearchResult[] = [];
    
    // Extract results using regex patterns
    const resultPattern = /<div class="result[^>]*>[\s\S]*?<a class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    
    let match;
    while ((match = resultPattern.exec(html)) !== null && results.length < limit) {
      const url = decodeURIComponent(match[1].replace('/l/?kh=-1&amp;uddg=', ''));
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const snippet = match[3].replace(/<[^>]*>/g, '').trim();
      
      results.push({
        title,
        url,
        snippet
      });
    }
    
    return results;
  } catch (error) {
    console.error(`DuckDuckGo search error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Web search service
 */
const websearch = {
  /**
   * Search the web using DuckDuckGo
   * 
   * @param params Search parameters (query, limit)
   * @returns Array of search results
   */
  async search(params: { query: string; limit?: number }): Promise<SearchResponse> {
    console.log(`WebSearch: Searching for "${params.query}" with limit ${params.limit || 5}`);
    
    const query = params.query || "";
    const limit = params.limit || 5;
    
    if (!query) {
      throw new Error("Search query is required");
    }
    
    try {
      // Perform the actual search
      const results = await searchDuckDuckGo(query, limit);
      
      // Create the response
      const response: SearchResponse = {
        query,
        results,
        timestamp: new Date().toISOString()
      };
      
      console.log(`WebSearch: Found ${results.length} results`);
      return response;
    } catch (error) {
      console.error("WebSearch error:", error);
      throw error;
    }
  },
  
  getServerTime: () => {
    console.info('[INFO] [getServerTime] Getting server time');
    return { timestamp: new Date().toISOString(), source: "websearch" };
  }
};

export default websearch; 