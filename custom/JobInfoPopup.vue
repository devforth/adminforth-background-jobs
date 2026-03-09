<template> 
    <div class="flex flex-col w-full min-w-96 mt-2">
      <div class="flex items-center mb-1">
        <div class="flex flex-col items-start justify-end h-12">
          <h2 class="text-lg font-semibold dark:text-white">{{ job.name }}</h2>
          <Tooltip>
            <p class="text-xs text-gray-600 dark:text-gray-200 h-full">{{ t('Created:') }} {{ getTimeAgoString(new Date(job.createdAt)) }}</p>
            <template #tooltip>
              {{ t('Created at:') }} {{ new Date(job.createdAt).toLocaleString() }}
            </template>
          </Tooltip>
        </div>
        <div class="ml-auto flex flex-col items-start justify-end h-12">
          <div class="flex items-center mr-6">
            <p class=" text-gray-800 dark:text-white h-full"> {{  t('Progress:')  }} <span class="font-semibold" >{{ job.progress }}%</span></p>
            <StateToIcon :job="job" />
            <button
              @click="closeModal()"
              type="button"
              class="absolute top-2 right-2 text-lightDialogCloseButton bg-transparent hover:bg-lightDialogCloseButtonHoverBackground hover:text-lightDialogCloseButtonHover rounded-lg text-sm w-8 h-8 ms-auto inline-flex justify-center items-center dark:text-darkDialogCloseButton dark:hover:bg-darkDialogCloseButtonHoverBackground dark:hover:text-darkDialogCloseButtonHover"
            >
              <svg class="w-3 h-3" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14">
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6"/>
              </svg>
              <span class="sr-only">{{ t('Close Modal') }}</span>
            </button>
          </div>
          <Tooltip v-if="job.finishedAt">
             <p class="text-xs text-gray-600 dark:text-gray-200 h-full"> {{ t('Finished:') }} {{ getTimeAgoString(new Date(job.finishedAt)) }}</p>
            <template #tooltip>
              {{ t('Finished at:') }} {{ new Date(job.finishedAt).toLocaleString() }}
            </template>
          </Tooltip>
        </div>
      </div>
      <div class="flex items-center gap-4 w-full mt-4">
        <ProgressBar 
          :current-value="job.progress" 
          :max-value="100" 
          :min-value="0"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
          :height="6"
        />
        <Button class="h-8" v-if="job.status === 'IN_PROGRESS'" @click="cancelJob"> {{ t('Cancel') }} </Button>
      </div>
    </div>
    <component 
      v-if="job.customComponent"
      class="mt-4" 
      :is="getCustomComponent(job.customComponent)" 
      :meta="job.customComponent"
      :getJobTasks="getJobTasks"
      :job="job"
    />
</template>




<script setup lang="ts">
import type { IJob } from './utils';
import { ProgressBar, Button, Tooltip } from '@/afcl';
import { getTimeAgoString, callAdminForthApi, getCustomComponent} from '@/utils';
import { useI18n } from 'vue-i18n';
import StateToIcon from './StateToIcon.vue';
import { useAdminforth } from '@/adminforth';


const { t } = useI18n();

const adminforth = useAdminforth();

const props = defineProps<{
  job: IJob;
  meta: {
    pluginInstanceId: string;
  };
  closeModal: () => void;
}>();

async function cancelJob() {
  // Implement job cancellation logic here
  const isConfirmed = await adminforth.confirm({ message: t('Are you sure you want to cancel this job?') });
  if (!isConfirmed) {
    return;
  }
  const failedToCancelText = t('Failed to cancel job');
  console.log(`Canceling job with ID: ${props.job.id}`);
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/cancel-job`,
      method: 'POST',
      body: {
        jobId: props.job.id,
      },
    });
    if (res.ok) {
      adminforth.alert({ message: t('Job cancelled successfully'), variant: 'success' });
    } else {
      adminforth.alert({ message: failedToCancelText, variant: 'danger' });
    }
  } catch (error) {
    adminforth.alert({ message: failedToCancelText, variant: 'danger' });
    console.error('Error canceling job:', error);
  }
}



async function getJobTasks(limit: number = 10, offset: number = 0): Promise<{state: Record<string, any>, status: string}[]> {
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/get-tasks`,
      method: 'POST',
      body: {
        jobId: props.job.id,
        limit,
        offset,
      },
    });
    if (res.ok) {
      return res.data;
    } else {
      console.error('Error fetching job tasks:', res.error);
      return [];
    }
  } catch (error) {
    console.error('Error fetching job tasks:', error);
    return [];
  }
}



</script>