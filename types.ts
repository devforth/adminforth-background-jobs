
export interface PluginOptions {
  createdAtField: string; 
  startedByField: string;
  stateField: string;
  progressField: string;
  statusField: string;
  nameField?: string;

  /**
   * Path to the level db folder. If not provided, a default path is ./background-jobs-dbs/
   */
  levelDbPath?: string; 
}
