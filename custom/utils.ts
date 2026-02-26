export interface IJob {
  id: string;
  name: string;
  status: 'IN_PROGRESS' | 'DONE' | 'CANCELED';
  progress: number; // 0 to 100
  createdAt: Date;
}