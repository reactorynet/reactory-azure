import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type {
  IAzureChecklistItemInput,
  IAzureChecklistItemUpdateInput,
  IAzureTodoTaskCreateInput,
  IAzureTodoTaskListInput,
  IAzureTodoTaskQueryOptions,
  IAzureTodoTaskUpdateInput,
} from '../../types/tasks.types';

/**
 * GraphQL surface for Microsoft To Do (AZ-06).
 *
 * A thin adapter: every field resolves `azure.AzureTodoService@1.0.0` and passes
 * the calling user's id, so all Graph access, validation and error translation
 * stays in one service. Nothing here targets `/me/outlook/tasks` or any preview
 * endpoint - the To Do API is `/me/todo/...` on Graph v1.0.
 *
 * There is no `assignedTo` argument on any field, by design: Microsoft To Do
 * tasks have no assignee, and task assignment belongs to Planner
 * (`/planner/tasks` with `assignments`). See `Tasks.graphql`.
 */
@resolver
class TasksResolver {
  resolver: any;

  /** Resolve the service or fail with a message that names it. */
  private todo(context: Reactory.Server.IReactoryContext): any {
    const todoService = context.getService('azure.AzureTodoService@1.0.0') as any;
    if (!todoService) throw new Error('Azure Todo Service not available');
    return todoService;
  }

  /* ---------------------------------------------------------------- queries */

  @roles(['USER'], 'args.context')
  @query('azureTodoLists')
  async listTaskLists(
    _obj: any,
    _params: Record<string, unknown>,
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).listTaskLists(String(context.user._id));
  }

  @roles(['USER'], 'args.context')
  @query('azureTodoTasks')
  async listTasks(
    _obj: any,
    params: { listId: string; filter?: IAzureTodoTaskQueryOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).listTasks(String(context.user._id), String(params.listId), params.filter || {});
  }

  @roles(['USER'], 'args.context')
  @query('azureTodoTask')
  async getTask(
    _obj: any,
    params: { listId: string; taskId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).getTask(String(context.user._id), String(params.listId), String(params.taskId));
  }

  @roles(['USER'], 'args.context')
  @query('azureTodoChecklistItems')
  async listChecklistItems(
    _obj: any,
    params: { listId: string; taskId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).listChecklistItems(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
    );
  }

  /* -------------------------------------------------------------- mutations */

  @roles(['USER'], 'args.context')
  @mutation('azureCreateTodoList')
  async createTaskList(
    _obj: any,
    params: { input: IAzureTodoTaskListInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).createTaskList(String(context.user._id), params.input);
  }

  @roles(['USER'], 'args.context')
  @mutation('azureUpdateTodoList')
  async updateTaskList(
    _obj: any,
    params: { listId: string; input: IAzureTodoTaskListInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).updateTaskList(String(context.user._id), String(params.listId), params.input);
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteTodoList')
  async deleteTaskList(
    _obj: any,
    params: { listId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    await this.todo(context).deleteTaskList(String(context.user._id), String(params.listId));
    return true;
  }

  @roles(['USER'], 'args.context')
  @mutation('azureCreateTodoTask')
  async createTask(
    _obj: any,
    params: { listId: string; input: IAzureTodoTaskCreateInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).createTask(String(context.user._id), String(params.listId), params.input);
  }

  @roles(['USER'], 'args.context')
  @mutation('azureUpdateTodoTask')
  async updateTask(
    _obj: any,
    params: { listId: string; taskId: string; input: IAzureTodoTaskUpdateInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).updateTask(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
      params.input,
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureCompleteTodoTask')
  async completeTask(
    _obj: any,
    params: { listId: string; taskId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).completeTask(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteTodoTask')
  async deleteTask(
    _obj: any,
    params: { listId: string; taskId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    await this.todo(context).deleteTask(String(context.user._id), String(params.listId), String(params.taskId));
    return true;
  }

  @roles(['USER'], 'args.context')
  @mutation('azureCreateTodoChecklistItem')
  async createChecklistItem(
    _obj: any,
    params: { listId: string; taskId: string; input: IAzureChecklistItemInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).createChecklistItem(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
      params.input,
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureUpdateTodoChecklistItem')
  async updateChecklistItem(
    _obj: any,
    params: {
      listId: string;
      taskId: string;
      checklistItemId: string;
      input: IAzureChecklistItemUpdateInput;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    return this.todo(context).updateChecklistItem(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
      String(params.checklistItemId),
      params.input,
    );
  }

  @roles(['USER'], 'args.context')
  @mutation('azureDeleteTodoChecklistItem')
  async deleteChecklistItem(
    _obj: any,
    params: { listId: string; taskId: string; checklistItemId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    await this.todo(context).deleteChecklistItem(
      String(context.user._id),
      String(params.listId),
      String(params.taskId),
      String(params.checklistItemId),
    );
    return true;
  }
}

export default TasksResolver;
