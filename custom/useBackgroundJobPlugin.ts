import { ref } from 'vue';
import { callAdminForthApi } from '@/utils';
import { useAdminforth } from '@/adminforth';
import { defineStore } from 'pinia'

export const useJobInfoStore = defineStore('jobInfo', () => {
  const currentJob = ref<any>(null);
  const isOpened = ref(false);
  const adminforth = useAdminforth();

  async function openJobInfoPopup(jobId: string) {
    if (!jobId) return null;
    try {
      const res = await callAdminForthApi({
        path: `/plugin/get-background-job-info`,
        method: 'POST',
        body: { jobId },
      });

      if (res && res.ok) {
        currentJob.value = res.job;
        isOpened.value = true;
        return res.job;
      } else {
        adminforth.alert({ variant: 'danger', message: res?.message || 'Failed to load job info' });
        return null;
      }
    } catch (e) {
      console.error('OpenJobInfoPopup error', e);
      adminforth.alert({ variant: 'danger', message: 'Failed to load job info' });
      return null;
    }
  }

  function setIsOpened(value: boolean) {
    isOpened.value = value;
  }

  function clearCurrentJob() {
    currentJob.value = null;
  }

  function updateCurrentJob(jobData: any) {
    currentJob.value = { ...currentJob.value, ...jobData };
  }

  return {
    currentJob,
    isOpened,
    openJobInfoPopup,
    setIsOpened,
    clearCurrentJob,
    updateCurrentJob
  };
});