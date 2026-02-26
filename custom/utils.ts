export interface IJob {
  id: string;
  name: string;
  status: 'IN_PROGRESS' | 'DONE' | 'DONE_WITH_ERRORS' | 'CANCELED';
  progress: number; // 0 to 100
  createdAt: Date;
}