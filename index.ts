import { AdminForthPlugin, Filters, Sorts } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResource, AdminUser, AdminForthComponentDeclarationFull } from "adminforth";
import type { PluginOptions } from './types.js';
import { afLogger } from "adminforth";
import pLimit from 'p-limit';
import { Level } from 'level';
import fs from 'fs/promises';
import { Mutex } from 'async-mutex';
import { z } from "zod";

const jobIdBodySchema = z.object({
  jobId: z.union([z.string(), z.number()]),
}).strict();

const getTasksBodySchema = z.object({
  jobId: z.union([z.string(), z.number()]),
  limit: z.number(),
  offset: z.number(),
  fieldsToReturn: z.array(z.string()).optional(),
}).strict();

type TaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
type JobStatus = 'QUEUED' | 'IN_PROGRESS' | 'DONE' | 'DONE_WITH_ERRORS' | 'CANCELLED';
const TERMINAL_JOB_STATUSES: JobStatus[] = ['DONE', 'DONE_WITH_ERRORS', 'CANCELLED'];
const DEFAULT_PARALLEL_LIMIT = 3;
const DEFAULT_CONCURRENCY_LIMIT = 1;
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
type beforeJobFinishStatusType = allTasksDoneStatusType & {
  finishAttemptNumber: number;
};
type onAllTasksDoneType = (status: allTasksDoneStatusType) => Promise<void> | void;
type beforeJobFinishType = (status: beforeJobFinishStatusType) => Promise<void> | void;
type taskType = {
  skip?: boolean;
  state: Record<string, any>;
}
type startNewJobOptions = {
  /**
   * When true the job is always created in QUEUED status, even when its queue has a free concurrency slot.
   * Without it the job is created in QUEUED status only when the queue is busy.
   */
  queued?: boolean;
  /**
   * When false a job which landed in QUEUED status stays there until something else drains the queue
   * (startNextQueuedJob, a finishing job of the same queue, or an application restart). Default: true.
   */
  autoStart?: boolean;
}
/**
 * Everything needed to run the tasks of a single job. Kept as one object so it can be passed through the
 * recursive task processing without a long positional argument list.
 */
type jobRunContext = {
  jobHandlerName: string;
  jobName: string;
  handleTask: taskHandlerType;
  parrallelLimit: number;
  onAllTasksDone?: onAllTasksDoneType;
  beforeJobFinish?: beforeJobFinishType;
}

function encodeStateFieldName(fieldName: string): string {
  return encodeURIComponent(fieldName);
}
 
export default class BackgroundJobsPlugin extends AdminForthPlugin {
  options: PluginOptions;
  private taskHandlers: Record<string, taskHandlerType> = {};
  private onAllTasksDoneHandlers: Partial<Record<string, onAllTasksDoneType>> = {};
  private beforeJobFinishHandlers: Partial<Record<string, beforeJobFinishType>> = {};
  private jobCustomComponents: Record<string, AdminForthComponentDeclarationFull> = {};
  private jobParallelLimits: Record<string, number> = {};
  private jobConcurrencyLimits: Record<string, number> = {};
  private levelDbInstances: Record<string, Level> = {};
  private jobStateMutexes: Record<string, Mutex> = {};
  private jobQueueMutexes: Record<string, Mutex> = {};
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

  private cleanupJobMutexIfTerminalStatus(jobId: string, status: JobStatus) {
    // Keep mutex while job is active to preserve atomicity between concurrent tasks.
    if (TERMINAL_JOB_STATUSES.includes(status)) {
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

  private async triggerBeforeJobFinish(beforeJobFinish: beforeJobFinishType | undefined, levelDb: Level, jobId: string, finishAttemptNumber: number) {
    if (!beforeJobFinish) {
      return;
    }

    try {
      const status = await this.getAllTasksDoneStatus(levelDb);
      await beforeJobFinish({ jobId, ...status, finishAttemptNumber });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      afLogger.error(`Error in beforeJobFinish callback for job ${jobId}: ${errorMessage}`);
    }
  }
  
  public registerTaskHandler({ jobHandlerName, handler, parallelLimit = DEFAULT_PARALLEL_LIMIT, concurrencyLimit = DEFAULT_CONCURRENCY_LIMIT, onAllTasksDone, beforeJobFinish,
  }:{jobHandlerName: string, handler: taskHandlerType, parallelLimit?: number, concurrencyLimit?: number, onAllTasksDone?: onAllTasksDoneType, beforeJobFinish?: beforeJobFinishType}) {
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) {
      throw new Error(`concurrencyLimit for jobHandler ${jobHandlerName} must be an integer greater than 0, got ${concurrencyLimit}.`);
    }
    //register the handler in a map with jobHandlerName as key and handler as value
    this.taskHandlers[jobHandlerName] = handler;
    this.jobParallelLimits[jobHandlerName] = parallelLimit;
    this.jobConcurrencyLimits[jobHandlerName] = concurrencyLimit;
    if (onAllTasksDone) {
      this.onAllTasksDoneHandlers[jobHandlerName] = onAllTasksDone;
    } else {
      delete this.onAllTasksDoneHandlers[jobHandlerName];
    }
    if (beforeJobFinish) {
      this.beforeJobFinishHandlers[jobHandlerName] = beforeJobFinish;
    } else {
      delete this.beforeJobFinishHandlers[jobHandlerName];
    }
  }

  public registerTaskDetailsComponent({
    jobHandlerName,
    component,
  }:{jobHandlerName: string, component: AdminForthComponentDeclarationFull}) {
    this.jobCustomComponents[jobHandlerName] = component;
  }


  private buildJobRunContext(jobHandlerName: string, jobName: string): jobRunContext | null {
    const handleTask: taskHandlerType = this.taskHandlers[jobHandlerName];
    if (!handleTask) {
      return null;
    }
    return {
      jobHandlerName,
      jobName,
      handleTask,
      parrallelLimit: this.jobParallelLimits[jobHandlerName] || DEFAULT_PARALLEL_LIMIT,
      onAllTasksDone: this.onAllTasksDoneHandlers[jobHandlerName],
      beforeJobFinish: this.beforeJobFinishHandlers[jobHandlerName],
    };
  }

  private async canStartJobImmediately(jobHandlerName: string, jobName: string): Promise<boolean> {
    const concurrencyLimit = this.jobConcurrencyLimits[jobHandlerName] || DEFAULT_CONCURRENCY_LIMIT;
    const runningJobsCount = await this.getRunningJobsCount(jobHandlerName, jobName);
    if (runningJobsCount >= concurrencyLimit) {
      return false;
    }
    const [queuedJob] = await this.listJobsByStatus(jobHandlerName, 'QUEUED', jobName, 1);
    return !queuedJob;
  }

  public async startNewJob(
    jobName: string,
    adminUser: AdminUser,
    tasks: taskType[],
    jobHandlerName: string,
    initialState: Record<string, any> = {},
    options: startNewJobOptions = {},
  ): Promise<string> {
    const jobRunContext = this.buildJobRunContext(jobHandlerName, jobName);
    if (!jobRunContext) {
      throw new Error(`No handler registered for jobHandler ${jobHandlerName}. Please register a handler using the registerTaskHandler method before starting a job with this jobHandler.`);
    }
    const customComponent = this.jobCustomComponents[jobHandlerName];
    const { parrallelLimit } = jobRunContext;

    const { createdRecord, initialStatus } = await this.getQueueMutex(jobHandlerName, jobName).runExclusive(async () => {
      const initialStatus: JobStatus = !options.queued && await this.canStartJobImmediately(jobHandlerName, jobName)
        ? 'IN_PROGRESS'
        : 'QUEUED';
      //create a record for the job in the database with status in progress (or queued, when the queue is busy)
      const objectToSave = {
        [this.options.nameField]: jobName,
        [this.options.startedByField]: adminUser.pk,
        [this.options.progressField]: 0,
        [this.options.statusField]: initialStatus,
        [this.options.jobHandlerField]: jobHandlerName,
        [this.options.stateField]: initialState
      }

      const creationResult = await this.adminforth.resource(this.getResourceId()).create(objectToSave);
      if (creationResult.ok !== true) {
        throw new Error(`Failed to create a record for the job. Error: ${creationResult.error}`);
      }
      return { createdRecord: creationResult.createdRecord as Record<string, any>, initialStatus };
    });
    const jobId = createdRecord[this.getResourcePk()];

    this.adminforth.websocket.publish('/background-jobs-job-update', {
      jobId,
      status: initialStatus,
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

    if (initialStatus === 'IN_PROGRESS') {
      this.runProcessingTasks(tasks, jobLevelDb, jobId, jobRunContext);
      return jobId;
    }

    if (options.autoStart !== false) {
      await this.startQueuedJobs(jobHandlerName, jobName);
    }
    return jobId;
  }

  public async queueNewJob(
    jobName: string,
    adminUser: AdminUser,
    tasks: taskType[],
    jobHandlerName: string,
    initialState: Record<string, any> = {},
    options: Omit<startNewJobOptions, 'queued'> = {},
  ): Promise<string> {
    return this.startNewJob(jobName, adminUser, tasks, jobHandlerName, initialState, { ...options, queued: true });
  }

  private getQueueKey(jobHandlerName: string, jobName: string): string {
    return JSON.stringify([jobHandlerName, jobName]);
  }

  private getQueueMutex(jobHandlerName: string, jobName: string): Mutex {
    const queueKey = this.getQueueKey(jobHandlerName, jobName);
    let mutex = this.jobQueueMutexes[queueKey];
    if (!mutex) {
      mutex = new Mutex();
      this.jobQueueMutexes[queueKey] = mutex;
    }
    return mutex;
  }

  private async listJobsByStatus(
    jobHandlerName: string,
    status: JobStatus,
    jobName?: string,
    limit: number | null = null,
  ): Promise<Record<string, any>[]> {
    const filters = [
      Filters.EQ(this.options.jobHandlerField, jobHandlerName),
      Filters.EQ(this.options.statusField, status),
    ];
    if (jobName !== undefined) {
      filters.push(Filters.EQ(this.options.nameField, jobName));
    }
    return this.adminforth.resource(this.getResourceId()).list(
      Filters.AND(...filters),
      limit,
      0,
      Sorts.ASC(this.options.createdAtField),
    );
  }

  /**
   * Number of jobs in the given queue which are currently occupying a concurrency slot.
   * Uses the database as the source of truth so it stays correct after an application restart.
   */
  private async getRunningJobsCount(jobHandlerName: string, jobName: string): Promise<number> {
    const runningJobs = await this.listJobsByStatus(jobHandlerName, 'IN_PROGRESS', jobName);
    return runningJobs.length;
  }

  /**
   * All job names of the given handler which currently have at least one queued job.
   */
  private async getQueuedJobNames(jobHandlerName: string): Promise<string[]> {
    const queuedJobs = await this.listJobsByStatus(jobHandlerName, 'QUEUED');
    return Array.from(new Set<string>(queuedJobs.map((job) => job[this.options.nameField])));
  }

  public async startNextQueuedJob(jobHandlerName: string, jobName: string): Promise<string | null> {
    return this.getQueueMutex(jobHandlerName, jobName).runExclusive(async () => {
      const jobRunContext = this.buildJobRunContext(jobHandlerName, jobName);
      if (!jobRunContext) {
        afLogger.error(`No handler registered for jobHandler ${jobHandlerName}. Cannot start queued jobs for this jobHandler.`);
        return null;
      }

      const concurrencyLimit = this.jobConcurrencyLimits[jobHandlerName] || DEFAULT_CONCURRENCY_LIMIT;
      const runningJobsCount = await this.getRunningJobsCount(jobHandlerName, jobName);
      if (runningJobsCount >= concurrencyLimit) {
        return null;
      }

      const [oldestQueuedJob] = await this.listJobsByStatus(jobHandlerName, 'QUEUED', jobName, 1);
      if (!oldestQueuedJob) {
        return null;
      }

      const jobId = oldestQueuedJob[this.getResourcePk()];
      const updateResult = await this.adminforth.resource(this.getResourceId()).update(jobId, {
        [this.options.statusField]: 'IN_PROGRESS',
      });
      if (updateResult?.ok === false) {
        afLogger.error(`Failed to start queued job ${jobId}: ${updateResult.error}`);
        return null;
      }

      this.adminforth.websocket.publish('/background-jobs-job-update', {
        jobId,
        status: 'IN_PROGRESS',
        name: oldestQueuedJob[this.options.nameField],
        progress: oldestQueuedJob[this.options.progressField],
        createdAt: oldestQueuedJob[this.options.createdAtField],
        customComponent: this.jobCustomComponents[jobHandlerName],
      });

      // not awaited on purpose: processing runs until the whole job is finished, while the queue mutex
      // only has to cover taking the slot
      this.runProcessingJobTasksFromStorage(oldestQueuedJob, jobRunContext).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        afLogger.error(`Error while processing tasks of job ${jobId}: ${errorMessage}`);
      });

      return jobId;
    });
  }


  public async startQueuedJobs(jobHandlerName: string, jobName?: string): Promise<string[]> {
    const jobNamesToStart = jobName !== undefined ? [jobName] : await this.getQueuedJobNames(jobHandlerName);
    const startedJobIds: string[] = [];
    for (const queuedJobName of jobNamesToStart) {
      while (true) {
        const startedJobId = await this.startNextQueuedJob(jobHandlerName, queuedJobName);
        if (!startedJobId) {
          break;
        }
        startedJobIds.push(startedJobId);
      }
    }
    return startedJobIds;
  }

  private async startQueuedJobsSafely(jobHandlerName: string, jobName?: string) {
    if (!jobHandlerName) {
      return;
    }
    try {
      await this.startQueuedJobs(jobHandlerName, jobName);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      afLogger.error(`Failed to start queued jobs for jobHandler ${jobHandlerName}: ${errorMessage}`);
    }
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
    if (jobStatus !== 'IN_PROGRESS' && jobStatus !== 'QUEUED') {
      throw new Error(`Cannot add tasks to a job with status ${jobStatus}. Only jobs with status IN_PROGRESS or QUEUED can be added new tasks.`);
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
    if (jobStatus !== 'IN_PROGRESS' && jobStatus !== 'QUEUED') {
      throw new Error(`Cannot delete tasks from a job with status ${jobStatus}. Only jobs with status IN_PROGRESS or QUEUED can have tasks deleted.`);
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

  private buildTasksToReprocess(tasks: taskType[], unfinishedTasks: taskType[]): taskType[] {
    const skippedTasks = tasks.map((task) => ({ ...task, skip: true, state: task.state || {} }));
    return [...skippedTasks, ...unfinishedTasks];
  }

  private async runProcessingTasks(
    tasks: taskType[],
    jobLevelDb: Level,
    jobId: string,
    jobRunContext: jobRunContext,
    finishAttemptNumber = 0,
  ) {
    const { jobHandlerName, jobName, handleTask, parrallelLimit, onAllTasksDone, beforeJobFinish } = jobRunContext;
    let totalTasks = tasks.length;
    let completedTasks = 0;
    let lastJobStatus = 'IN_PROGRESS';

    const progressMutex = new Mutex();
    const finishTask = (wasTaskSkipped: boolean = false) => progressMutex.runExclusive(async () => {
      completedTasks = await this.handleFinishTask(completedTasks, totalTasks, jobId, wasTaskSkipped);
    });

    const taskHandler = async ( taskIndex: number, task: taskType ) => {
      totalTasks = await this.getTotalTasksInLevelDb(jobLevelDb);
      if (task.skip) {
        await finishTask(true);
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
        // persist the error inside the task state so it is returned when tasks are fetched later
        const taskState = await this.getLevelDbTaskStateField(jobLevelDb, taskIndex.toString());
        await this.setLevelDbTaskStateField(jobLevelDb, taskIndex.toString(), { ...taskState, error: errorMessage });
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'FAILED');
        this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "FAILED", error: errorMessage });
        return;
      } finally {
        //Update progress
        const currentJobStatus = await this.getLastJobStatus(jobId);
        if (currentJobStatus === 'CANCELLED') {
          lastJobStatus = currentJobStatus;
          afLogger.debug(`Job ${jobId} was cancelled during processing of task ${taskIndex}. Progress will not be updated.`);
          return;
        }

        await finishTask();
      }
    }

    const limit = pLimit(parrallelLimit);
    const tasksToExecute = tasks.map((task, taskIndex) => {
      return limit(() => taskHandler(taskIndex, task));
    });

    await Promise.all(tasksToExecute);
    if (lastJobStatus === 'CANCELLED') {
      this.cleanupJobMutexIfTerminalStatus(jobId, 'CANCELLED');
      await this.startQueuedJobsSafely(jobHandlerName, jobName);
      return;
    }
    const jobStatusAfterExecution = await this.getLastJobStatus(jobId);
    if (jobStatusAfterExecution === 'CANCELLED') {
      this.cleanupJobMutexIfTerminalStatus(jobId, 'CANCELLED');
      await this.startQueuedJobsSafely(jobHandlerName, jobName);
      return;
    }

    const unfinishedTasks = await this.getUnfinishedTasksFromLevelDb(jobLevelDb);
    if (unfinishedTasks.length > 0) {
      const tasksToReprocess = this.buildTasksToReprocess(tasks, unfinishedTasks);
      await this.runProcessingTasks(tasksToReprocess, jobLevelDb, jobId, jobRunContext, finishAttemptNumber);
    } else {
      const nextFinishAttemptNumber = finishAttemptNumber + 1;
      await this.triggerBeforeJobFinish(beforeJobFinish, jobLevelDb, jobId, nextFinishAttemptNumber);

      const currentJobStatusAfterFinishCallback = await this.getLastJobStatus(jobId);
      if (currentJobStatusAfterFinishCallback === 'CANCELLED') {
        this.cleanupJobMutexIfTerminalStatus(jobId, 'CANCELLED');
        await this.startQueuedJobsSafely(jobHandlerName, jobName);
        return;
      }

      const unfinishedTasksAfterFinishCallback = await this.getUnfinishedTasksFromLevelDb(jobLevelDb);
      if (unfinishedTasksAfterFinishCallback.length > 0) {
        const tasksToReprocess = this.buildTasksToReprocess(tasks, unfinishedTasksAfterFinishCallback);
        await this.runProcessingTasks(tasksToReprocess, jobLevelDb, jobId, jobRunContext, nextFinishAttemptNumber);
        return;
      }

      const allTasksDoneStatus = await this.getAllTasksDoneStatus(jobLevelDb);
      if (allTasksDoneStatus.failedTasks === 0) {
        await this.adminforth.resource(this.getResourceId()).update(jobId, {
          [this.options.statusField]: 'DONE',
          [this.options.finishedAtField]: (new Date()).toISOString(),
        })
        this.adminforth.websocket.publish('/background-jobs-job-update', { jobId, status: 'DONE', finishedAt: (new Date()).toISOString() });
        this.cleanupJobMutexIfTerminalStatus(jobId, 'DONE');
        await this.triggerOnAllTasksDone(onAllTasksDone, jobLevelDb, jobId);
      } else {
        await this.adminforth.resource(this.getResourceId()).update(jobId, {
          [this.options.statusField]: 'DONE_WITH_ERRORS',
          [this.options.finishedAtField]: (new Date()).toISOString(),
        })
        const jobError = await this.getJobStateField(jobId, 'error');
        this.adminforth.websocket.publish('/background-jobs-job-update', { jobId, status: 'DONE_WITH_ERRORS', finishedAt: (new Date()).toISOString(), error: jobError });
        this.cleanupJobMutexIfTerminalStatus(jobId, 'DONE_WITH_ERRORS');
        await this.triggerOnAllTasksDone(onAllTasksDone, jobLevelDb, jobId);
      }
      await this.startQueuedJobsSafely(jobHandlerName, jobName);
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


  private async runProcessingJobTasksFromStorage(
    job: Record<string, any>,
    knownJobRunContext?: jobRunContext,
  ) {
    const jobId = job[this.getResourcePk()];
    const jobLevelDb = await this.getLevelDbForTheJob(jobId);
    const jobHandlerName = job[this.options.jobHandlerField];
    const jobRunContext = knownJobRunContext || this.buildJobRunContext(jobHandlerName, job[this.options.nameField]);
    if (!jobRunContext) {
      afLogger.error(`No handler registered for jobHandler ${jobHandlerName}. Cannot process unfinished tasks for job ${jobId}.`);
      return;
    }
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
        afLogger.error(`Error parsing task data for task ${taskIndex} of job ${jobId}: ${error}`);
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
    await this.runProcessingTasks(unfinishedTasks, jobLevelDb, jobId, jobRunContext);

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
      this.runProcessingJobTasksFromStorage(job);
    }

    // resumed jobs above are already IN_PROGRESS in the database, so they are counted as occupying a
    // concurrency slot and queued jobs are started only for queues which still have a free one
    const queuedJobs = await this.adminforth.resource(resourceId).list(Filters.EQ(this.options.statusField, 'QUEUED'));
    const queuedJobHandlerNames = new Set<string>(queuedJobs.map((job) => job[this.options.jobHandlerField]));
    for (const jobHandlerName of queuedJobHandlerNames) {
      afLogger.info(`Starting queued jobs for jobHandler ${jobHandlerName} on startup.`);
      // without a job name every queue of the handler is drained
      await this.startQueuedJobsSafely(jobHandlerName);
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
      request_schema: jobIdBodySchema,
      handler: async ({ adminUser, body }) => {
        const data = body as z.infer<typeof jobIdBodySchema>;
        const jobId = data.jobId;

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
      request_schema: jobIdBodySchema,
      handler: async ({ body }) => {
        const data = body as z.infer<typeof jobIdBodySchema>;
        const jobId = data.jobId;
        const currentJob = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
        if (!currentJob) {
          return { ok: false, message: `Job with id ${jobId} not found.` };
        }
        const oldStatus = currentJob[this.options.statusField];
        if (TERMINAL_JOB_STATUSES.includes(oldStatus)) {
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
          // a cancelled job frees its concurrency slot, so the next job queued under the same
          // handler and job name can start
          await this.startQueuedJobsSafely(
            currentJob[this.options.jobHandlerField],
            currentJob[this.options.nameField],
          );
          return { ok: true };
        } catch (error) {
          return { ok: false, message: `Failed to cancel job with id ${jobId}.` };
        }
      }
    });

    server.endpoint({
      method: 'POST',
      path: `/plugin/${this.pluginInstanceId}/get-tasks`,
      request_schema: getTasksBodySchema,
      handler: async ({ body }) => {
        const data = body as z.infer<typeof getTasksBodySchema>;
        const { jobId, limit, offset, fieldsToReturn } = data;
        const jobLevelDb: Level = await this.getLevelDbForTheJob(jobId as string);
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
          if (fieldsToReturn && fieldsToReturn.length > 0) {
            const filteredState: Record<string, any> = {};
            for (const field of fieldsToReturn) {
              filteredState[field] = parsedTaskData.state[field];
            }
            parsedTaskData.state = filteredState;
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
