/**
 * Unified Task Registry for managing and executing tasks
 */

interface TaskMetadata {
  name?: string;
  description?: string;
  isAutoDiscovered?: boolean;
  [key: string]: any;
}

export class TaskRegistry {
  private tasks: Map<string, string> = new Map();
  private handlers: Map<string, (input: any, logs: string[]) => Promise<any>> = new Map();
  private metadata: Map<string, TaskMetadata> = new Map();

  constructor() {
    console.log(`[INFO] Initializing unified TaskRegistry`);
  }

  /**
   * Register a task by ID with its code and handler
   */
  registerTask(id: string, handler: (input: any, logs: string[]) => Promise<any>, code?: string, metadata?: TaskMetadata): void {
    this.handlers.set(id, handler);
    
    if (code) {
      this.tasks.set(id, code);
    }
    
    if (metadata) {
      this.metadata.set(id, metadata);
    }
  }

  /**
   * Get the number of registered handlers
   */
  getHandlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Check if a task exists
   */
  hasTask(id: string): boolean {
    return this.handlers.has(id);
  }

  /**
   * Get task code by ID
   */
  getTaskCode(id: string): string | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get task metadata by ID
   */
  getTaskMetadata(id: string): TaskMetadata | undefined {
    return this.metadata.get(id);
  }

  /**
   * Get task handler by ID - alias for getting the handler function
   */
  get(id: string): ((input: any, logs: string[]) => Promise<any>) | undefined {
    return this.handlers.get(id);
  }

  /**
   * Get all tasks metadata
   */
  getAllTasksMetadata(): Array<{id: string} & TaskMetadata> {
    const result: Array<{id: string} & TaskMetadata> = [];
    
    for (const [id, metadata] of this.metadata.entries()) {
      result.push({
        id,
        ...metadata
      });
    }
    
    return result;
  }

  /**
   * Discover task handlers from the database or other sources
   * This method is implemented to match the previous registry interface
   */
  async discoverTaskHandlers(): Promise<void> {
    console.log('[DEBUG] Discovering task handlers from database');
    // Implementation could be extended to actually load tasks from database
    return Promise.resolve();
  }

  /**
   * Check if a task exists by name
   * This is an alias for hasTask to match the previous interface
   */
  hasRegisteredTaskName(name: string): boolean {
    return this.hasTask(name);
  }

  /**
   * Execute a task by ID
   */
  async executeTask(id: string, input: any, logs: string[]): Promise<any> {
    if (!this.hasTask(id)) {
      throw new Error(`Task ${id} not found`);
    }

    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Task handler for ${id} not found`);
    }

    logs.push(`[INFO] Executing task ${id}`);
    return await handler(input, logs);
  }

  /**
   * Get all task handlers
   */
  getTaskHandlers(): Map<string, (input: any, logs: string[]) => Promise<any>> {
    return new Map(this.handlers);
  }
}

// Create singleton instance
export const taskRegistry = new TaskRegistry();
