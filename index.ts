import { AdminForthPlugin, Filters } from "adminforth";
import type { IAdminForth, IHttpServer, AdminForthResourcePages, AdminForthResourceColumn, AdminForthDataTypes, AdminForthResource, AdminUser } from "adminforth";
import type { PluginOptions } from './types.js';
import { afLogger } from "adminforth";
import pLimit from 'p-limit';
import { Level } from 'level';
import { resolve } from "node:dns";
import { set } from "@vueuse/core";

type JobStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
type setStateFieldParams = (state: Record<string, any>) => void;
type getStateFieldParams = () => any;

export default class  extends AdminForthPlugin {
  options: PluginOptions;

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

  private async setLevelDbTaskStatusField(levelDb: Level, taskId: string, status: JobStatus) {
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

  private async getLevelDbTaskStatusField(levelDb: Level, taskId: string): Promise<JobStatus> {
    const state = await levelDb.get(taskId);
    if (state) {
      const parsedState = JSON.parse(state);
      return parsedState.status;
    }
    return Promise.resolve(null);
  }
  


  public async startNewJob(
    jobName: string,
    adminUser: AdminUser,
    tasks: {state: Record<string, any>}[],
    parrallelLimit: number = 3,
    initialFields: Record<string, any> = {},
    handleTask: ( { setTaskStateField, getTaskStateField }: { setTaskStateField: setStateFieldParams; getTaskStateField: getStateFieldParams } ) => Promise<void>,
    pathToComponentToRenderState?: string
  ) {

    //create a record for the job in the database with status in progress
    const objectToSave = {
      [this.options.nameField]: jobName,
      [this.options.startedByField]: adminUser.pk,
      [this.options.stateField]: JSON.stringify(initialFields),
      [this.options.progressField]: 0,
      [this.options.statusField]: 'IN_PROGRESS',
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
    });

    //create a level db instance for the job with name as jobId
    const jobLevelDb = new Level(`${this.options.levelDbPath || './background-jobs-dbs/'}job_${jobId}`, { valueEncoding: 'json' });

    const limit2 = pLimit(parrallelLimit);
    const createTaskRecordsPromises = tasks.map((task, index) => {
      return limit2(() => this.createLevelDbTaskRecord(jobLevelDb, index.toString(), task.state));
    });

    await Promise.all(createTaskRecordsPromises);


    const totalTasks = tasks.length;
    let completedTasks = 0;

    const taskHandler = async ( taskIndex: number, taskState ) => {

      //define the setTaskStateField and getTaskStateField functions to pass to the task
      const setTaskStateField = async (state: Record<string, any>) => {
        await this.setLevelDbTaskStateField(jobLevelDb, taskIndex.toString(), state);
      }
      const getTaskStateField = async () => {
        return await this.getLevelDbTaskStateField(jobLevelDb, taskIndex.toString());
      }

      await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'IN_PROGRESS');

      //handling the task 
      try {
        await handleTask({ setTaskStateField, getTaskStateField });

        //Set task status to completed in level db
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'DONE');
      } catch (error) {
        afLogger.error(`Error in handling task ${taskIndex} of job ${jobId}: ${error}`, );
        await this.setLevelDbTaskStatusField(jobLevelDb, taskIndex.toString(), 'FAILED');
        return;
      } finally {
        //Update progress
        completedTasks++;
        const progress = Math.round((completedTasks / totalTasks) * 100);
        await this.adminforth.resource(this.getResourceId()).update(jobId, {
          [this.options.progressField]: progress,
        })
        this.adminforth.websocket.publish('/background-jobs', { jobId, progress });
      }
    }

    const limit = pLimit(parrallelLimit);
    const tasksToExecute = tasks.map((task, taskIndex) => {
      return limit(() => taskHandler(taskIndex, task.state));
    });

    await Promise.all(tasksToExecute);

    await this.adminforth.resource(this.getResourceId()).update(jobId, {
      [this.options.statusField]: 'DONE',
    })
    this.adminforth.websocket.publish('/background-jobs', { jobId, status: 'DONE' });
  }

  private async runProcessingUnfinishedTasks(
    tasks: {state: Record<string, any>}[],
    parrallelLimit: number,
    handleTask: ( { setTaskStateField, getTaskStateField }: { setTaskStateField: setStateFieldParams; getTaskStateField: getStateFieldParams } ) => Promise<void>,
  ) {

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

    console.log('Unprocessed jobs found on startup:', unprocessedJobs);
  }

  
  async validateConfigAfterDiscover(adminforth: IAdminForth, resourceConfig: AdminForthResource) {
    // optional method where you can safely check field types after database discovery was performed
    this.checkIfFieldInResource(resourceConfig, this.options.createdAtField, 'createdAtField');
    this.checkIfFieldInResource(resourceConfig, this.options.startedByField, 'startedByField');
    this.checkIfFieldInResource(resourceConfig, this.options.stateField, 'stateField');
    this.checkIfFieldInResource(resourceConfig, this.options.progressField, 'progressField');
    this.checkIfFieldInResource(resourceConfig, this.options.statusField, 'statusField');
    this.checkIfFieldInResource(resourceConfig, this.options.nameField, 'nameField');


    //Add temp delay to make sure, that all resources active. Probably should be fixed
    // await new Promise(resolve => setTimeout(resolve, 1000));
    // this.processAllUnfinishedJobs();
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
        const listOfJobs = await this.adminforth.resource(this.resourceConfig.resourceId).list(Filters.EQ(startedByField, user.pk));
        
        const jobsToReturn = listOfJobs.map(job => {
          return {
            id: job[resourcePk],
            name: job[this.options.nameField],
            createdAt: job[this.options.createdAtField],
            status: job[this.options.statusField],
            progress: job[this.options.progressField],
          }
        });
        return { jobs: jobsToReturn };
      }
    });
  }

}