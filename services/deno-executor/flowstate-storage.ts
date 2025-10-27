/**
 * Custom FlowState storage adapter for Supabase database integration
 *
 * This adapter integrates FlowState with the existing tasker database schema,
 * maintaining compatibility with the current stack run structure.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';
import { type FlowStateStorage, type FlowStateStoredTask } from 'npm:flowstate@latest';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
 * Supabase storage adapter for FlowState
 *
 * This adapter stores FlowState tasks in the existing stack_runs table,
 * maintaining compatibility with the current architecture.
 */
export class SupabaseFlowStateStorage implements FlowStateStorage {

  /**
   * Convert FlowState task to database format for stack_runs table
   */
  private flowStateToDbFormat(task: FlowStateStoredTask): any {
    const dbTask: any = {
      id: task.id, // This will be the stack_run_id
      parent_task_run_id: this.extractTaskRunId(task.id),
      service_name: 'flowstate',
      method_name: 'execute',
      args: [task.name || 'flowstate-task'],
      status: this.mapFlowStateStatus(task.status),
      vm_state: {
        taskCode: task.code,
        taskName: task.name,
        flowStateTask: task // Store the complete FlowState task
      },
      result: task.result,
      error: task.error,
      created_at: new Date(task.timestamp).toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add suspension-specific fields if paused
    if (task.status === 'paused' && task.fetchRequest) {
      dbTask.vm_state.fetchRequest = task.fetchRequest;
      dbTask.waiting_on_stack_run_id = this.generateChildStackRunId(task.id);
    }

    // Add expiration if provided
    if (task.expiresAt) {
      dbTask.expires_at = new Date(task.expiresAt).toISOString();
    }

    return dbTask;
  }

  /**
   * Convert database format to FlowState task
   */
  private dbToFlowStateFormat(dbTask: any): FlowStateStoredTask {
    const flowStateTask = dbTask.vm_state?.flowStateTask || {
      id: dbTask.id,
      name: dbTask.vm_state?.taskName || 'flowstate-task',
      code: dbTask.vm_state?.taskCode || '',
      status: 'running',
      timestamp: new Date(dbTask.created_at).getTime(),
      pauseCount: 0
    };

    // Update status and other fields from database
    return {
      ...flowStateTask,
      status: this.mapDbStatusToFlowState(dbTask.status),
      result: dbTask.result,
      error: dbTask.error,
      vmState: dbTask.vm_state?.vmState,
      fetchRequest: dbTask.vm_state?.fetchRequest,
      timestamp: new Date(dbTask.created_at).getTime(),
      pauseCount: dbTask.vm_state?.pauseCount || 0,
      expiresAt: dbTask.expires_at ? new Date(dbTask.expires_at).getTime() : undefined
    };
  }

  /**
   * Map FlowState status to database status
   */
  private mapFlowStateStatus(status: string): string {
    switch (status) {
      case 'running':
        return 'processing';
      case 'paused':
        return 'suspended_waiting_child';
      case 'completed':
        return 'completed';
      case 'error':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Map database status to FlowState status
   */
  private mapDbStatusToFlowState(status: string): string {
    switch (status) {
      case 'processing':
      case 'pending':
        return 'running';
      case 'suspended_waiting_child':
        return 'paused';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'error';
      default:
        return 'running';
    }
  }

  /**
   * Extract task run ID from FlowState task ID
   */
  private extractTaskRunId(taskId: string): number {
    // Assuming taskId format includes task run ID, adjust as needed
    const parts = taskId.split('-');
    return parseInt(parts[parts.length - 1]) || 1;
  }

  /**
   * Generate child stack run ID
   */
  private generateChildStackRunId(parentId: string): number {
    // Generate a unique ID for the child stack run
    return parseInt(parentId.replace(/\D/g, '').slice(-8)) || Date.now();
  }

  async save(state: FlowStateStoredTask): Promise<void> {
    try {
      const dbTask = this.flowStateToDbFormat(state);

      // Check if this is an update or insert
      const { data: existing } = await supabase
        .from('stack_runs')
        .select('id')
        .eq('id', state.id)
        .single();

      if (existing) {
        // Update existing task
        const { error } = await supabase
          .from('stack_runs')
          .update(dbTask)
          .eq('id', state.id);

        if (error) {
          throw new Error(`Failed to update FlowState task: ${error.message}`);
        }
      } else {
        // Insert new task
        const { error } = await supabase
          .from('stack_runs')
          .insert([dbTask]);

        if (error) {
          throw new Error(`Failed to save FlowState task: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error saving FlowState task:', error);
      throw error;
    }
  }

  async load(taskId: string): Promise<FlowStateStoredTask | null> {
    try {
      const { data, error } = await supabase
        .from('stack_runs')
        .select('*')
        .eq('id', taskId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') { // Not found
          return null;
        }
        throw new Error(`Failed to load FlowState task: ${error.message}`);
      }

      return this.dbToFlowStateFormat(data);
    } catch (error) {
      console.error('Error loading FlowState task:', error);
      return null;
    }
  }

  async delete(taskId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('stack_runs')
        .delete()
        .eq('id', taskId);

      if (error) {
        throw new Error(`Failed to delete FlowState task: ${error.message}`);
      }

      return true;
    } catch (error) {
      console.error('Error deleting FlowState task:', error);
      return false;
    }
  }

  async list(): Promise<FlowStateStoredTask[]> {
    try {
      const { data, error } = await supabase
        .from('stack_runs')
        .select('*')
        .eq('service_name', 'flowstate')
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to list FlowState tasks: ${error.message}`);
      }

      return data.map(task => this.dbToFlowStateFormat(task));
    } catch (error) {
      console.error('Error listing FlowState tasks:', error);
      return [];
    }
  }

  async cleanup(options: any = {}): Promise<number> {
    try {
      const now = Date.now();
      const maxAge = options.maxAge || 24 * 60 * 60 * 1000; // 24 hours
      const deleteCompleted = options.deleteCompleted !== false;
      const deleteErrored = options.deleteErrored !== false;
      const deleteExpired = options.deleteExpired !== false;

      let query = supabase
        .from('stack_runs')
        .select('id', { count: 'exact' })
        .eq('service_name', 'flowstate');

      // Build conditions for cleanup
      const conditions: string[] = [];

      if (deleteExpired) {
        conditions.push(`expires_at < '${new Date(now).toISOString()}'`);
      }

      if (maxAge > 0) {
        conditions.push(`created_at < '${new Date(now - maxAge).toISOString()}'`);
      }

      if (deleteCompleted) {
        conditions.push(`status = 'completed'`);
      }

      if (deleteErrored) {
        conditions.push(`status = 'failed'`);
      }

      // Apply conditions if any
      if (conditions.length > 0) {
        query = query.or(conditions.join(','));
      }

      const { count, error } = await query;

      if (error) {
        throw new Error(`Failed to cleanup FlowState tasks: ${error.message}`);
      }

      if (count && count > 0) {
        // Delete the matching tasks
        const { error: deleteError } = await supabase
          .from('stack_runs')
          .delete()
          .eq('service_name', 'flowstate')
          .or(conditions.join(','));

        if (deleteError) {
          throw new Error(`Failed to delete FlowState tasks during cleanup: ${deleteError.message}`);
        }
      }

      return count || 0;
    } catch (error) {
      console.error('Error cleaning up FlowState tasks:', error);
      return 0;
    }
  }
}

// Export singleton instance
export const supabaseFlowStateStorage = new SupabaseFlowStateStorage();