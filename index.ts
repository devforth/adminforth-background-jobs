import { AdminForthPlugin, Filters, Sorts } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResourcePages, AdminForthResourceColumn, AdminForthDataTypes, AdminForthResource, AdminUser, AdminForthComponentDeclarationFull } from "adminforth";
import type { PluginOptions } from './types.js';
import { afLogger } from "adminforth";
import pLimit from 'p-limit';
import { Level } from 'level';
import fs from 'fs/promises';

type TaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
type setStateFieldParams = (state: Record<string, any>) => void;
type getStateFieldParams = () => any;
type taskHandlerType = ( { setTaskStateField, getTaskStateField }: { setTaskStateField: setStateFieldParams; getTaskStateField: getStateFieldParams } ) => Promise<void>;
type taskType = {
  skip?: boolean;
  state: Record<string, any>;
}

export default class BackgroundJobsPlugin extends AdminForthPlugin {
  options: PluginOptions;
  private taskHandlers: Record<string, taskHandlerType> = {};
  private jobCustomComponents: Record<string, AdminForthComponentDeclarationFull> = {};
  private jobParallelLimits: Record<string, number> = {};
  private levelDbInstances: Record<string, Level> = {};

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
    console.log('Modifying resource config for Background Jobs Plugin');
    if (!adminforth.config.customization?.globalInjections?.header) {
      adminforth.config.customization.globalInjections.header = [];
    }
    (adminforth.config.customization.globalInjections.header).push({
      file: this.componentPath('NavbarJobs.vue'),
      meta: {
        pluginInstanceId: this.pluginInstanceId,
      }
    });

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

      //delete level db folder for the job
      await fs.rm(levelDbPath, {
        recursive: true,
        force: true,
      });

      return {ok: true};
    })
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
  
  public registerTaskHandler({ jobHandlerName, handler, parallelLimit = 3,
  }:{jobHandlerName: string, handler: taskHandlerType, parallelLimit?: number}) {
    //register the handler in a map with jobHandlerName as key and handler as value
    this.taskHandlers[jobHandlerName] = handler;
    this.jobParallelLimits[jobHandlerName] = parallelLimit;
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
  ) {

    const handleTask: taskHandlerType = this.taskHandlers[jobHandlerName];
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
    }

    const creationResult = await this.adminforth.resource(this.getResourceId()).create(objectToSave);
    let createdRecord: Record<string, any> = null;
    if (creationResult.ok === true ) {
      createdRecord = creationResult.createdRecord;
    } else {
      throw new Error(`Failed to create a record for the job. Error: ${creationResult.error}`);
    }    
    const jobId = createdRecord[this.getResourcePk()];
    
    this.adminforth.websocket.publish('/background-jobs', { 
      jobId, 
      status: 'IN_PROGRESS', 
      name: jobName,
      progress: 0,
      createdAt: createdRecord[this.options.createdAtField],
      customComponent,
    });

    //create a level db instance for the job with name as jobId
    const jobLevelDb = new Level(`${this.options.levelDbPath || './background-jobs-dbs/'}job_${jobId}`, { valueEncoding: 'json' });
    this.levelDbInstances[jobId] = jobLevelDb;

    const limit2 = pLimit(parrallelLimit);
    const createTaskRecordsPromises = tasks.map((task, index) => {
      return limit2(() => this.createLevelDbTaskRecord(jobLevelDb, index.toString(), task.state));
    });

    await Promise.all(createTaskRecordsPromises);

    this.runProcessingTasks(tasks, jobLevelDb, jobId, handleTask, parrallelLimit);
  }

  private async runProcessingTasks(
    tasks: taskType[],
    jobLevelDb: Level,
    jobId: string,
    handleTask: taskHandlerType,
    parrallelLimit: number,
  ) {
    const totalTasks = tasks.length;
    let completedTasks = 0;
    let failedTasks = 0;
    let lastJobStatus = 'IN_PROGRESS';

    const taskHandler = async ( taskIndex: number, task ) => {
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

      //define the setTaskStateField and getTaskStateField functions to pass to the task
      const setTaskStateField = async (state: Record<string, any>) => {
        this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, state });
        await this.setLevelDbTaskStateField(jobLevelDb, taskIndex.toString(), state);
      }
      const getTaskStateField = async () => {
        return await this.getLevelDbTaskStateField(jobLevelDb, taskIndex.toString());
      }

      await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'IN_PROGRESS');
      this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "IN_PROGRESS" });

      //handling the task 
      try {
        await handleTask({ setTaskStateField, getTaskStateField });

        //Set task status to completed in level db
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'DONE');
        this.adminforth.websocket.publish(`/background-jobs-task-update/${jobId}`, { taskIndex, status: "DONE" });
      } catch (error) {
        afLogger.error(`Error in handling task ${taskIndex} of job ${jobId}: ${error}`, );
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
    if (lastJobStatus !== 'CANCELLED' && failedTasks === 0) {
      await this.adminforth.resource(this.getResourceId()).update(jobId, {
        [this.options.statusField]: 'DONE',
        [this.options.finishedAtField]: (new Date()).toISOString(),
      })
      this.adminforth.websocket.publish('/background-jobs', { jobId, status: 'DONE' });
    } else if (failedTasks > 0) {
      await this.adminforth.resource(this.getResourceId()).update(jobId, {
        [this.options.statusField]: 'DONE_WITH_ERRORS',
        [this.options.finishedAtField]: (new Date()).toISOString(),
      })
      this.adminforth.websocket.publish('/background-jobs', { jobId, status: 'DONE_WITH_ERRORS' });
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
    this.adminforth.websocket.publish('/background-jobs', { jobId, progress });
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
    await this.runProcessingTasks(unfinishedTasks, jobLevelDb, job[this.getResourcePk()], handleTask, parrallelLimit);

  }

  public async setJobField(jobId: string, key: string, value: any) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const state = jobRecord[this.options.stateField];
    const parsedState = JSON.parse(state);
    parsedState[key] = value;
    await this.adminforth.resource(this.getResourceId()).update(jobId, {
      [this.options.stateField]: JSON.stringify(parsedState),
    });
  }

  public async getJobField(jobId: string, key: string) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const state = jobRecord[this.options.stateField];
    const parsedState = JSON.parse(state);
    return parsedState[key];
  }

  public async getJobState(jobId: string) {
    const jobRecord = await this.adminforth.resource(this.getResourceId()).get(Filters.EQ(this.getResourcePk(), jobId));
    const state = jobRecord[this.options.stateField];
    return JSON.parse(state);
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
          this.adminforth.websocket.publish('/background-jobs', { 
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
        const levelDbPath = `${this.options.levelDbPath || './background-jobs-dbs/'}job_${jobId}`;
        let jobLevelDb: Level;
        if (this.levelDbInstances[jobId]) {
          jobLevelDb = this.levelDbInstances[jobId];
        } else {
          try {
            jobLevelDb = new Level(levelDbPath, { valueEncoding: 'json' });
            this.levelDbInstances[jobId] = jobLevelDb;
          } catch (error) {
            return { ok: false, message: `Failed to access tasks for job with id ${jobId}.` };
          }
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
        return { ok: true, tasks };
      }
    });
  }

}