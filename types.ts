
export interface PluginOptions {
  createdAtField: string; 
  finishedAtField: string;
  startedByField: string;
  stateField: string;
  progressField: string;
  statusField: string;
  nameField: string;
  jobHandlerField: string;

  /**
   * Path to the level db folder. If not provided, a default path is ./background-jobs-dbs/
   */
  levelDbPath?: string; 
}
