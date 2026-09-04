import type { AdminForthComponentDeclarationFull } from "adminforth";
import { callAdminForthApi } from "@/utils";
import { useAdminforth } from "@/adminforth";

export interface IJob {
  id: string;
  name: string;
  status: 'QUEUED' | 'IN_PROGRESS' | 'DONE' | 'DONE_WITH_ERRORS' | 'CANCELLED';
  state: Record<string, any>;
  progress: string; // 0 to 100
  createdAt: Date;
  finishedAt?: Date;
  customComponent?: AdminForthComponentDeclarationFull; 
}

export const CANCELLABLE_JOB_STATUSES: IJob['status'][] = ['QUEUED', 'IN_PROGRESS'];

export function isJobCancellable(job: IJob): boolean {
  return CANCELLABLE_JOB_STATUSES.includes(job.status);
}

// shared by the jobs list row and the job info popup, both of which can cancel a job
export async function cancelJobById(
  { jobId, pluginInstanceId, t }: { jobId: string; pluginInstanceId: string; t: (key: string) => string },
): Promise<boolean> {
  const adminforth = useAdminforth();
  const isConfirmed = await adminforth.confirm({ message: t('Are you sure you want to cancel this job?') });
  if (!isConfirmed) {
    return false;
  }
  const failedToCancelText = t('Failed to cancel job');
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${pluginInstanceId}/cancel-job`,
      method: 'POST',
      body: { jobId },
    });
    if (res?.ok) {
      adminforth.alert({ message: t('Job cancelled successfully'), variant: 'success' });
      return true;
    }
    adminforth.alert({ message: res?.message || failedToCancelText, variant: 'danger' });
  } catch (error) {
    adminforth.alert({ message: failedToCancelText, variant: 'danger' });
    console.error('Error canceling job:', error);
  }
  return false;
}
