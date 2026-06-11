import { AdminForthPlugin, Filters, Sorts } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResource, AdminUser, AdminForthComponentDeclarationFull } from "adminforth";
import type { PluginOptions } from './types.js';
import { afLogger } from "adminforth";
import pLimit from 'p-limit';
import { Level } from 'level';
import fs from 'fs/promises';
import { Mutex } from 'async-mutex';

type TaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
type setStateFieldParams = {
  (fieldName: string, value: any): Promise<void>;
  (state: Record<string, any>): Promise<void>;
};
type getStateFieldParams = {
  (fieldName: string): Promise<any>;
  (): Promise<Record<string, any>>;
};
type getStateParams = () => Promise<Record<string, any>>;
type taskHandlerType = ( { jobId, setTaskStateField, getTaskStateField, getState }: { jobId: string; setTaskStateField: setStateFieldParams; getTaskStateField: getStateFieldParams; getState: getStateParams } ) => Promise<void>;
type allTasksDoneStatusType = {
  jobId: string;
  failedTasks: number;
  succeededTasks: number;
};
type onAllTasksDoneType = (status: allTasksDoneStatusType) => Promise<void> | void;
type taskType = {
  skip?: boolean;
  state: Record<string, any>;
}

function encodeStateFieldName(fieldName: string): string {
  return encodeURIComponent(fieldName);
}
 
export default class BackgroundJobsPlugin extends AdminForthPlugin {
  options: PluginOptions;
  private taskHandlers: Record<string, taskHandlerType> = {};
  private onAllTasksDoneHandlers: Partial<Record<string, onAllTasksDoneType>> = {};
  private jobCustomComponents: Record<string, AdminForthComponentDeclarationFull> = {};
  private jobParallelLimits: Record<string, number> = {};
  private levelDbInstances: Record<string, Level> = {};
  private jobStateMutexes: Record<string, Mutex> = {};
  private deprecatedWarningsShown = new Set<string>();

  constructor(options: PluginOptions) {
    super(options, import.meta.url);
    this.options = options;
    this.shouldHaveSingleInstancePerWholeApp = () => true;
  }

  private getResourcePk(): string {
    const resourcePk = this.resourceConfig.columns.find(c => c.primaryKey)?.name;
    return resourcePk;
  }

  private getResourceId(): string {
    return this.resourceConfig.resourceId;
  }

  async modifyResourceConfig(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    super.modifyResourceConfig(adminforth, resourceConfig);
    if (!adminforth.config.customization?.globalInjections?.header) {
      adminforth.config.customization.globalInjections.header = [];
    }
    (adminforth.config.customization.globalInjections.header).push({
      file: this.componentPath('NavbarJobs.vue'),
      meta: {
        pluginInstanceId: this.pluginInstanceId,
      }
    });

    // Global API injection: exposes OpenJobInfoPopup(jobId) to open job details from anywhere
    (adminforth.config.customization.globalInjections.header).push({
      file: this.componentPath('GlobalJobApi.vue'),
      meta: {
        pluginInstanceId: this.pluginInstanceId,
      }
    });

    if (!this.adminforth.config.componentsToExplicitRegister) {
      this.adminforth.config.componentsToExplicitRegister = [];
    }
    this.adminforth.config.componentsToExplicitRegister.push(
      {
        file: this.componentPath('StateToIcon.vue')
      }
    );

    if (!this.resourceConfig.hooks) {
      this.resourceConfig.hooks = {};
    }
    if (!this.resourceConfig.hooks.delete) {
      this.resourceConfig.hooks.delete = {};
    }
    if (!this.resourceConfig.hooks.delete.beforeSave) {
      this.resourceConfig.hooks.delete.beforeSave = [];
    }
    this.resourceConfig.hooks.delete.beforeSave.push(async ({record, recordId}: {record: any, recordId: any}) => {

      const levelDbPath = `${this.options.levelDbPath || './background-jobs-dbs/'}job_${recordId}`;
      const jobLevelDb = this.levelDbInstances[recordId];

      //close level db instance if it's open and delete the level db folder for the job
      if (jobLevelDb) {
        await jobLevelDb.close();
        delete this.levelDbInstances[recordId];
      }

      // cleanup per-job mutex as well
      delete this.jobStateMutexes[recordId];

      //delete level db folder for the job
      await fs.rm(levelDbPath, {
        recursive: true,
        force: true,
      });

      return {ok: true};
    })
  }

  private cleanupJobMutexIfTerminalStatus(jobId: string, status: string) {
    // Keep mutex while job is active to preserve atomicity between concurrent tasks.
    if (status === 'DONE' || status === 'DONE_WITH_ERRORS' || status === 'CANCELLED') {
      delete this.jobStateMutexes[jobId];
    }
  }

  private checkIfFieldInResource(resourceConfig: AdminForthResource, fieldName: string, fieldString?: string) {
    if (!fieldName) {
      throw new Error(`Field name for ${fieldString} is not provided. Please check your plugin options.`);
    }
    const fieldInConfig = resourceConfig.columns.find(f => f.name === fieldName);
    if (!fieldInConfig) {
      throw new Error(`Field ${fieldName} not found in resource config. Please check your plugin options.`);
    }
  }

  private async createLevelDbTaskRecord(levelDb: Level, taskId: string, initialState: Record<string, any>) {
    //create record in level db with task id as key and initial state as value and status SCHEDULED
    await levelDb.put(taskId, JSON.stringify({ state: initialState, status: 'SCHEDULED' }));
  }

  private async setLevelDbTaskStateField(levelDb: Level, taskId: string, state: Record<string, any>) {
    //update record in level db with task id as key and new state as value
    const status = await this.getLevelDbTaskStatusField(levelDb, taskId);
    await levelDb.del(taskId);
    await levelDb.put(taskId, JSON.stringify({ state, status }));
  }

  private async setLevelDbTaskStatusField(levelDb: Level, taskId: string, status: TaskStatus) {
    const state = await this.getLevelDbTaskStateField(levelDb, taskId);
    await levelDb.del(taskId);
    await levelDb.put(taskId, JSON.stringify({ state, status }));
  }

  private async getLevelDbTaskStateField(levelDb: Level, taskId: string): Promise<Record<string, any>> {
    //get record from level db with task id as key and return the value of the key in the state
    const state = await levelDb.get(taskId);
    if (state) {
      const parsedState = JSON.parse(state);
      return parsedState.state;
    }
    return Promise.resolve(null);
  }

  private async getLevelDbTaskStatusField(levelDb: Level, taskId: string): Promise<TaskStatus> {
    const state = await levelDb.get(taskId);
    if (state) {
      const parsedState = JSON.parse(state);
      return parsedState.status;
    }
    return Promise.resolve(null);
  }

  private async getTotalTasksInLevelDb(levelDb: Level): Promise<number> {
    const count = await levelDb.get('_meta:count');
    return count ? parseInt(count, 10) : 0;
  }

  private async getAllTasksDoneStatus(levelDb: Level): Promise<Omit<allTasksDoneStatusType, 'jobId'>> {
    const totalTasks = await this.getTotalTasksInLevelDb(levelDb);
    let failedTasks = 0;
    let succeededTasks = 0;

    for (let taskIndex = 0; taskIndex < totalTasks; taskIndex++) {
      const status = await this.getLevelDbTaskStatusField(levelDb, taskIndex.toString());
      if (status === 'FAILED') {
        failedTasks++;
      } else if (status === 'DONE') {
        succeededTasks++;
      }
    }

    return { failedTasks, succeededTasks };
  }

  private async getLevelDbForTheJob(jobId: string): Promise<Level> {
    const levelDbPath = `${this.options.levelDbPath || './background-jobs-dbs/'}job_${jobId}`;
    let jobLevelDb: Level;
    if (this.levelDbInstances[jobId]) {
      jobLevelDb = this.levelDbInstances[jobId];
    } else {
      try {
        jobLevelDb = new Level(levelDbPath, { valueEncoding: 'json' });
        this.levelDbInstances[jobId] = jobLevelDb;
      } catch (error) {
        throw new Error(`Failed to access task storage for job with id ${jobId}.`);
      }
    }
    return jobLevelDb;
  }

  private publishJobStateField(jobId: string, fieldName: string, value: any) {
    this.adminforth.websocket.publish(`/background-jobs-state-update/${jobId}/${encodeStateFieldName(fieldName)}`, {
      jobId,
      fieldName,
      value,
    });
  }

  private publishTaskStateFields(jobId: string, taskIndex: number, state: Record<string, any>) {
    for (const [fieldName, value] of Object.entries(state)) {
      this.adminforth.websocket.publish(`/background-jobs-task-state-update/${jobId}/${encodeStateFieldName(fieldName)}`, {
        jobId,
        taskIndex,
        fieldName,
        value,
      });
    }
  }

  private warnDeprecatedOnce(key: string, message: string) {
    if (this.deprecatedWarningsShown.has(key)) {
      return;
    }

    this.deprecatedWarningsShown.add(key);
    afLogger.warn(message);
  }

  private async triggerOnAllTasksDone(onAllTasksDone: onAllTasksDoneType | undefined, levelDb: Level, jobId: string) {
    if (!onAllTasksDone) {
      return;
    }

    try {
      const status = await this.getAllTasksDoneStatus(levelDb);
      await onAllTasksDone({ jobId, ...status });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      afLogger.error(`Error in onAllTasksDone callback for job ${jobId}: ${errorMessage}`);
    }
  }
  
  public registerTaskHandler({ jobHandlerName, handler, parallelLimit = 3, onAllTasksDone,
  }:{jobHandlerName: string, handler: taskHandlerType, parallelLimit?: number, onAllTasksDone?: onAllTasksDoneType}) {
    //register the handler in a map with jobHandlerName as key and handler as value
    this.taskHandlers[jobHandlerName] = handler;
    this.jobParallelLimits[jobHandlerName] = parallelLimit;
    if (onAllTasksDone) {
      this.onAllTasksDoneHandlers[jobHandlerName] = onAllTasksDone;
    } else {
      delete this.onAllTasksDoneHandlers[jobHandlerName];
    }
  }

  public registerTaskDetailsComponent({
    jobHandlerName,
    component,
  }:{jobHandlerName: string, component: AdminForthComponentDeclarationFull}) {
    this.jobCustomComponents[jobHandlerName] = component;
  }

  public async startNewJob(
    jobName: string,
    adminUser: AdminUser,
    tasks: taskType[],
    jobHandlerName: string,
    initialState: Record<string, any> = {},
  ): Promise<string> {

    const handleTask: taskHandlerType = this.taskHandlers[jobHandlerName];
    const onAllTasksDone = this.onAllTasksDoneHandlers[jobHandlerName];
    if (!handleTask) {
      throw new Error(`No handler registered for jobHandler ${jobHandlerName}. Please register a handler using the registerTaskHandler method before starting a job with this jobHandler.`);
    }
    const customComponent = this.jobCustomComponents[jobHandlerName];
    const parrallelLimit = this.jobParallelLimits[jobHandlerName] || 3;
    //create a record for the job in the database with status in progress
    const objectToSave = {
      [this.options.nameField]: jobName,
      [this.options.startedByField]: adminUser.pk,
      [this.options.progressField]: 0,
      [this.options.statusField]: 'IN_PROGRESS',
      [this.options.jobHandlerField]: jobHandlerName,
      [this.options.stateField]: initialState
    }

    const creationResult = await this.adminforth.resource(this.getResourceId()).create(objectToSave);
    let createdRecord: Record<string, any> = null;
    if (creationResult.ok === true ) {
      createdRecord = creationResult.createdRecord;
    } else {
      throw new Error(`Failed to create a record for the job. Error: ${creationResult.error}`);
    }    
    const jobId = createdRecord[this.getResourcePk()];
    
    this.adminforth.websocket.publish('/background-jobs-job-update', { 
      jobId, 
      status: 'IN_PROGRESS', 
      name: jobName,
      progress: 0,
      createdAt: createdRecord[this.options.createdAtField],
      customComponent,
    });

    //create a level db instance for the job with name as jobId
    const jobLevelDb = await this.getLevelDbForTheJob(jobId);
    await jobLevelDb.put('_meta:count', `${tasks.length}`);
    const limit2 = pLimit(parrallelLimit);
    const createTaskRecordsPromises = tasks.map((task, index) => {
      return limit2(() => this.createLevelDbTaskRecord(jobLevelDb, index.toString(), task.state));
    });

    await Promise.all(createTaskRecordsPromises);

    this.runProcessingTasks(tasks, jobLevelDb, jobId, handleTask, parrallelLimit, onAllTasksDone);
    return jobId;
  }

  public async addNewTasksToExistingJob(
    jobId: string,
    tasks: taskType[],
  ) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    if (!jobRecord) {
      throw new Error(`Job with id ${jobId} not found.`);
    }
    const jobStatus = jobRecord[this.options.statusField];
    if (jobStatus !== 'IN_PROGRESS') {
      throw new Error(`Cannot add tasks to a job with status ${jobStatus}. Only jobs with status IN_PROGRESS can be added new tasks.`);
    }
    const jobLevelDb = await this.getLevelDbForTheJob(jobId);
    const currentTotalTasks = await this.getTotalTasksInLevelDb(jobLevelDb);
    const newTotalTasks = currentTotalTasks + tasks.length;
    await jobLevelDb.put('_meta:count', `${newTotalTasks}`);
    const createTaskRecordsPromises = tasks.map((task, index) => {
      return this.createLevelDbTaskRecord(jobLevelDb, (currentTotalTasks + index).toString(), task.state);
    });

    await Promise.all(createTaskRecordsPromises);
  }

  public async deleteTasksFromExistingJob(
    jobId: string,
    taskIndex: number,
  ): Promise<void> {
    if (taskIndex < 0) {
      throw new Error(`Invalid task index ${taskIndex}.`);
    }
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    if (!jobRecord) {
      throw new Error(`Job with id ${jobId} not found.`);
    }
    const jobStatus = jobRecord[this.options.statusField];
    if (jobStatus !== 'IN_PROGRESS') {
      throw new Error(`Cannot delete tasks from a job with status ${jobStatus}. Only jobs with status IN_PROGRESS can have tasks deleted.`);
    }
    const jobLevelDb = await this.getLevelDbForTheJob(jobId);
    const currentTotalTasks = await this.getTotalTasksInLevelDb(jobLevelDb);
    if (taskIndex >= currentTotalTasks) {
      throw new Error(`Invalid task index ${taskIndex}.`);
    }
    await jobLevelDb.del(taskIndex.toString());
    await jobLevelDb.put('_meta:count', `${currentTotalTasks - 1}`);
  }

  private async getUnfinishedTasksFromLevelDb(levelDb: Level): Promise<{ state: Record<string, any> }[]> {
    const totalTasks = await this.getTotalTasksInLevelDb(levelDb);
    const unfinishedTasks: { state: Record<string, any> }[] = [];
    for (let taskIndex = 0; taskIndex < totalTasks; taskIndex++) {
      const status = await this.getLevelDbTaskStatusField(levelDb, taskIndex.toString());
      if (status === 'IN_PROGRESS' || status === 'SCHEDULED') {
        const state = await this.getLevelDbTaskStateField(levelDb, taskIndex.toString());
        unfinishedTasks.push({ state });
      }
    }
    return unfinishedTasks;
  }

  private async runProcessingTasks(
    tasks: taskType[],
    jobLevelDb: Level,
    jobId: string,
    handleTask: taskHandlerType,
    parrallelLimit: number,
    onAllTasksDone?: onAllTasksDoneType,
  ) {
    let totalTasks = tasks.length;
    let completedTasks = 0;
    let failedTasks = 0;
    let lastJobStatus = 'IN_PROGRESS';

    const taskHandler = async ( taskIndex: number, task: taskType ) => {
      totalTasks = await this.getTotalTasksInLevelDb(jobLevelDb);
      if (task.skip) {
        completedTasks = await this.handleFinishTask(completedTasks, totalTasks, jobId, true);
        return;
      }
      if (lastJobStatus === 'CANCELLED') {
        afLogger.info(`Job ${jobId} was cancelled. Skipping task ${taskIndex}.`);
        return;
      }
      const currentJobStatus = await this.getLastJobStatus(jobId);

      if (currentJobStatus === 'CANCELLED') {
        lastJobStatus = currentJobStatus;
        afLogger.info(`Job ${jobId} was cancelled. Skipping task ${taskIndex}.`);
        return;
      }
      // check if task is still exists in level db, because it can be deleted while processing
      const taskStatus = await this.getLevelDbTaskStatusField(jobLevelDb, taskIndex.toString());
      if (!taskStatus) {
        afLogger.info(`Task ${taskIndex} of job ${jobId} was deleted. Skipping processing.`);
        return;
      }
      const getState = async () => {
        return await this.getLevelDbTaskStateField(jobLevelDb, taskIndex.toString());
      }
      const setTaskStateField: setStateFieldParams = async (fieldNameOrState: string | Record<string, any>, value?: any) => {
        if (typeof fieldNameOrState === 'string') {
          const state = await getState();
          const updatedState = {
            ...state,
            [fieldNameOrState]: value,
          };
          await this.setLevelDbTaskStateField(jobLevelDb, taskIndex.toString(), updatedState);
          this.publishTaskStateFields(jobId, taskIndex, { [fieldNameOrState]: value });
          return;
        }

        this.warnDeprecatedOnce(
          'setTaskStateField-object',
          'BackgroundJobsPlugin: setTaskStateField(stateObject) is deprecated and will be removed soon. Use setTaskStateField(fieldName: string, value: any) instead. Use getState() when you need the full task state.',
        );
        await this.setLevelDbTaskStateField(jobLevelDb, taskIndex.toString(), fieldNameOrState);
        this.publishTaskStateFields(jobId, taskIndex, fieldNameOrState);
      }
      const getTaskStateField: getStateFieldParams = async (fieldName?: string) => {
        const state = await getState();
        if (typeof fieldName === 'string') {
          return state[fieldName];
        }

        this.warnDeprecatedOnce(
          'getTaskStateField-no-args',
          'BackgroundJobsPlugin: getTaskStateField() without a field name is deprecated and will be removed soon. Use getTaskStateField(fieldName: string) for one field, or getState() for the full task state.',
        );
        return state;
      }

      await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'IN_PROGRESS');
      this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "IN_PROGRESS" });

      //handling the task 
      try {
        await handleTask({ jobId, setTaskStateField, getTaskStateField, getState });

        //Set task status to completed in level db
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'DONE');
        this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "DONE" });
      } catch (error) {
        const errorMessage = error?.message || 'Unknown error';
        afLogger.error(`Error in handling task ${taskIndex} of job ${jobId}: ${errorMessage}`, );
        await this.setJobStateField(jobId, 'error', errorMessage);
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'FAILED');
        this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "FAILED" });
        failedTasks++;
        return;
      } finally {
        //Update progress
        const currentJobStatus = await this.getLastJobStatus(jobId);
        if (currentJobStatus === 'CANCELLED') {
          lastJobStatus = currentJobStatus;
          afLogger.debug(`Job ${jobId} was cancelled during processing of task ${taskIndex}. Progress will not be updated.`);
          return;
        }

        completedTasks = await this.handleFinishTask(completedTasks, totalTasks, jobId);        
      }
    }

    const limit = pLimit(parrallelLimit);
    const tasksToExecute = tasks.map((task, taskIndex) => {
      return limit(() => taskHandler(taskIndex, task));
    });

    await Promise.all(tasksToExecute);
    const unfinishedTasks = await this.getUnfinishedTasksFromLevelDb(jobLevelDb);
    if (unfinishedTasks.length > 0) {
      const tasksToReprocess = tasks.map((t) => {t.skip =  true; t.state = t.state || {}; return t;});
      tasksToReprocess.push(...unfinishedTasks);
      await this.runProcessingTasks(tasksToReprocess, jobLevelDb, jobId, handleTask, parrallelLimit, onAllTasksDone);
    } else {
      if (lastJobStatus !== 'CANCELLED' && failedTasks === 0) {
        await this.adminforth.resource(this.getResourceId()).update(jobId, {
          [this.options.statusField]: 'DONE',
          [this.options.finishedAtField]: (new Date()).toISOString(),
        })
        this.adminforth.websocket.publish('/background-jobs-job-update', { jobId, status: 'DONE', finishedAt: (new Date()).toISOString() });
        this.cleanupJobMutexIfTerminalStatus(jobId, 'DONE');
        await this.triggerOnAllTasksDone(onAllTasksDone, jobLevelDb, jobId);
      } else if (failedTasks > 0) {
        await this.adminforth.resource(this.getResourceId()).update(jobId, {
          [this.options.statusField]: 'DONE_WITH_ERRORS',
          [this.options.finishedAtField]: (new Date()).toISOString(),
        })
        this.adminforth.websocket.publish('/background-jobs-job-update', { jobId, status: 'DONE_WITH_ERRORS', finishedAt: (new Date()).toISOString() });
        this.cleanupJobMutexIfTerminalStatus(jobId, 'DONE_WITH_ERRORS');
        await this.triggerOnAllTasksDone(onAllTasksDone, jobLevelDb, jobId);
      }
    }
  }

  private async getLastJobStatus(jobId: string): Promise<string> {
    const currentJobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const currentJobStatus = currentJobRecord[this.options.statusField];
    return currentJobStatus;
  }

  private async handleFinishTask(completedTasks: number, totalTasks: number, jobId: string, wasTaskSkipped: boolean = false) {
    completedTasks++;
    if (wasTaskSkipped) {
      return completedTasks;
    }
    const progress = Math.round((completedTasks / totalTasks) * 100);
    await this.adminforth.resource(this.getResourceId()).update(jobId, {
      [this.options.progressField]: progress,
    })
    this.adminforth.websocket.publish('/background-jobs-job-update', { jobId, progress });
    return completedTasks;
  }


  private async runProcessingUnfinishedTasks(
    job: Record<string, any>
  ) {
    const levelDbPath = `${this.options.levelDbPath || './background-jobs-dbs/'}job_${job[this.getResourcePk()]}`;
    const jobLevelDb = new Level(levelDbPath, { valueEncoding: 'json' });
    this.levelDbInstances[job[this.getResourcePk()]] = jobLevelDb;
    const jobHandlerName = job[this.options.jobHandlerField];
    const handleTask: taskHandlerType = this.taskHandlers[jobHandlerName];
    if (!handleTask) {
      afLogger.error(`No handler registered for jobHandler ${jobHandlerName}. Cannot process unfinished tasks for job ${job[this.getResourcePk()]}.`);
      return;
    }
    const parrallelLimit = this.jobParallelLimits[jobHandlerName] || 3;
    const onAllTasksDone = this.onAllTasksDoneHandlers[jobHandlerName];
    
    const unfinishedTasks: taskType[] = [];
    let taskIndex = 0;
    while (true) {
      const taskData = await jobLevelDb.get(taskIndex.toString());
      if (!taskData) {   
        break;
      }
      let parsedTaskData: { state: Record<string, any>, status: TaskStatus };
      try {
        parsedTaskData = JSON.parse(taskData);
      } catch (error) {
        afLogger.error(`Error parsing task data for task ${taskIndex} of job ${job[this.getResourcePk()]}: ${error}`);
        taskIndex++;
        continue;
      }
      if (parsedTaskData.status === 'IN_PROGRESS' || parsedTaskData.status === 'SCHEDULED') {
        unfinishedTasks.push({ state: parsedTaskData.state });
      } else {
        unfinishedTasks.push({ state: parsedTaskData.state, skip: true });
      }
      taskIndex++;
    }
    await this.runProcessingTasks(unfinishedTasks, jobLevelDb, job[this.getResourcePk()], handleTask, parrallelLimit, onAllTasksDone);

  }

  public async setJobStateField(jobId: string, key: string, value: any) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const state = jobRecord[this.options.stateField];
    state[key] = value;
    await this.adminforth.resource(this.getResourceId()).update(jobId, {
      [this.options.stateField]: state,
    });
    this.publishJobStateField(jobId, key, value);
  }

  public async getJobStateField(jobId: string, key: string) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const state = jobRecord[this.options.stateField];
    return state[key];
  }

  public async getJobState(jobId: string) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    return jobRecord[this.options.stateField];
  }

  public async setJobField(jobId: string, key: string, value: any) {
    this.warnDeprecatedOnce(
      'setJobField',
      'BackgroundJobsPlugin: setJobField(jobId, key, value) is deprecated and will be removed soon. Use setJobStateField(jobId, fieldName: string, value: any) instead.',
    );
    return this.setJobStateField(jobId, key, value);
  }

  public async getJobField(jobId: string, key: string) {
    this.warnDeprecatedOnce(
      'getJobField',
      'BackgroundJobsPlugin: getJobField(jobId, key) is deprecated and will be removed soon. Use getJobStateField(jobId, fieldName: string) instead.',
    );
    return this.getJobStateField(jobId, key);
  }

  public async updateJobFieldsAtomically(jobId: string, updateFunction: () => Promise<void>) {
    if (!jobId) {
      throw new Error('updateJobFieldsAtomically: jobId is required');
    }
    if (typeof updateFunction !== 'function') {
      throw new Error('updateJobFieldsAtomically: updateFunction must be a function');
    }

    // Ensure updates are atomic per jobId.
    // Different jobs are not blocked by each other.
    let mutex = this.jobStateMutexes[jobId];
    if (!mutex) {
      mutex = new Mutex();
      this.jobStateMutexes[jobId] = mutex;
    }

    return mutex.runExclusive(async () => {
      await updateFunction();
    });
  }

  private async processAllUnfinishedJobs() {
    const resourceId = this.getResourceId();
    const unprocessedJobs = await this.adminforth.resource(resourceId).list(Filters.EQ(this.options.statusField, 'IN_PROGRESS'));
    for (const job of unprocessedJobs) {
      const jobName = job[this.options.nameField];
      afLogger.info(`Processing unfinished job with name ${jobName} on startup.`);
      this.runProcessingUnfinishedTasks(job);
    }
  }

  
  async validateConfigAfterDiscover(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    // optional method where you can safely check field types after database discovery was performed
    this.checkIfFieldInResource(resourceConfig, this.options.createdAtField, 'createdAtField');
    this.checkIfFieldInResource(resourceConfig, this.options.finishedAtField, 'finishedAtField');
    this.checkIfFieldInResource(resourceConfig, this.options.startedByField, 'startedByField');
    this.checkIfFieldInResource(resourceConfig, this.options.stateField, 'stateField');
    this.checkIfFieldInResource(resourceConfig, this.options.progressField, 'progressField');
    this.checkIfFieldInResource(resourceConfig, this.options.statusField, 'statusField');
    this.checkIfFieldInResource(resourceConfig, this.options.nameField, 'nameField');
    this.checkIfFieldInResource(resourceConfig, this.options.jobHandlerField, 'jobHandlerField');


    //Add temp delay to make sure, that all resources active. Probably should be fixed
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.processAllUnfinishedJobs();
  }

  instanceUniqueRepresentation(pluginOptions: any) : string {
    return `BackgroundJobsPlugin`;
  }

  setupEndpoints(server: IHttpServer) {
    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/get-list-of-jobs`,
      handler: async ({ adminUser }) => {
        const user = adminUser;
        const startedByField = this.options.startedByField;
        const resourcePk = this.getResourcePk();
        const listOfJobs = await this.adminforth.resource(this.resourceConfig.resourceId).list(Filters.EQ(startedByField, user.pk), 100, 0, Sorts.DESC(this.options.createdAtField));
        
        const jobsToReturn = listOfJobs.map(job => {
          return {
            id: job[resourcePk],
            name: job[this.options.nameField],
            createdAt: job[this.options.createdAtField],
            finishedAt: job[this.options.finishedAtField] || null,
            status: job[this.options.statusField],
            progress: job[this.options.progressField],
            customComponent: this.jobCustomComponents[job[this.options.jobHandlerField]],
          }
        });
        return { jobs: jobsToReturn };
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/get-background-job-info`,
      handler: async ({ adminUser, body }) => {
        const jobId = body.jobId;

        const job = await this.adminforth.resource(this.resourceConfig.resourceId).get(Filters.EQ(this.getResourcePk(), jobId));
        if (!job) {
          return { ok: false, message: `Job with id ${jobId} not found.` };
        }
        const jobToReturn = {
          id: job[this.getResourcePk()],
          name: job[this.options.nameField],
          createdAt: job[this.options.createdAtField],
          finishedAt: job[this.options.finishedAtField] || null,
          status: job[this.options.statusField],
          state: job[this.options.stateField],
          progress: job[this.options.progressField],
          customComponent: this.jobCustomComponents[job[this.options.jobHandlerField]],
        };
        return { ok: true, job: jobToReturn };
      }
    });


    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/cancel-job`,
      handler: async ({ body }) => {
        const jobId = body.jobId;
        const currentJob = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
        const oldStatus = currentJob[this.options.statusField];
        if (oldStatus === 'DONE' || oldStatus === 'DONE_WITH_ERRORS' || oldStatus === 'CANCELLED') {
          return { ok: false, message: `Cannot cancel a job with status ${oldStatus}.` };
        }
        try {
          await this.adminforth.resource(this.getResourceId()).update(jobId, {
            [this.options.statusField]: 'CANCELLED',
            [this.options.finishedAtField]: (new Date()).toISOString(),
          });
          this.adminforth.websocket.publish('/background-jobs-job-update', { 
            jobId, 
            status: 'CANCELLED', 
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, message: `Failed to cancel job with id ${jobId}.` };
        }
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/get-tasks`,
      handler: async ({ body }) => {
        const { jobId, limit, offset } = body;
        const jobLevelDb: Level = await this.getLevelDbForTheJob(jobId);
        if (!jobLevelDb) {
          return { ok: false, message: `Job with id ${jobId} not found.` };
        }
        const tasks = [];
        let taskIndex = 0 + offset;
        while (true) {
          if (limit && tasks.length >= limit) {
            break;
          }
          const taskData = await jobLevelDb.get(taskIndex.toString());
          if (!taskData) {   
            break;
          }
          let parsedTaskData: { state: Record<string, any>, status: TaskStatus };
          try {
            parsedTaskData = JSON.parse(taskData);
          } catch (error) {
            afLogger.error(`Error parsing task data for task ${taskIndex} of job ${jobId}: ${error}`);
            taskIndex++;
            continue;
          }
          tasks.push(parsedTaskData);
          taskIndex++;
        }
          
        const total = await this.getTotalTasksInLevelDb(jobLevelDb);
        return { ok: true, data: { tasks, total } };
      }
    });
  }

}
